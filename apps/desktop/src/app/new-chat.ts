/**
 * What pressing "New chat" does, apart from the React.
 *
 * Extracted because the three things it has to get right are all easy to get
 * wrong in a component and impossible to check in one: a fresh draft, the mode
 * kept, and a failure reported against the button rather than as a dead app.
 */

import type { ConversationSummary, HostApi, Mode } from "@atomic/core";
import { pickConversationForMode } from "@atomic/core";

export interface NewChatOutcome {
  /** The chat now open. `null` when the press failed. */
  readonly conversationId: string | null;
  /** Whether the composer must be remounted to start from empty. */
  readonly draftReset: boolean;
  /** Set when the press failed. The caller shows it; it is not a launch failure. */
  readonly error?: string;
}

export interface NewChatDeps {
  readonly api: Pick<HostApi, "listConversations" | "createConversation" | "deleteConversation">;
  readonly mode: Mode;
  /**
   * Make a conversation the open one, loading its history.
   *
   * Called on *both* paths. It used to be called only when reusing, on the
   * reasoning that a conversation this function had just created needed no
   * loading -- which is true, and irrelevant: the app has to be told which
   * conversation is open, and nothing was. Pressing New chat with no empty chat
   * to reuse created a row and then left the previous conversation and its
   * messages on screen, so the button appeared to do nothing while quietly
   * growing a list of empty chats. Opening here rather than returning the id
   * for the caller to act on keeps the sequencing in one place.
   */
  readonly open: (conversationId: string) => Promise<void>;
  readonly nameOf: (mode: Mode) => string;
}

/**
 * Start a blank chat in the current mode.
 *
 * Reuses the newest empty chat when there is one, so pressing the button three
 * times does not leave three identical rows. The draft is reset either way: the
 * reuse path is the *common* path, and it is exactly the path that used to leave
 * the composer's contents behind, because the reset only ever happened on the
 * branch that created something.
 */
export async function startNewChat(deps: NewChatDeps): Promise<NewChatOutcome> {
  const { api, mode } = deps;
  try {
    const all = await api.listConversations().catch(() => []);
    const { reuse, prune } = pickConversationForMode(all, mode);
    for (const id of prune) {
      // Best effort: a leftover row is untidy, not worth failing a press over.
      await api.deleteConversation(id).catch(() => undefined);
    }
    if (reuse) {
      await deps.open(reuse.id);
      return { conversationId: reuse.id, draftReset: true };
    }
    const created = await api.createConversation({ mode });
    // See `open`: the created chat has to become the open one, not merely exist.
    await deps.open(created.id);
    return { conversationId: created.id, draftReset: true };
  } catch (error) {
    // The mode is named because "new chat" means something different in Code
    // than in Chat, and a message that does not say which one is ambiguous.
    return {
      conversationId: null,
      // No reset on failure: a user who typed something and hit a transient
      // error should not have to retype it, and a remount here would throw the
      // draft away to punish a failed request.
      draftReset: false,
      error: `Could not start a new ${deps.nameOf(mode)} conversation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
