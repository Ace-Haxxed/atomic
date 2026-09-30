import { describe, expect, it } from "vitest";
import {
  isEmptyConversation,
  pickConversationForMode,
  pruneEmptyConversations,
} from "./empty-chat.js";
import type { ConversationSummary } from "../storage/repositories.js";
import type { Mode } from "../settings/schema.js";

function conversation(input: {
  id: string;
  mode?: Mode;
  messages?: number;
  pinned?: boolean;
}): ConversationSummary {
  return {
    id: input.id,
    mode: input.mode ?? "chat",
    title: null,
    model: null,
    providerId: null,
    workspace: null,
    systemPrompt: null,
    pinned: input.pinned ?? false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: input.messages ?? 0,
    lastPreview: null,
  };
}

describe("isEmptyConversation", () => {
  it("is true for a chat with no messages", () => {
    expect(isEmptyConversation(conversation({ id: "a" }))).toBe(true);
  });

  it("is false once there is a message", () => {
    expect(isEmptyConversation(conversation({ id: "a", messages: 1 }))).toBe(false);
  });

  // A pinned empty chat was deliberately kept by the user; deleting it as
  // "leftover" would throw away an explicit choice.
  it("is false for a pinned chat even with no messages", () => {
    expect(isEmptyConversation(conversation({ id: "a", pinned: true }))).toBe(false);
  });
});

describe("pickConversationForMode", () => {
  it("reports no conversation when the mode is unused", () => {
    const result = pickConversationForMode([], "chat");

    expect(result.reuse).toBeNull();
    expect(result.reason).toBe("none");
  });

  it("reuses an existing empty chat instead of asking for a new one", () => {
    // The bug this fixes: every launch created another blank chat, so the user
    // typed into one and came back to a different one.
    const existing = conversation({ id: "blank" });

    const result = pickConversationForMode([existing], "chat");

    expect(result.reuse?.id).toBe("blank");
    expect(result.reason).toBe("empty-reuse");
  });

  it("opens a real chat in preference to a blank one", () => {
    const blank = conversation({ id: "blank" });
    const real = conversation({ id: "real", messages: 4 });

    const result = pickConversationForMode([blank, real], "chat");

    expect(result.reuse?.id).toBe("real");
    expect(result.reason).toBe("recent");
  });

  it("keeps the newest blank chat and prunes the rest", () => {
    const result = pickConversationForMode(
      [
        conversation({ id: "newest" }),
        conversation({ id: "middle" }),
        conversation({ id: "oldest" }),
      ],
      "chat",
    );

    // Input is newest-first, so `newest` is the one worth keeping.
    expect(result.reuse?.id).toBe("newest");
    expect(result.prune).toEqual(["middle", "oldest"]);
  });

  it("never returns a reuse id in the prune list", () => {
    const result = pickConversationForMode(
      [conversation({ id: "keep" }), conversation({ id: "drop" }), conversation({ id: "real", messages: 1 })],
      "chat",
    );

    expect(result.reuse?.id).toBe("real");
    expect(result.prune).not.toContain("real");
  });

  it("ignores conversations from other modes", () => {
    const result = pickConversationForMode([conversation({ id: "code-chat", mode: "code" })], "chat");

    expect(result.reuse).toBeNull();
  });

  it("does not treat a pinned empty chat as a spare", () => {
    const result = pickConversationForMode(
      [conversation({ id: "blank" }), conversation({ id: "kept", pinned: true })],
      "chat",
    );

    expect(result.prune).toEqual([]);
  });
});

describe("pruneEmptyConversations", () => {
  it("leaves a single empty chat per mode", () => {
    // The pile of Untitled rows came from this: one per launch, one per switch.
    const stale = pruneEmptyConversations([
      conversation({ id: "chat-2" }),
      conversation({ id: "chat-1" }),
      conversation({ id: "code-1", mode: "code" }),
    ]);

    // One blank survives per mode: `chat-2` for chat, `code-1` for code.
    expect(stale).toEqual(["chat-1"]);
  });

  it("never prunes a chat that has messages", () => {
    expect(
      pruneEmptyConversations([conversation({ id: "a", messages: 1 }), conversation({ id: "b" })]),
    ).toEqual([]);
  });

  it("agrees with the per-mode picker about which blank survives", () => {
    const all = [conversation({ id: "a" }), conversation({ id: "b" }), conversation({ id: "c" })];

    const kept = pickConversationForMode(all, "chat").reuse?.id;
    const pruned = pruneEmptyConversations(all);

    expect(kept).toBe("a");
    expect(pruned).not.toContain(kept);
  });
});
