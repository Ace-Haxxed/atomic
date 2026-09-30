import { describe, expect, it } from "vitest";
import { AgentLoop } from "./loop.js";
import { AgentEventBus, type AgentEvent } from "./events.js";
import { ApprovalBroker } from "./approval.js";
import { PermissionGate } from "../permissions/gate.js";
import { ToolRegistry } from "../tools/registry.js";
import { ProviderError, type ProviderErrorKind } from "../providers/errors.js";
import type { Provider, ModelRequest, StreamEvent } from "../models/provider.js";
import { SettingsSchema } from "../settings/schema.js";
import { EMPTY_USAGE, type FinishReason } from "../models/types.js";

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

  it("sends a cross-provider fallback to that provider", async () => {
    // A fallback id is not enough: the provider that is rate limiting us is not
    // going to serve the next model either. The attempt has to land on the other
    // provider's own log, or nothing has actually been recovered.
    const { result, routed } = await runOnce({
      primaryModel: "zen-busy",
      failModels: ["zen-busy"],
      extraProviders: [{ id: "openrouter", label: "OpenRouter" }],
      fallbackModels: [{ model: "or-calm", providerId: "openrouter", providerLabel: "OpenRouter" }],
    });
    expect(result.reason).toBe("stop");
    // The decisive assertion: the fallback was recorded on the *other*
    // provider's log, which can only happen if the loop routed it there.
    expect(routed["openrouter"]).toEqual(["or-calm"]);
    expect(routed["zen"]).not.toContain("or-calm");
  });

  it("prefers a different provider over a better model on the failing one", async () => {
    // Both are free and both would answer. Changing provider is what actually
    // recovers a rate limit, so it wins regardless of rank.
    const { routed } = await runOnce({
      primaryModel: "zen-busy",
      failModels: ["zen-busy"],
      extraProviders: [{ id: "openrouter", label: "OpenRouter" }],
      fallbackModels: [
        { model: "zen-other", providerId: "zen" },
        { model: "or-calm", providerId: "openrouter" },
      ],
    });
    expect(routed["openrouter"]).toEqual(["or-calm"]);
    // "or-calm" never reached the failing provider, and "zen-other" was not
    // tried first despite ranking higher.
    expect(routed["zen"]).not.toContain("or-calm");
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

  it("names the provider in the switch notice when the provider changed", async () => {
    const { events } = await runOnce({
      primaryModel: "zen-busy",
      failModels: ["zen-busy"],
      extraProviders: [{ id: "openrouter", label: "OpenRouter" }],
      fallbackModels: [{ model: "or-calm", providerId: "openrouter" }],
    });
    const switchEvent = events.find((event) => event.type === "model-switch");
    // Without this the notice reads identically for a Zen rate limit and an
    // OpenRouter one, and the user cannot tell what changed.
    expect(
      switchEvent && switchEvent.type === "model-switch" ? switchEvent.providerLabel : null,
    ).toBe("OpenRouter");
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

  it("caps cross-provider switches too", async () => {
    const { result, routed } = await runOnce({
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
    // Primary plus at most two switches, however many providers are offered.
    expect(result.reason).toBe("error");
    expect(Object.values(routed).flat()).toHaveLength(3);
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

  async function runGuarded(review: (input: { model: string }) => string | null) {
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
    const { result, events } = await runGuarded(() => "Paid Model cost $0.0330.");
    expect(result.reason).toBe("error");
    const failure = events.find((event) => event.type === "run-error");
    expect(failure).toMatchObject({ kind: "free-policy" });
    if (failure?.type === "run-error") {
      // The user is told what it cost, not just that something went wrong.
      expect(failure.userMessage).toContain("$0.0330");
    }
  });

  it("keeps the answer it already paid for", async () => {
    const { result } = await runGuarded(() => "too expensive");
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
      model === "paid-model" ? "that one costs money" : null,
    );
    expect(result.reason).toBe("error");
  });

  it("checks after the answer is saved, so nothing is lost to a race", async () => {
    // A guard that ran before the usage was known could not catch anything; one
    // that runs before the message is persisted would lose the message.
    const { events } = await runGuarded(() => "too expensive");
    const order = events.map((event) => event.type);
    expect(order).toContain("usage");
    expect(order.indexOf("usage")).toBeLessThan(order.indexOf("run-error"));
    expect(order).toContain("assistant-message");
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
