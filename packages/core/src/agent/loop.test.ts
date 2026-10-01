import { describe, expect, it, vi } from "vitest";
import { AgentLoop, type AgentRunResult } from "./loop.js";
import { AgentEventBus, type AgentEvent } from "./events.js";
import { ApprovalBroker } from "./approval.js";
import { PermissionGate } from "../permissions/gate.js";
import { ToolRegistry } from "../tools/registry.js";
import { ProviderError, type ProviderErrorKind } from "../providers/errors.js";
import type { Provider, ModelRequest, StreamEvent } from "../models/provider.js";
import { SettingsSchema } from "../settings/schema.js";
import { EMPTY_USAGE, type FinishReason } from "../models/types.js";
import type { TurnCostReview, TurnSpend } from "../models/free-policy.js";
import { describePlatform, type PlatformInfo } from "../platform/platform.js";

const linux: PlatformInfo = describePlatform("linux", "x86_64", "Arch Linux");

/**
 * A provider that fails for a chosen set of models, so the fallback path can be
 * driven deterministically. Records every model it was asked for, in order.
 */
function scriptedProvider(options: {
  readonly failModels?: readonly string[];
  readonly failAll?: boolean;
  readonly kind?: ProviderErrorKind;
}): { provider: Provider; attempts: string[] } {
  const attempts: string[] = [];
  const failModels = new Set(options.failModels ?? []);
  const provider: Provider = {
    id: "zen",
    name: "Test",
    baseUrl: "http://test.invalid/v1",
    async listModels() {
      return { models: [], fetchedAt: 0, source: "fallback" };
    },
    async complete() {
      return { message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, usage: EMPTY_USAGE };
    },
    async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
      attempts.push(request.model);
      if (options.failAll || failModels.has(request.model)) {
        throw new ProviderError(options.kind ?? "rate-limit", "test", "nope");
      }
      yield { type: "text", text: "ok" } as StreamEvent;
      yield { type: "done", usage: EMPTY_USAGE } as StreamEvent;
    },
    supportsModel() {
      return true;
    },
  };
  return { provider, attempts };
}

interface Scenario {
  readonly primaryModel: string;
  readonly failModels?: readonly string[];
  readonly failAll?: boolean;
  readonly kind?: ProviderErrorKind;
  readonly fallbackModels?: readonly string[] | readonly FallbackModel[];
  readonly allowModelFallback?: boolean;
  /** Models the host already knows are unusable, as the provider would. */
  readonly blockedModels?: readonly string[];
  /**
   * Extra providers, for a fallback that has to change provider.
   *
   * Each gets its own attempt log, which is how the tests tell "switched model"
   * from "switched provider": an attempt recorded on the second provider's log
   * could only have happened if the loop routed it there.
   */
  readonly extraProviders?: readonly {
    readonly id: string;
    readonly label: string;
    /** Make this provider refuse too, for a cap test across providers. */
    readonly fail?: boolean;
  }[];
}

async function runOnce(scenario: Scenario) {
  const { provider, attempts } = scriptedProvider({
    ...(scenario.failModels ? { failModels: scenario.failModels } : {}),
    ...(scenario.failAll !== undefined ? { failAll: scenario.failAll } : {}),
    ...(scenario.kind ? { kind: scenario.kind } : {}),
  });
  const events = new AgentEventBus();
  const seen: AgentEvent[] = [];
  events.subscribe((event) => seen.push(event));

  const blocked = new Set(scenario.blockedModels ?? []);
  // Built by hand rather than reusing `scriptedProvider`, because these exist to
  // answer, not to fail, and each keeps its own log.
  const routed: Record<string, string[]> = { [provider.id]: attempts };
  const providers = [
    provider,
    ...(scenario.extraProviders ?? []).map((definition) => {
      const log: string[] = [];
      routed[definition.id] = log;
      return {
        id: definition.id,
        name: definition.label,
        async complete() {
          return { message: { role: "assistant" as const, content: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
        },
        async *stream(request: { model: string }) {
          log.push(request.model);
          if (definition.fail) {
            throw new ProviderError("rate-limit", "test", "nope");
          }
          yield { type: "text-delta" as const, text: "from " + definition.label };
          yield { type: "done" as const, usage: EMPTY_USAGE };
        },
        supportsModel() {
          return true;
        },
      };
    }),
  ];
  const loop = new AgentLoop({
    provider,
    ...(providers.length > 1 ? { providers } : {}),
    registry: new ToolRegistry(),
    gate: new PermissionGate(() => SettingsSchema.parse({}), { platform: "linux" }),
    events,
    approval: new ApprovalBroker(),
    ...(scenario.blockedModels
      ? {
          isModelUsable: (modelId: string) => !blocked.has(modelId),
        }
      : {}),
  });

  // `run` never rejects: a provider error becomes a `run-error` event and an
  // `error` reason, so callers have one path for a finished run.
  const result = await loop.run({
    conversationId: "c1",
    runId: "r1",
    mode: "chat",
    model: scenario.primaryModel,
    system: undefined,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    workspace: null,
    signal: new AbortController().signal,
    ...(scenario.fallbackModels ? { fallbackModels: scenario.fallbackModels } : {}),
    ...(scenario.allowModelFallback === undefined
      ? {}
      : { allowModelFallback: scenario.allowModelFallback }),
  });

  return { result, events: seen, attempts, routed };
}

describe("model fallback", () => {
  it("retries on the next model when the primary is rate limited", async () => {
    const { attempts, result } = await runOnce({
      primaryModel: "busy",
      failModels: ["busy"],
      fallbackModels: ["calm"],
    });
    expect(attempts).toEqual(["busy", "calm"]);
    expect(result.reason).toBe("stop");
  });

  it("walks the fallback list in the given order", async () => {
    const { attempts } = await runOnce({
      primaryModel: "a",
      failModels: ["a", "b"],
      fallbackModels: ["b", "c"],
    });
    expect(attempts).toEqual(["a", "b", "c"]);
  });

  it("skips a fallback the host already knows is unusable", async () => {
    // The list is ranked before the run starts, so it can still name a model
    // that an earlier attempt in this same run proved cannot answer. Trying it
    // would spend a request to learn what is already known.
    const { attempts, result } = await runOnce({
      primaryModel: "a",
      failModels: ["a", "b"],
      fallbackModels: ["b", "c"],
      blockedModels: ["b"],
    });
    expect(attempts).toEqual(["a", "c"]);
    expect(result.reason).toBe("stop");
  });

  it("does not substitute on an auth failure, which the next model shares", async () => {
    const { attempts, result, events } = await runOnce({
      primaryModel: "a",
      failModels: ["a"],
      kind: "auth",
      fallbackModels: ["b"],
    });
    expect(attempts).toEqual(["a"]);
    expect(result.reason).toBe("error");
    expect(events.some((event) => event.type === "model-switch")).toBe(false);
  });

  it("does not substitute on a network failure", async () => {
    const { attempts, result } = await runOnce({
      primaryModel: "a",
      failModels: ["a"],
      kind: "network",
      fallbackModels: ["b"],
    });
    expect(attempts).toEqual(["a"]);
    expect(result.reason).toBe("error");
  });

  it("substitutes for a model the provider no longer serves", async () => {
    const { attempts, result } = await runOnce({
      primaryModel: "gone",
      failModels: ["gone"],
      kind: "unsupported-model",
      fallbackModels: ["alive"],
    });
    expect(attempts).toEqual(["gone", "alive"]);
    expect(result.reason).toBe("stop");
  });

  it("caps the switches so a bad key cannot loop", async () => {
    const { attempts, result } = await runOnce({
      primaryModel: "a",
      failAll: true,
      fallbackModels: ["b", "c", "d", "e", "f"],
    });
    // Primary plus at most two switches, regardless of how many were offered.
    expect(attempts).toEqual(["a", "b", "c"]);
    expect(result.reason).toBe("error");
  });

  it("emits a model-switch event so the UI can say what happened", async () => {
    const { events } = await runOnce({
      primaryModel: "busy",
      failModels: ["busy"],
      fallbackModels: ["calm"],
    });
    const switches = events.filter((event) => event.type === "model-switch");
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ from: "busy", to: "calm" });
  });

  it("gives a plain-language reason for the switch", async () => {
    const { events } = await runOnce({
      primaryModel: "busy",
      failModels: ["busy"],
      fallbackModels: ["calm"],
    });
    const switchEvent = events.find((event) => event.type === "model-switch");
    expect(switchEvent && switchEvent.type === "model-switch" ? switchEvent.reason : "").toContain(
      "rate limit",
    );
  });

  it("refuses to substitute when the model is pinned", async () => {
    const { attempts, result } = await runOnce({
      primaryModel: "pinned",
      failModels: ["pinned"],
      fallbackModels: ["other"],
      allowModelFallback: false,
    });
    expect(attempts).toEqual(["pinned"]);
    expect(result.reason).toBe("error");
  });

  it("does not route to another provider on its own", async () => {
    // Moving to another provider means another account, another key, another
    // bill, and another party receiving the conversation. Atomic does that only
    // when the user says so -- so the decisive assertion is that the other
    // provider's log stays empty.
    const { result, routed } = await runOnce({
      primaryModel: "zen-busy",
      failModels: ["zen-busy"],
      extraProviders: [{ id: "openrouter", label: "OpenRouter" }],
      fallbackModels: [{ model: "or-calm", providerId: "openrouter", providerLabel: "OpenRouter" }],
    });
    expect(result.reason).toBe("error");
    // `routed` carries a key per configured provider, so the assertion is on
    // what was *asked for* there, not on whether the key exists.
    expect(routed["openrouter"]).toEqual([]);
    expect(routed["zen"]).toEqual(["zen-busy"]);
  });

  it("offers the other provider instead of using it", async () => {
    const { events } = await runOnce({
      primaryModel: "zen-busy",
      failModels: ["zen-busy"],
      extraProviders: [{ id: "openrouter", label: "OpenRouter" }],
      fallbackModels: [{ model: "or-calm", providerId: "openrouter" }],
    });
    const offer = events.find((event) => event.type === "provider-switch-required");
    expect(offer).toMatchObject({
      from: "zen-busy",
      to: "or-calm",
      providerId: "openrouter",
      providerLabel: "OpenRouter",
    });
  });

  it("offers rather than errors, so the reply is not painted as a failure", async () => {
    // The offer is reported once, with a button. Also reporting a run-error put
    // a red banner above a question the user could still answer in one click.
    const { events } = await runOnce({
      primaryModel: "zen-busy",
      failModels: ["zen-busy"],
      extraProviders: [{ id: "openrouter", label: "OpenRouter" }],
      fallbackModels: [{ model: "or-calm", providerId: "openrouter" }],
    });
    expect(events.some((event) => event.type === "run-error")).toBe(false);
  });

  it("finishes on this provider before ever offering another one", async () => {
    // Both would answer, so the run is recoverable here and the question is not
    // worth asking. Offering would train the user to click through a consent
    // dialog for a switch Atomic did not need.
    const { result, routed, events } = await runOnce({
      primaryModel: "zen-busy",
      failModels: ["zen-busy"],
      extraProviders: [{ id: "openrouter", label: "OpenRouter" }],
      fallbackModels: [
        { model: "zen-other", providerId: "zen" },
        { model: "or-calm", providerId: "openrouter" },
      ],
    });
    expect(result.reason).toBe("stop");
    expect(routed["zen"]).toEqual(["zen-busy", "zen-other"]);
    expect(events.some((event) => event.type === "provider-switch-required")).toBe(false);
  });

  it("falls back within the same provider when there is no other one", async () => {
    const { attempts, result } = await runOnce({
      primaryModel: "a",
      failModels: ["a", "b"],
      fallbackModels: [
        { model: "b", providerId: "zen" },
        { model: "c", providerId: "zen" },
      ],
    });
    expect(attempts).toEqual(["a", "b", "c"]);
    expect(result.reason).toBe("stop");
  });

  it("skips a cross-provider entry whose provider is not available", async () => {
    // Better to keep looking than to send a model to a provider we cannot reach,
    // which would fail with a config error instead of a rate limit.
    const { attempts, result, routed } = await runOnce({
      primaryModel: "a",
      failModels: ["a"],
      fallbackModels: [
        { model: "ghost", providerId: "not-configured" },
        { model: "b", providerId: "zen" },
      ],
    });
    expect(result.reason).toBe("stop");
    expect(attempts).toEqual(["a", "b"]);
    expect(routed["not-configured"]).toBeUndefined();
  });

  it("still skips a blocked model before switching provider", async () => {
    // Usability is checked before preference, not after: a free model on another
    // provider that we already know cannot answer is worth less than a working
    // one here.
    const { attempts } = await runOnce({
      primaryModel: "a",
      failModels: ["a"],
      blockedModels: ["b"],
      extraProviders: [{ id: "openrouter", label: "OpenRouter" }],
      fallbackModels: [
        { model: "b", providerId: "openrouter" },
        { model: "c", providerId: "zen" },
      ],
    });
    expect(attempts).toEqual(["a", "c"]);
  });

  it("names the provider in the offer, not in a switch it did not make", async () => {
    const { events } = await runOnce({
      primaryModel: "zen-busy",
      failModels: ["zen-busy"],
      extraProviders: [{ id: "openrouter", label: "OpenRouter" }],
      fallbackModels: [{ model: "or-calm", providerId: "openrouter" }],
    });
    const offer = events.find((event) => event.type === "provider-switch-required");
    // Without the label the offer reads identically for a Zen rate limit and an
    // OpenRouter one, and the user cannot tell what they would be approving.
    expect(offer && offer.type === "provider-switch-required" ? offer.providerLabel : null).toBe(
      "OpenRouter",
    );
    // And nothing announced a switch, because none happened.
    expect(events.some((event) => event.type === "model-switch")).toBe(false);
  });

  it("does not name a provider when only the model changed", async () => {
    const { events } = await runOnce({
      primaryModel: "a",
      failModels: ["a"],
      fallbackModels: ["b"],
    });
    const switchEvent = events.find((event) => event.type === "model-switch");
    expect(
      switchEvent && switchEvent.type === "model-switch" ? switchEvent.providerLabel : null,
    ).toBeUndefined();
  });

  it("offers the first other provider and stops, rather than shopping between them", async () => {
    const { result, routed, events } = await runOnce({
      primaryModel: "a",
      failAll: true,
      extraProviders: [
        { id: "p1", label: "P1", fail: true },
        { id: "p2", label: "P2", fail: true },
        { id: "p3", label: "P3", fail: true },
      ],
      fallbackModels: [
        { model: "m1", providerId: "p1" },
        { model: "m2", providerId: "p2" },
        { model: "m3", providerId: "p3" },
        { model: "m4", providerId: "p1" },
      ],
    });
    // One offer, one dead end. Walking the user's data through four providers
    // looking for one that works is not a fallback, it is a campaign.
    const offers = events.filter((event) => event.type === "provider-switch-required");
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ to: "m1", providerId: "p1" });
    expect(result.reason).toBe("error");
    // Only the provider the run started on was ever asked for a model.
    expect(routed["zen"]).toEqual(["a"]);
    expect(routed["p1"]).toEqual([]);
    expect(routed["p2"]).toEqual([]);
    expect(routed["p3"]).toEqual([]);
  });

  it("uses the primary model when it works and no switch is announced", async () => {
    const { attempts, events } = await runOnce({
      primaryModel: "good",
      failModels: [],
      fallbackModels: ["other"],
    });
    expect(attempts).toEqual(["good"]);
    expect(events.some((event) => event.type === "model-switch")).toBe(false);
  });
});

describe("the free-only runtime guard", () => {
  /** A provider that reports a real, non-zero usage for every turn. */
  function billingProvider(input: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Models the model will call a tool with, to force a second step. */
    readonly toolCall?: boolean;
  }): { provider: Provider; calls: number } {
    let calls = 0;
    const provider: Provider = {
      id: "test",
      name: "Test",
      baseUrl: "http://test.invalid/v1",
      async listModels() {
        return { models: [], fetchedAt: 0, source: "fallback" };
      },
      async complete() {
        return {
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          usage: EMPTY_USAGE,
        };
      },
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "text", text: "ok" } as StreamEvent;
        yield {
          type: "done",
          usage: {
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: input.inputTokens + input.outputTokens,
          },
        } as StreamEvent;
      },
      supportsModel() {
        return true;
      },
    };
    return { provider, calls: () => calls };
  }

  async function runGuarded(
    review: (input: { model: string }) => TurnCostReview | null,
  ) {
    const { provider, calls } = billingProvider({
      inputTokens: 1_000,
      outputTokens: 2_000,
    });
    const events = new AgentEventBus();
    const seen: AgentEvent[] = [];
    events.subscribe((event) => seen.push(event));
    const loop = new AgentLoop({
      provider,
      registry: new ToolRegistry(),
      gate: new PermissionGate(() => SettingsSchema.parse({}), { platform: "linux" }),
      events,
      approval: new ApprovalBroker(),
      reviewUsage: async ({ model }) => review({ model }),
    });
    const result = await loop.run({
      conversationId: "c1",
      runId: "r1",
      mode: "chat",
      model: "paid-model",
      system: undefined,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: null,
      signal: new AbortController().signal,
    });
    return { result, events: seen, calls: calls() };
  }

  it("halts the run when the turn is found to have cost money", async () => {
    const { result, events } = await runGuarded(() => ({
      ok: false,
      reason: "Paid Model cost $0.0330.",
      cost: 0.033,
    }));
    expect(result.reason).toBe("error");
    const failure = events.find((event) => event.type === "run-error");
    expect(failure).toMatchObject({ kind: "free-policy" });
    if (failure?.type === "run-error") {
      // The user is told what it cost, not just that something went wrong.
      expect(failure.userMessage).toContain("$0.0330");
    }
  });

  it("keeps the answer it already paid for", async () => {
    const { result } = await runGuarded(() => ({
      ok: false,
      reason: "too expensive",
      cost: 1,
      spend: { kind: "billed", usd: 1 } as const,
    }));
    // Discarding a real answer over a pricing surprise would be a worse lie
    // than showing it with a warning attached.
    expect(result.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("runs to completion when nothing objects", async () => {
    const { result, calls } = await runGuarded(() => null);
    expect(result.reason).toBe("stop");
    expect(calls).toBe(1);
    expect(result.usage.outputTokens).toBe(2_000);
  });

  it("is told which model to judge", async () => {
    const { result } = await runGuarded(({ model }) =>
      model === "paid-model"
        ? { ok: false, reason: "that one costs money", cost: 1 }
        : null,
    );
    expect(result.reason).toBe("error");
  });

  it("checks after the answer is saved, so nothing is lost to a race", async () => {
    // A guard that ran before the usage was known could not catch anything; one
    // that runs before the message is persisted would lose the message.
    const { events } = await runGuarded(() => ({
      ok: false,
      reason: "too expensive",
      cost: 1,
      spend: { kind: "billed", usd: 1 } as const,
    }));
    const order = events.map((event) => event.type);
    expect(order).toContain("usage");
    expect(order.indexOf("usage")).toBeLessThan(order.indexOf("run-error"));
    expect(order).toContain("assistant-message");
  });

  /**
   * The reason this is a union. A note means the run is fine and the user should
   * read one quiet line; the old single-string contract could not say that, so
   * an unpriced free model produced a run-error and a successful answer looked
   * like a refusal.
   */
  it("emits a note and completes when the turn is fine but unpriced", async () => {
    const { result, events } = await runGuarded(() => ({
      ok: true,
      note: "qwen3 does not publish a per-token price.",
      // Unpriced, but classified free -- the case where "no price" and "no
      // charge" are the same fact and the run total can add a real zero.
      spend: { kind: "free" } as const,
    }));
    expect(result.reason).toBe("stop");
    expect(events.some((event) => event.type === "run-error")).toBe(false);
    const note = events.find((event) => event.type === "run-note");
    expect(note).toMatchObject({ message: "qwen3 does not publish a per-token price." });
  });
});

/**
 * A provider that answers once with a chosen finish reason, so truncation can be
 * driven exactly.
 */
function providerReturning(options: {
  readonly text: string;
  readonly finishReason: FinishReason;
}): Provider {
  return {
    id: "test",
    name: "Test",
    baseUrl: "http://test.invalid/v1",
    async listModels() {
      return { models: [], fetchedAt: 0, source: "fallback" };
    },
    async complete() {
      return { message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, usage: EMPTY_USAGE };
    },
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text", text: options.text } as StreamEvent;
      yield { type: "done", usage: EMPTY_USAGE, finishReason: options.finishReason } as StreamEvent;
    },
    supportsModel() {
      return true;
    },
  };
}

/**
 * Truncation.
 *
 * A provider that stops at its output-token limit has not answered. Reported as
 * a normal stop, the transcript shows a reply that simply ends mid-sentence with
 * nothing to indicate anything is missing, and the only available action is to
 * type a new question.
 */
describe("a run that hits the output-token limit", () => {
  const start = (provider: Provider) => {
    const events = new AgentEventBus();
    const loop = new AgentLoop({
      provider,
      registry: new ToolRegistry(),
      gate: new PermissionGate(() => SettingsSchema.parse({}), { platform: "linux" }),
      events,
      approval: new ApprovalBroker(),
    });
    return { events, loop };
  };

  const runOnce = (provider: Provider) =>
    start(provider).loop.run({
      conversationId: "c1",
      mode: "chat",
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: null,
      signal: new AbortController().signal,
    });

  it("reports length rather than stop", async () => {
    const { events, loop } = start(
      providerReturning({ text: "The answer so far is", finishReason: "length" }),
    );
    const result = await loop.run({
      conversationId: "c1",
      mode: "chat",
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: null,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("length");
  });

  it("emits run-finish with reason length", async () => {
    // The UI keys its Continue affordance off this; "stop" would hide it.
    const { events, loop } = start(
      providerReturning({ text: "partial", finishReason: "length" }),
    );
    const seen: string[] = [];
    events.subscribe((e) => {
      if (e.type === "run-finish") seen.push(e.reason);
    });
    await loop.run({
      conversationId: "c1",
      mode: "chat",
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: null,
      signal: new AbortController().signal,
    });
    expect(seen).toEqual(["length"]);
  });

  it("records the truncation on the assistant message", async () => {
    const { events, loop } = start(
      providerReturning({ text: "partial", finishReason: "length" }),
    );
    const seen: string[] = [];
    events.subscribe((e) => {
      if (e.type === "assistant-message") seen.push(e.finishReason);
    });
    await loop.run({
      conversationId: "c1",
      mode: "chat",
      model: "m",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: null,
      signal: new AbortController().signal,
    });
    expect(seen).toEqual(["length"]);
  });

  it("still says stop for a genuinely finished answer", async () => {
    // The guard on the fix: "length" must not become the default.
    const result = await runOnce(
      providerReturning({ text: "done", finishReason: "stop" }),
    );
    expect(result.reason).toBe("stop");
  });
});

/**
 * A folder approved partway through a run has to work in that same run.
 *
 * This is the whole reason `extraRoots` is a function rather than an array. With
 * a value captured when the run starts, the sequence below -- ask, get approved,
 * read a file in the new folder -- would authorize the folder, report success,
 * and then have the very next call refused for being "outside every folder". The
 * user would have clicked Approve and seen nothing happen, which is worse than
 * not having offered.
 */
describe("a folder added mid-run", () => {
  const EXTRA = "/home/me/Code";

  /**
   * Calls `add_folder`, then `read_file` in whatever folder it just added, then
   * answers. The second step is the one that matters: it is the call whose
   * `extraRoots` decides whether the approval reached anything.
   */
  function folderThenReadProvider(): Provider {
    let turn = 0;
    return {
      id: "zen",
      name: "Test",
      baseUrl: "http://test.invalid/v1",
      async listModels() {
        return { models: [], fetchedAt: 0, source: "fallback" };
      },
      async complete() {
        return { message: { role: "assistant", content: [] }, usage: EMPTY_USAGE };
      },
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<StreamEvent> {
        turn += 1;
        if (turn === 1) {
          const args = { path: EXTRA };
          yield {
            type: "tool-call-end" as const,
            index: 0,
            call: { id: "c1", name: "add_folder", args, rawArgs: JSON.stringify(args) },
          } as StreamEvent;
        } else if (turn === 2) {
          const args = { path: "README.md" };
          yield {
            type: "tool-call-end" as const,
            index: 0,
            call: { id: "c2", name: "read_file", args, rawArgs: JSON.stringify(args) },
          } as StreamEvent;
        } else {
          yield { type: "text-delta" as const, text: "done" } as StreamEvent;
        }
        yield { type: "done" as const, usage: EMPTY_USAGE } as StreamEvent;
      },
      supportsModel() {
        return true;
      },
    };
  }

  it("is usable by the next tool call in the same run", async () => {
    const registry = new ToolRegistry();
    const roots: string[] = [];
    const readPaths: string[] = [];

    registry.register({
      name: "add_folder",
      description: "Ask to use a folder",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      categories: ["folder-access"],
      modes: ["code"],
      execute: async (args) => {
        roots.push(String(args.path));
        return { content: "added" };
      },
    });
    registry.register({
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      categories: ["file-read"],
      modes: ["code"],
      execute: async (args, ctx) => {
        readPaths.push(String(args.path));
        // The roots the tool is handed, which is where the new folder has to be.
        return { content: `roots=${ctx.extraRoots().join(",")}` };
      },
    });

    // The same shape the host passes: a function, so it re-reads per call.
    const loop = new AgentLoop({
      provider: folderThenReadProvider(),
      registry,
      gate: new PermissionGate(
        () => SettingsSchema.parse({ permissions: { code: { level: "ask" } } }),
        { platform: linux },
      ),
      events: new AgentEventBus(),
      approval: new ApprovalBroker(),
    });

    const result = await loop.run({
      conversationId: "c1",
      runId: "r1",
      mode: "code",
      model: "m",
      system: undefined,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: "/ws",
      extraRoots: () => roots,
      signal: new AbortController().signal,
      // The user approves, as they would after reading the prompt.
      approve: async () => true,
    });

    expect(result.reason).toBe("stop");
    expect(roots).toEqual([EXTRA]);
    // The point of the whole feature: the very next call in this run saw the new
    // folder. With roots captured at the start of the run this list would be
    // empty, and the user would have approved a folder that then did nothing.
    expect(readPaths).toEqual(["README.md"]);
    const toolText = result.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n");
    expect(toolText).toContain(`roots=${EXTRA}`);
  });

  it("is not usable by the next call if the user denies it", async () => {
    const registry = new ToolRegistry();
    const roots: string[] = [];
    let asked = 0;

    registry.register({
      name: "add_folder",
      description: "Ask to use a folder",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      categories: ["folder-access"],
      modes: ["code"],
      execute: async (args) => {
        roots.push(String(args.path));
        return { content: "added" };
      },
    });
    registry.register({
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      categories: ["file-read"],
      modes: ["code"],
      execute: async (args, ctx) => {
        asked += 1;
        return { content: `roots=${ctx.extraRoots().join(",")}` };
      },
    });

    const loop = new AgentLoop({
      provider: folderThenReadProvider(),
      registry,
      gate: new PermissionGate(
        () => SettingsSchema.parse({ permissions: { code: { level: "ask" } } }),
        { platform: linux },
      ),
      events: new AgentEventBus(),
      approval: new ApprovalBroker(),
    });

    await loop.run({
      conversationId: "c1",
      runId: "r1",
      mode: "code",
      model: "m",
      system: undefined,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: "/ws",
      extraRoots: () => roots,
      signal: new AbortController().signal,
      approve: async () => false,
    });

    // Nothing was added, so nothing downstream can act on it.
    expect(roots).toEqual([]);
    expect(asked).toBe(0);
  });
});

/**
 * "Allow always" has to mean allow.
 *
 * The approval card has always offered it, and the loop compared the broker's
 * answer against `"allow"` alone -- so `"allow-always"`, the value that button
 * sends, scored as a refusal. The user clicked the button that says yes, watched
 * the action be reported as denied, and had no way to tell the difference between
 * the agent ignoring them and the app being broken.
 */
describe("resolving a tool approval", () => {
  function approvingProvider(): Provider {
    let turn = 0;
    return {
      id: "zen",
      name: "Test",
      baseUrl: "http://test.invalid/v1",
      async listModels() {
        return { models: [], fetchedAt: 0, source: "fallback" };
      },
      async complete() {
        return { message: { role: "assistant", content: [] }, usage: EMPTY_USAGE };
      },
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<StreamEvent> {
        turn += 1;
        if (turn === 1) {
          const args = { path: "notes.txt" };
          yield {
            type: "tool-call-end" as const,
            index: 0,
            call: { id: "c1", name: "write_file", args, rawArgs: JSON.stringify(args) },
          } as StreamEvent;
        } else {
          yield { type: "text-delta" as const, text: "done" } as StreamEvent;
        }
        yield { type: "done" as const, usage: EMPTY_USAGE } as StreamEvent;
      },
      supportsModel() {
        return true;
      },
    };
  }

  async function runWithDecision(decision: "allow" | "allow-always" | "deny") {
    const registry = new ToolRegistry();
    const written: string[] = [];
    registry.register({
      name: "write_file",
      description: "Write a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      categories: ["file-write"],
      modes: ["code"],
      execute: async (args) => {
        written.push(String(args.path));
        return { content: "written" };
      },
    });

    const approval = new ApprovalBroker();
    const loop = new AgentLoop({
      provider: approvingProvider(),
      registry,
      gate: new PermissionGate(
        () => SettingsSchema.parse({ permissions: { code: { level: "ask" } } }),
        { platform: linux },
      ),
      events: new AgentEventBus(),
      approval,
    });

    const pending = loop.run({
      conversationId: "c1",
      runId: "r1",
      mode: "code",
      model: "m",
      system: undefined,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: "/ws",
      signal: new AbortController().signal,
    });

    // Resolve as soon as the card would have been shown, rather than racing it.
    await vi.waitFor(() => expect(approval.list().length).toBe(1));
    expect(approval.resolve("c1", decision)).toBe(true);
    return { result: await pending, written };
  }

  it("runs the action when the user picks Allow", async () => {
    const { written } = await runWithDecision("allow");
    expect(written).toEqual(["notes.txt"]);
  });

  it("runs the action when the user picks Allow always", async () => {
    const { written } = await runWithDecision("allow-always");
    expect(written).toEqual(["notes.txt"]);
  });

  it("does not run the action when the user picks Deny", async () => {
    const { written } = await runWithDecision("deny");
    expect(written).toEqual([]);
  });
});

/**
 * The runtime limit declared in settings.
 *
 * `maxRuntimeSeconds` sat in the settings schema, was shown in a panel, and was
 * read by nothing: a runaway Cowork run had no stop of its own and the only way
 * out was the cancel button. Unlike `maxSpendUsd` this one is enforced honestly,
 * because a clock needs no external evidence to be believed -- there is no
 * equivalent of "the provider declined to say what it cost" for elapsed time.
 */
describe("the runtime limit declared in settings", () => {
  /**
   * A provider that keeps asking for tool calls, so a run stays alive until the
   * limit stops it. One that answered immediately would finish before any clock
   * could matter and would pass whether or not the check exists.
   */
  function endlessProvider(onStep: () => void): Provider {
    let turn = 0;
    return {
      id: "test",
      name: "Test",
      baseUrl: "http://test.invalid/v1",
      async listModels() {
        return { models: [], fetchedAt: 0, source: "fallback" };
      },
      async complete() {
        return { message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, usage: EMPTY_USAGE };
      },
      async *stream(): AsyncIterable<StreamEvent> {
        turn += 1;
        onStep();
        yield {
          type: "tool-call-end",
          index: 0,
          call: { id: `c${turn}`, name: "ping", args: {}, rawArgs: "{}" },
        } as StreamEvent;
        yield { type: "done", usage: EMPTY_USAGE, finishReason: "tool-calls" } as StreamEvent;
      },
      supportsModel() {
        return true;
      },
    };
  }

  function pingRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: "ping",
      description: "Does nothing",
      parameters: { type: "object", properties: {} },
      categories: ["bash"],
      modes: ["chat"],
      // Auto-approved so the run never waits on a human: the thing that stops
      // this run has to be the limit, not an unanswered prompt.
      execute: async () => ({ content: "pong" }),
    });
    return registry;
  }

  /** A clock the run reads, advanced only when the provider is called. */
  function clock() {
    let value = 0;
    return {
      now: () => value,
      advance: (ms: number) => {
        value += ms;
      },
    };
  }

  function runWithLimit(
    maxRuntimeSeconds: number,
    time: ReturnType<typeof clock>,
    events: AgentEventBus,
  ): Promise<{ result: Awaited<ReturnType<AgentLoop["run"]>>; seen: AgentEvent[] }> {
    const seen: AgentEvent[] = [];
    events.subscribe((event) => seen.push(event));
    const loop = new AgentLoop({
      provider: endlessProvider(() => time.advance(1_000)),
      registry: pingRegistry(),
      gate: new PermissionGate(
        () =>
          SettingsSchema.parse({
            permissions: {
              chat: { level: "ask", autoApprove: { bash: true }, maxRuntimeSeconds },
            },
          }),
        { platform: "linux" },
      ),
      events,
      approval: new ApprovalBroker(),
      now: time.now,
    });
    return loop
      .run({
        conversationId: "c1",
        mode: "chat",
        model: "m",
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        workspace: null,
        // The block the host passes in production. Carrying the limit here is the
        // whole wiring: the gate's own copy is a separate object, and the loop
        // reads the one it is handed.
        settings: SettingsSchema.parse({
          permissions: { chat: { level: "ask", autoApprove: { bash: true }, maxRuntimeSeconds } },
        }),
        signal: new AbortController().signal,
      })
      .then((result) => ({ result, seen }));
  }

  it("stops a run that has been going longer than the limit", async () => {
    // The clock advances one second per step, so a 3-second limit is crossed on
    // the fourth. Without the check this loop would run until `maxSteps` (200),
    // which is what it did before.
    const time = clock();
    const { result, seen } = await runWithLimit(3, time, new AgentEventBus());

    expect(result.steps).toBeLessThan(200);
    const failure = seen.find((event) => event.type === "run-error");
    expect(failure?.type === "run-error" && failure.userMessage).toMatch(/time limit/i);
  });

  it("reports the limit as a limit rather than a failure or a finished answer", async () => {
    // Three words were available and all three lied. "error" showed the user a
    // red banner for their own setting; "length" showed them "your answer was cut
    // off at the output limit" for a run that was working too slowly. `limit`
    // says the one true thing, and the UI can act on it.
    const time = clock();
    const { result } = await runWithLimit(2, time, new AgentEventBus());
    expect(result.reason).toBe("limit");
  });

  it("names the limit it reached, so the setting can be found", async () => {
    const time = clock();
    const { seen } = await runWithLimit(2, time, new AgentEventBus());
    const failure = seen.find((event) => event.type === "run-error");
    expect(failure?.type === "run-error" && failure.userMessage).toContain("2s");
  });

  it("runs to the step limit instead, when the limit is generous", async () => {
    const time = clock();
    const { result } = await runWithLimit(0, time, new AgentEventBus());
    // 0 means unlimited, which is what the schema documents for these limits.
    expect(result.steps).toBe(200);
    expect(result.reason).toBe("limit");
  });
});

/**
 * The spend limit declared in settings.
 *
 * It was in the schema, in the settings panel, and enforced by nothing. The
 * version that first tried to read it compared `usage.reportedCost ?? 0` against
 * the limit, which reads a paid turn as a free one: reported cost is absent on
 * every provider except OpenRouter and OpenCode Zen, so the cap could only ever
 * fire on the two providers that already report what they spend. On everything
 * else -- and on every local model, which is where an unbounded run is most
 * likely -- it was silently inert while the UI said it was in force.
 *
 * So the total is accumulated from the per-turn classification in
 * `free-policy.ts`, which distinguishes a number the provider billed, a number
 * calculated from published prices, a positive zero, and "cannot say".
 */
describe("the spend limit declared in settings", () => {
  /**
   * A provider that keeps calling a tool, so the run takes several turns and the
   * total has something to accumulate. One that answered immediately could not
   * distinguish a cap that works from a cap that never gets a second chance.
   */
  function chargingProvider(reportedCost: number | undefined): {
    readonly provider: Provider;
    readonly turns: () => number;
  } {
    let turns = 0;
    return {
      turns: () => turns,
      provider: {
        id: "test",
        name: "Test",
        baseUrl: "http://test.invalid/v1",
        async listModels() {
          return { models: [], fetchedAt: 0, source: "fallback" };
        },
        async complete() {
          return { message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, usage: EMPTY_USAGE };
        },
        async *stream(): AsyncIterable<StreamEvent> {
          turns += 1;
          yield {
            type: "tool-call-end",
            index: 0,
            call: { id: `c${turns}`, name: "ping", args: {}, rawArgs: "{}" },
          } as StreamEvent;
          yield {
            type: "done",
            usage: reportedCost === undefined ? EMPTY_USAGE : { ...EMPTY_USAGE, reportedCost },
            finishReason: "tool-calls",
          } as StreamEvent;
        },
        supportsModel() {
          return true;
        },
      },
    };
  }

  function pingRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: "ping",
      description: "Does nothing",
      parameters: { type: "object", properties: {} },
      categories: ["bash"],
      modes: ["chat"],
      execute: async () => ({ content: "pong" }),
    });
    return registry;
  }

  function run(
    options: {
      readonly maxSpendUsd: number;
      readonly spend: (turn: number) => TurnSpend;
      readonly maxSteps?: number;
    },
  ): Promise<{ result: AgentRunResult; events: AgentEvent[]; turns: () => number }> {
    const { provider, turns } = chargingProvider(0);
    const events = new AgentEventBus();
    const seen: AgentEvent[] = [];
    events.subscribe((event) => seen.push(event));
    let turn = 0;
    const loop = new AgentLoop({
      provider,
      registry: pingRegistry(),
      gate: new PermissionGate(
        () =>
          SettingsSchema.parse({
            permissions: {
              chat: {
                level: "ask",
                autoApprove: { bash: true },
                maxSpendUsd: options.maxSpendUsd,
                maxSteps: options.maxSteps ?? 200,
              },
            },
          }),
        { platform: "linux" },
      ),
      events,
      approval: new ApprovalBroker(),
      reviewUsage: async () => {
        turn += 1;
        return { ok: true, spend: options.spend(turn) };
      },
    });
    return loop
      .run({
        conversationId: "c1",
        runId: "r1",
        mode: "chat",
        model: "paid-model",
        system: undefined,
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        workspace: null,
        settings: SettingsSchema.parse({
          permissions: {
            chat: {
              level: "ask",
              autoApprove: { bash: true },
              maxSpendUsd: options.maxSpendUsd,
              maxSteps: options.maxSteps ?? 200,
            },
          },
        }),
        signal: new AbortController().signal,
      })
      .then((result) => ({ result, events: seen, turns }));
  }

  it("stops a run that reaches the limit, and says so in money", async () => {
    // 40 cents a turn against a 1-dollar cap: the third turn crosses it. What
    // matters is that the total spans turns, which the first implementation
    // could not do -- it read one turn's reported cost and never more.
    const { result, events } = await run({
      maxSpendUsd: 1,
      spend: () => ({ kind: "billed", usd: 0.4 }),
    });

    expect(result.reason).toBe("limit");
    const failure = events.find((event) => event.type === "run-error");
    expect(failure?.type === "run-error" && failure.userMessage).toMatch(
      /1\.2000.*1\.00/s,
    );
  });

  it("keeps going while the total is still under the limit", async () => {
    // The guard on the change above: a cap that stops on the first turn would
    // pass the test above too.
    const { result, turns } = await run({
      maxSpendUsd: 5,
      spend: () => ({ kind: "billed", usd: 0.1 }),
      maxSteps: 4,
    });
    expect(result.reason).toBe("limit");
    // Four steps, then the step limit -- not a spend stop at 40 cents.
    expect(turns()).toBe(4);
    expect(result.steps).toBe(4);
  });

  it("counts estimated cost toward the cap as well as billed", async () => {
    // OpenAI-compatible endpoints report no cost, so their turns are priced from
    // the catalog. A cap that only watched `reportedCost` would protect nothing
    // there, which is the whole failure being fixed.
    const { result } = await run({
      maxSpendUsd: 0.5,
      spend: () => ({ kind: "estimated", usd: 0.3 }),
    });
    expect(result.reason).toBe("limit");
  });

  it("lets a free run go forever, because it is genuinely free", async () => {
    // Local models report no cost and publish no price, and that is evidence
    // rather than ignorance. Treating it as unknown -- and therefore capping or
    // halting -- would break the common case, where there is no money at stake.
    const { result, turns } = await run({
      maxSpendUsd: 1,
      spend: () => ({ kind: "free" }),
      maxSteps: 3,
    });
    expect(turns()).toBe(3);
    expect(result.reason).toBe("limit"); // the step limit, not a spend stop
  });

  it("does not halt on an unknown turn, but admits the cap did not cover it", async () => {
    // The awkward case, and the one the earlier `?? 0` hid completely: a custom
    // endpoint that neither reports a cost nor appears in the catalog. Halting
    // here would make such models unusable whenever a cap is set -- a cap that
    // defaults to on. Silently counting them as free would be worse. So the run
    // finishes and says, once, that it could not check.
    const { result, events } = await run({
      maxSpendUsd: 1,
      spend: () => ({ kind: "unknown" }),
      maxSteps: 2,
    });
    expect(result.reason).toBe("limit");
    expect(events.some((event) => event.type === "run-error")).toBe(false);
    // Filtered to the cap's own note, because the step limit has one too and the
    // two say different things.
    const capNote = events
      .filter((event) => event.type === "run-note" && /spend limit/.test(event.message))
      .map((event) => (event.type === "run-note" ? event.message : ""));
    expect(capNote).toHaveLength(1);
    expect(capNote[0]).toMatch(/could not be checked for 2 turns/);
  });

  it("says nothing about the cap when it was never in play", async () => {
    // 0 is the documented "unlimited". Announcing an unverifiable cap on a run
    // the user never limited would be a note about nothing.
    const { events } = await run({
      maxSpendUsd: 0,
      spend: () => ({ kind: "unknown" }),
      maxSteps: 2,
    });
    // The step-limit note still fires -- that one is also about a setting the
    // user set. What must not appear is a claim about a spend cap that was off.
    expect(
      events.some((event) => event.type === "run-note" && /spend limit/.test(event.message)),
    ).toBe(false);
  });

  it("adds a known cost on top of an unknown one, and still admits the gap", async () => {
    // Both facts at once, which is what a fallback chain produces: one provider
    // bills, the next cannot say. The number is reported as far as it is known
    // and the remainder is named, rather than the total being quietly discarded
    // because part of it was unknowable.
    const { events } = await run({
      maxSpendUsd: 5,
      spend: (turn) => (turn === 1 ? { kind: "billed", usd: 0.2 } : { kind: "unknown" }),
      maxSteps: 2,
    });
    const note = events.find(
      (event) => event.type === "run-note" && /spend limit/.test(event.message),
    );
    expect(note?.type === "run-note" && note.message).toMatch(/1 turn/);
  });
});
