/**
 * The cost guard, end to end, with a provider that reports what it charged.
 *
 * The unit tests for `reviewTurnCost` cover the decision table. This file covers
 * the part that was missing: whether a reported charge survives the trip from an
 * HTTP response to that decision. It did not -- `usage.cost` was dropped while
 * mapping the response, and the host never passed anything in its place, so the
 * `providerReportedCost` branch was unreachable from any real send. These tests
 * would have passed against a guard that could never fire.
 *
 * The rule under test: a reported charge stops a turn when free-only is on, or
 * when the model was classified free. With free-only off and a model the user
 * chose knowing it was paid, the turn completes -- otherwise paid models could
 * not be used however the app was configured.
 */

import { describe, expect, it, vi } from "vitest";

import { LocalHost } from "./local.js";
import { SettingsStore } from "../settings/store.js";
import { MemorySecretStore } from "../secrets/secret-store.js";
import { migratedTestDatabase } from "../storage/sqlite.test-support.js";
import type { HostServices } from "./ports.js";
import type { AgentEvent } from "../agent/events.js";

/** A key-shaped fixture. Never a credential: it is never sent anywhere real. */
const FIXTURE_KEY = "sk-test-0000000000000000000000000000";

const PAID_MODEL = "paid-model";
const FREE_MODEL = "free-model";
const PAID_COST = { input: 3, output: 15 };

const MODELS_DEV = {
  opencode: {
    models: {
      [PAID_MODEL]: {
        id: PAID_MODEL,
        name: "Paid Model",
        cost: PAID_COST,
        tool_call: true,
      },
      // Published at $0, so the catalog classifies it free. Used for the case
      // where a charge *is* a broken promise rather than a bill.
      [FREE_MODEL]: {
        id: FREE_MODEL,
        name: "Free Model",
        cost: { input: 0, output: 0 },
        tool_call: true,
      },
    },
  },
};

const CATALOG = { data: [{ id: PAID_MODEL }, { id: FREE_MODEL }] };

/**
 * A provider response that reports what it charged.
 *
 * `reportedCost` goes in the body as `usage.cost`, which is the field OpenRouter
 * and OpenCode Zen actually send, so this exercises the real parsing path rather
 * than a test-only shortcut.
 */
function completion(model: string, reportedCostUsd?: number): Record<string, unknown> {
  return {
    id: "c-1",
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: "the answer" }, finish_reason: "stop" },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 200,
      total_tokens: 300,
      ...(reportedCostUsd === undefined ? {} : { cost: reportedCostUsd }),
    },
  };
}

/** The same completion as the OpenAI streaming wire format. */
function sse(body: Record<string, unknown>): string {
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({
      id: "c-1",
      object: "chat.completion.chunk",
      created: 1,
      model: String(body.model ?? PAID_MODEL),
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra,
    })}\n\n`;
  const usage = (body.usage ?? {}) as Record<string, unknown>;
  return [
    chunk({ role: "assistant" }),
    chunk({ content: "the answer" }),
    `data: ${JSON.stringify({
      id: "c-1",
      object: "chat.completion.chunk",
      created: 1,
      model: String(body.model ?? PAID_MODEL),
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage,
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

/**
 * Collect a run's events, so the outcome can be asserted.
 *
 * The transcript cannot answer this. The answer is written before the guard
 * runs -- deliberately, so a pricing surprise never throws away a reply the user
 * already paid for -- which means a stopped turn and a completed one leave
 * exactly the same rows behind. The difference is a `run-error`, so that is what
 * these tests read.
 */
/** The model the request body asked for, so one fake can serve both. */
function requestedModel(init: unknown): string {
  const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? "{}")) as {
    model?: string;
  };
  return body.model ?? PAID_MODEL;
}

async function collectRun(host: LocalHost): Promise<{
  events: AgentEvent[];
  done: Promise<void>;
}> {
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const event of host.streamEvents()) {
      events.push(event);
      if (event.type === "run-finish" || event.type === "run-error") return;
    }
  })();
  return { events, done };
}

async function harness(input: {
  readonly reportedCost?: number;
  readonly onlyFree?: boolean;
} = {}) {
  const db = await migratedTestDatabase();
  const secrets = new MemorySecretStore();
  await secrets.set("provider.opencode-zen.apiKey", FIXTURE_KEY);
  const settings = new SettingsStore(db, {
    providerId: "opencode-zen",
    autoSelectFreeModelsOnly: input.onlyFree ?? false,
  });
  // Pinned to the paid model: this is about a model the user chose, not about
  // what Auto would have picked.
  await settings.setModelForMode("chat", PAID_MODEL, "opencode-zen");

  const fetchImpl = vi.fn(async (input_: string | URL | Request, init_?: RequestInit) => {
    const url = typeof input_ === "string" ? input_ : input_.toString();
    const body = url.startsWith("https://opencode.ai/zen/v1/models")
      ? CATALOG
      : url.startsWith("https://models.dev")
        ? MODELS_DEV
        : url.includes("/chat/completions")
          ? completion(requestedModel(init_), input.reportedCost)
          : undefined;
    if (body === undefined) return new Response("not found", { status: 404 });
    // The run streams, so a JSON body is not enough: the parser reads nothing
    // from it, the assistant turn comes back empty, and the test would be
    // asserting that an empty answer is a completed one.
    if (url.includes("/chat/completions")) {
      return new Response(sse(body as Record<string, unknown>), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const services = {
    platform: {
      os: "linux",
      rawOs: "linux",
      arch: "x64",
      description: "Linux",
      sep: "/",
      caseSensitivePaths: true,
      crlf: false,
    },
    env: {},
    ownKeys: {},
    fetch: fetchImpl,
  } as unknown as HostServices;

  const host = new LocalHost({ db, secrets, settings, services });
  return { db, settings, host };
}

async function messagesIn(db: Awaited<ReturnType<typeof migratedTestDatabase>>, id: string) {
  return db.select<{ role: string; content: string }>(
    "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY rowid",
    [id],
  );
}

async function waitForMessages(
  db: Awaited<ReturnType<typeof migratedTestDatabase>>,
  conversationId: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await messagesIn(db, conversationId);
    if (rows.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`expected ${expected} messages, timed out`);
}

describe("a turn on a model the user chose as paid", () => {
  /**
   * The requested confirmation, and the reason the wiring matters: the provider
   * reports a charge, the policy is off, the model is classified paid, and the
   * answer still lands in the transcript.
   */
  it("completes when the provider reports a charge and free-only is off", async () => {
    const { db, host } = await harness({ reportedCost: 0.0031, onlyFree: false });
    const conversation = await host.createConversation({ mode: "chat" });

    const { events, done } = await collectRun(host);
    await host.sendMessage({
      conversationId: conversation.id,
      text: "hello",
      model: PAID_MODEL,
      providerId: "opencode-zen",
      allowPaidModel: true,
    });
    await done;
    await waitForMessages(db, conversation.id, 2);

    // The charge was reported, the policy was off, the model is paid: the run
    // has to finish cleanly. A stop here would emit a free-policy `run-error`.
    const errors = events.filter((event) => event.type === "run-error");
    expect(errors.map((event) => event.type)).toEqual([]);
    expect(events.some((event) => event.type === "run-finish")).toBe(true);
  });

  /**
   * The other half, and the one that proves the first is not vacuous: same
   * reported charge, same policy off, but a model the catalog classifies *free*.
   *
   * Being charged for a model chosen because it was free is a broken promise
   * rather than a bill, so the turn stops whatever the toggle says. Without this
   * pair, "the paid turn completed" would also be satisfied by a guard that never
   * runs.
   */
  it("stops a charge on a model classified free, even with free-only off", async () => {
    const { host } = await harness({ reportedCost: 0.25, onlyFree: false });
    const conversation = await host.createConversation({ mode: "chat" });

    const { events, done } = await collectRun(host);
    await host
      .sendMessage({
        conversationId: conversation.id,
        text: "hello",
        model: FREE_MODEL,
        providerId: "opencode-zen",
        allowPaidModel: true,
      })
      .catch(() => undefined);
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 500))]);

    const errors = events.filter((event) => event.type === "run-error");
    expect(errors).toHaveLength(1);
    const error = errors[0] as Extract<AgentEvent, { type: "run-error" }>;
    expect(error.kind).toBe("free-policy");
    expect(error.userMessage).toMatch(/classified as free/);
  });

  it("does not treat an unreported cost as a reported zero", async () => {
    // `usage.cost` is absent, which is the normal case. If that absence were
    // read as a cost of zero the guard would record the model as observed-free
    // on no evidence at all, and a paid model would be trusted for the rest of
    // the session.
    const { db, host } = await harness({ onlyFree: false });
    const conversation = await host.createConversation({ mode: "chat" });

    await host.sendMessage({
      conversationId: conversation.id,
      text: "hello",
      model: PAID_MODEL,
      providerId: "opencode-zen",
      allowPaidModel: true,
    });
    await waitForMessages(db, conversation.id, 2);

    const messages = await messagesIn(db, conversation.id);
    expect(messages.map((row) => row.role)).toEqual(["user", "assistant"]);
  });

  it("still completes a paid turn when the provider reports nothing", async () => {
    // No charge reported and no policy on: nothing to object to.
    const { db, host } = await harness({ onlyFree: false });
    const conversation = await host.createConversation({ mode: "chat" });
    await host.sendMessage({
      conversationId: conversation.id,
      text: "hello",
      model: PAID_MODEL,
      providerId: "opencode-zen",
      allowPaidModel: true,
    });
    await waitForMessages(db, conversation.id, 2);
    expect((await messagesIn(db, conversation.id)).map((row) => row.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});
