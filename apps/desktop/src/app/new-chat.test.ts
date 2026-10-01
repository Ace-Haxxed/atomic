/**
 * "New chat" is a button, not a launch. These tests are about the three things
 * it kept getting wrong: the draft surviving, the mode being lost, and a failed
 * press replacing the whole window.
 */

import { describe, expect, it } from "vitest";
import type { ConversationSummary, HostApi, Mode } from "@atomic/core";

import { startNewChat } from "./new-chat.js";

const MODE_NAMES: Record<Mode, string> = {
  chat: "Chat",
  cowork: "Cowork",
  code: "Code",
};

function summary(over: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    mode: "chat",
    title: null,
    messageCount: 0,
    updatedAt: 1,
    ...over,
  } as ConversationSummary;
}

/** A host that records what was asked of it. */
function fakeApi(input: {
  readonly conversations?: readonly ConversationSummary[];
  readonly createFails?: boolean;
  readonly listFails?: boolean;
  /** Stands in for the conversation already on screen. */
  readonly openId?: string | null;
}) {
  const calls: string[] = [];
  const api = {
    async listConversations() {
      calls.push("list");
      if (input.listFails) throw new Error("database is locked");
      return [...(input.conversations ?? [])];
    },
    async createConversation({ mode }: { mode: Mode }) {
      calls.push(`create:${mode}`);
      if (input.createFails) throw new Error("disk full");
      return { id: "new-1", mode, title: null, workspace: null, model: null, providerId: null } as never;
    },
    async deleteConversation(id: string) {
      calls.push(`delete:${id}`);
    },
  };
  return { api: api as unknown as Pick<HostApi, "listConversations" | "createConversation" | "deleteConversation">, calls };
}

async function press(input: {
  readonly conversations?: readonly ConversationSummary[];
  readonly mode?: Mode;
  readonly createFails?: boolean;
  readonly listFails?: boolean;
  /** Stands in for the conversation already on screen. */
  readonly openId?: string | null;
}) {
  const { api, calls } = fakeApi(input);
  const opened: string[] = [];
  // Which conversation the window is showing. Defaults to the one being
  // reused, because "press New chat again" is the case the notice exists for;
  // `openId` overrides it to stand in for having navigated away.
  const openId: string | null = input.openId ?? null;
  const outcome = await startNewChat({
    api,
    mode: input.mode ?? "chat",
    nameOf: (mode) => MODE_NAMES[mode],
    isOpen: (id) => id === openId,
    open: async (id) => {
      calls.push(`open:${id}`);
      opened.push(id);
    },
  });
  return { outcome, calls, opened };
}

describe("pressing New chat", () => {
  it("gives a fresh draft", async () => {
    const { outcome } = await press({});
    expect(outcome.draftReset).toBe(true);
  });

  /**
   * The bug this replaced. Reuse is the *common* path -- there is almost always
   * an empty chat to reuse -- and the draft reset only ever happened on the
   * branch that created something, so the composer kept the text from the chat
   * the user had just left.
   */
  it("gives a fresh draft when it reuses an empty chat", async () => {
    const { outcome, opened } = await press({
      conversations: [summary({ id: "empty-1", messageCount: 0 })],
      openId: "empty-1",
    });
    expect(opened).toEqual(["empty-1"]);
    expect(outcome.conversationId).toBe("empty-1");
    expect(outcome.draftReset).toBe(true);
    // Reusing the chat that was already open is the no-op the user needs to be
    // told about.
    expect(outcome.alreadyOnNewChat).toBe(true);
  });

  it("does not claim a no-op when it reuses a blank chat the user had left", async () => {
    // Same reuse, but the window was showing something else, so the press did
    // change what is on screen and must not say otherwise.
    const { outcome } = await press({
      conversations: [summary({ id: "empty-1", messageCount: 0 })],
      openId: "some-other-chat",
    });
    expect(outcome.conversationId).toBe("empty-1");
    expect(outcome.alreadyOnNewChat).toBe(false);
  });

  it("does not claim a no-op when it creates a chat", async () => {
    const { outcome } = await press({});
    expect(outcome.alreadyOnNewChat).toBeUndefined();
  });

  it("keeps the mode the user is in", async () => {
    const { calls } = await press({ mode: "code" });
    expect(calls).toContain("create:code");
  });

  /**
   * The bug this replaced. Creating a conversation and opening one are not the
   * same act, and only the second one changes what the user is looking at.
   * `open` was called on the reuse branch alone, so pressing New chat with no
   * empty chat to reuse wrote a row and then left the previous conversation and
   * its messages on screen: the button looked broken, and repeated presses
   * quietly accumulated empty chats in the sidebar.
   */
  it("opens the chat it creates, so the view follows the press", async () => {
    const { outcome, opened } = await press({});
    expect(opened).toEqual(["new-1"]);
    expect(outcome.conversationId).toBe("new-1");
  });

  it("opens exactly one chat on either path", async () => {
    // Reuse already opened, and then opening the created one as well would be a
    // second history load for the same result.
    const reused = await press({ conversations: [summary({ id: "empty-1", messageCount: 0 })] });
    expect(reused.opened).toEqual(["empty-1"]);

    const created = await press({});
    expect(created.opened).toHaveLength(1);
  });

  it("opens the chat before reporting success, so the view is never behind", async () => {
    const { calls } = await press({});
    expect(calls.indexOf("open:new-1")).toBeGreaterThan(calls.indexOf("create:chat"));
  });

  it("keeps the mode when it reuses a chat", async () => {
    // The reused chat is looked up per mode, so a Code empty chat is never
    // handed to a Chat user.
    const { outcome, calls } = await press({
      mode: "code",
      conversations: [summary({ id: "code-empty", mode: "code", messageCount: 0 })],
    });
    expect(outcome.conversationId).toBe("code-empty");
    expect(calls).not.toContain("create:code");
  });

  it("never reopens a chat that has messages", async () => {
    // This used to assert the opposite, and the opposite was the bug: pressing
    // New chat returned the user's previous conversation, so the press changed
    // nothing and the button read as dead. Restoring the last chat is what
    // startup does; starting a new one must not do it.
    const { outcome, opened } = await press({
      conversations: [summary({ id: "real-1", messageCount: 4 })],
    });
    expect(opened).toEqual(["new-1"]);
    expect(outcome.conversationId).toBe("new-1");
    expect(opened).not.toContain("real-1");
  });

  it("creates a blank chat when a real one is also present", async () => {
    // With a real chat around, the startup picker hands back that chat, and
    // reuse is not available -- so the press must create. The old code reused
    // the "recent" pick and the button did nothing.
    const { outcome, opened, calls } = await press({
      conversations: [
        summary({ id: "empty-1", messageCount: 0 }),
        summary({ id: "real-1", messageCount: 4 }),
      ],
    });
    expect(calls).toContain("create:chat");
    expect(outcome.conversationId).toBe("new-1");
    expect(opened).toEqual(["new-1"]);
  });

  it("still prunes the surplus blank when it has to create", async () => {
    // A leftover blank is tidied up either way, or repeated presses in this
    // state would leave a growing pile of identical empty rows behind.
    const { calls } = await press({
      conversations: [
        summary({ id: "empty-1", messageCount: 0 }),
        summary({ id: "empty-2", messageCount: 0 }),
        summary({ id: "real-1", messageCount: 4 }),
      ],
    });
    expect(calls).toContain("delete:empty-2");
  });

  it("does not stack blanks when a real chat is present", async () => {
    // The create path, repeated. This is the shape the bug took: the press
    // created a row while the old blank stayed put, so a user who pressed it
    // repeatedly collected identical empty chats.
    const { api, calls } = fakeApi({
      conversations: [summary({ id: "empty-1", messageCount: 0 }), summary({ id: "real-1", messageCount: 4 })],
    });
    const opened: string[] = [];
    await startNewChat({
      api,
      mode: "chat",
      nameOf: () => "Chat",
      isOpen: () => false,
      open: async (id) => {
        calls.push(`open:${id}`);
        opened.push(id);
      },
    });
    // One press creates exactly one row. The stale blank is neither reused nor
    // re-created, so the next press cannot find a blank to stack onto either.
    expect(calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(opened).toEqual(["new-1"]);
  });

  it("does not stack blanks", async () => {
    const { calls } = await press({
      conversations: [
        summary({ id: "empty-1", messageCount: 0 }),
        summary({ id: "empty-2", messageCount: 0 }),
        summary({ id: "empty-3", messageCount: 0 }),
      ],
    });
    expect(calls.filter((call) => call.startsWith("delete:"))).toHaveLength(2);
  });

  /**
   * The failure mode that made this button dangerous: a failed press called
   * `setFatal`, which replaced the window with "Atomic could not start" and
   * threw away a conversation that was on screen and fine.
   */
  it("reports a failure without ending up anywhere", async () => {
    const { outcome, opened } = await press({ createFails: true });
    expect(outcome.error).toMatch(/Could not start a new Chat conversation/);
    expect(outcome.error).toMatch(/disk full/);
    expect(outcome.conversationId).toBeNull();
    expect(opened).toEqual([]);
  });

  it("names the mode that failed to start", async () => {
    const { outcome } = await press({ mode: "code", createFails: true });
    expect(outcome.error).toMatch(/new Code conversation/);
  });

  /**
   * Losing the draft is a second punishment for one failed request, and the one
   * the user actually notices: they would have to retype their question.
   */
  it("keeps the draft when the press fails", async () => {
    const { outcome } = await press({ createFails: true });
    expect(outcome.draftReset).toBe(false);
  });

  it("still starts a chat when listing the existing ones fails", async () => {
    // Listing is a convenience, not a prerequisite. Failing to read the list
    // should cost you the reuse, not the button.
    const { outcome, calls } = await press({ listFails: true });
    expect(calls).toContain("create:chat");
    expect(outcome.conversationId).toBe("new-1");
    expect(outcome.error).toBeUndefined();
  });

  it("does not fail the press over a leftover blank it could not delete", async () => {
    const { outcome } = await press({
      conversations: [summary({ id: "empty-1" }), summary({ id: "empty-2" })],
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.conversationId).toBe("empty-1");
  });
});
