/**
 * Retrying a turn on another provider, and the transcript it must not touch.
 *
 * The bug these lock down: accepting a provider switch re-sent the user's text
 * through `sendMessage`, which persists a user turn before running. The failing
 * turn had already been persisted, so the transcript ended up holding the same
 * question twice with a single answer beneath it. Nothing looked broken -- the
 * answer still arrived, and the run still succeeded -- so it would have shipped.
 *
 * Counted through the real store rather than a mock, because the whole claim is
 * about what is in the database afterwards.
 */

import { describe, expect, it, vi } from "vitest";

import { LocalHost } from "./local.js";
import { SettingsStore } from "../settings/store.js";
import { MemorySecretStore } from "../secrets/secret-store.js";
import { migratedTestDatabase } from "../storage/sqlite.test-support.js";
import type { HostServices } from "./ports.js";

/** A key-shaped fixture. Never a credential: it is never sent anywhere real. */
const FIXTURE_KEY = "sk-test-0000000000000000000000000000";

const MODELS_DEV = {
  opencode: {
    models: {
      "free-model": {
        id: "free-model",
        name: "Free Model",
        cost: { input: 0, output: 0 },
        tool_call: true,
      },
    },
  },
};

const CATALOG = { data: [{ id: "free-model" }] };

function completionBody(text = "ok"): Record<string, unknown> {
  return {
    id: "c-1",
    model: "free-model",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  };
}

async function harness() {
  const db = await migratedTestDatabase();
  const secrets = new MemorySecretStore();
  await secrets.set("provider.opencode-zen.apiKey", FIXTURE_KEY);
  const settings = new SettingsStore(db, { providerId: "opencode-zen" });
  // Pinned, so the turn does not go through Auto resolution. These tests are
  // about what a retry does to the transcript, not about picking a model.
  await settings.setModelForMode("chat", "free-model", "opencode-zen");
  const fetchImpl = vi.fn(
    async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      // Only the three routes these tests need. Anything else 404s, which is
      // what makes the model's freeness resolvable: the Zen docs route answers
      // 200 with a chat body if a fake is careless, and the model then cannot
      // be classified and the send is refused before the run starts.
      if (url.startsWith("https://opencode.ai/zen/v1/models")) {
        return new Response(JSON.stringify(CATALOG), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://models.dev")) {
        return new Response(JSON.stringify(MODELS_DEV), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/chat/completions")) {
        return new Response(JSON.stringify(completionBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  ) as unknown as typeof fetch;
  // A run builds a system prompt, which reads the platform, so a harness that
  // omits it fails inside the background loop rather than at construction.
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
  return { db, settings, host, fetchImpl };
}

/**
 * Wait for a backgrounded run to write its answer.
 *
 * Counts, not a fixed sleep: the whole claim is about how many messages end up
 * in the transcript, so waiting for the count to reach an expected value is the
 * only way to read the result without racing the loop. A `>= 2` threshold would
 * have been satisfied by the *first* turn and reported the retry's silence as
 * if the retry had added nothing.
 */
async function settle(
  host: LocalHost,
  conversationId: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await host.listConversations();
    const conversation = rows.find((row) => row.id === conversationId);
    if (conversation && conversation.messageCount >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the run did not reach ${expected} messages in time`);
}

describe("retrying a turn on a provider the user chose", () => {
  it("does not add a second copy of the user's question", async () => {
    const { db, host } = await harness();
    const conversation = await host.createConversation({ mode: "chat" });

    // The first turn is asked and persisted, exactly as a failing turn is.
    await host.sendMessage({ conversationId: conversation.id, text: "why is the sky blue" });
    await settle(host, conversation.id, 2);

    const before = await db.select<{ role: string }>(
      "SELECT role FROM messages WHERE conversation_id = ? ORDER BY rowid",
      [conversation.id],
    );
    expect(before.map((row) => row.role)).toEqual(["user", "assistant"]);

    // The user accepts a switch to another provider.
    await host.retryOnProvider({
      conversationId: conversation.id,
      model: "free-model",
      providerId: "opencode-zen",
    });
    await settle(host, conversation.id, 3);

    const after = await db.select<{ role: string }>(
      "SELECT role FROM messages WHERE conversation_id = ? ORDER BY rowid",
      [conversation.id],
    );
    // One question, one answer, one new answer. The re-run must not have
    // appended the user's message again.
    expect(after.filter((row) => row.role === "user")).toHaveLength(1);
    expect(after.map((row) => row.role)).toEqual(["user", "assistant", "assistant"]);
  });

  it("does not re-ask the question in the user's voice", async () => {
    const { db, host } = await harness();
    const conversation = await host.createConversation({ mode: "chat" });
    await host.sendMessage({ conversationId: conversation.id, text: "why is the sky blue" });
    await settle(host, conversation.id, 2);

    await host.retryOnProvider({
      conversationId: conversation.id,
      model: "free-model",
      providerId: "opencode-zen",
    });
    await settle(host, conversation.id, 3);

    const texts = await db.select<{ role: string; content: string }>(
      "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY rowid",
      [conversation.id],
    );
    // The retry is driven by the transcript, not by a synthesised prompt, so
    // the only appearance of the question is the one the user typed.
    const questions = texts.filter((row) => row.content.includes("why is the sky blue"));
    expect(questions).toHaveLength(1);
    expect(questions[0]!.role).toBe("user");
  });

  it("keeps the user's question as the thing being answered", async () => {
    const { host, fetchImpl } = await harness();
    const conversation = await host.createConversation({ mode: "chat" });
    await host.sendMessage({ conversationId: conversation.id, text: "why is the sky blue" });
    await settle(host, conversation.id, 2);

    await host.retryOnProvider({
      conversationId: conversation.id,
      model: "free-model",
      providerId: "opencode-zen",
    });
    await settle(host, conversation.id, 3);

    // The provider is asked to answer the question the transcript already
    // contains, rather than being handed an empty or duplicated history.
    const bodies = (fetchImpl as unknown as { mock?: { calls: unknown[][] } }).mock?.calls ?? [];
    const prompts = bodies
      .map((call) => JSON.parse(String((call[1] as { body?: string } | undefined)?.body ?? "{}")))
      .flatMap((body) => (Array.isArray(body.messages) ? body.messages : []))
      .map((message: { role?: string; content?: unknown }) => ({
        role: message.role,
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      }));
    const userTurns = prompts.filter((message) => message.role === "user");
    expect(userTurns.length).toBeGreaterThan(0);
    expect(userTurns.some((message) => message.content.includes("why is the sky blue"))).toBe(true);
  });
});
