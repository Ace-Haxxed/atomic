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
  /**
   * True when this press landed on the blank chat that was *already* open.
   *
   * This is the whole reason the button appeared broken. The reuse path is
   * correct -- it is what stops three presses leaving three identical rows -- but
   * it is a no-op from where the user sits: same chat, same empty transcript,
   * no message anywhere. Every other button in the app changes something on
   * press, so a button that reliably does nothing visible reads as a button that
   * is not connected to anything.
   *
   * The caller shows a brief notice from this. It is not an error: nothing went
   * wrong, the user just asked for a state they were already in.
   */
  readonly alreadyOnNewChat?: boolean;
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
  /**
   * Whether this conversation is the one currently on screen.
   *
   * Needed to tell "reused the blank chat you were already on" from "went back
   * to a blank chat you had left", which look identical from inside this
   * function and are opposite things to show the user.
   */
  readonly isOpen: (conversationId: string) => boolean;
  readonly nameOf: (mode: Mode) => string;
}

/**
 * Start a blank chat in the current mode.
 *
 * Reuses the newest *empty* chat when there is one, so pressing the button three
 * times does not leave three identical rows. The draft is reset either way: the
 * reuse path is the *common* path, and it is exactly the path that used to leave
 * the composer's contents behind, because the reset only ever happened on the
 * branch that created something.
 *
 * Only a blank chat is ever reused. `pickConversationForMode` is a *startup*
 * picker -- it prefers a conversation with messages, because after a restart
 * that is what the user most likely wants back. Reusing its result here is what
 * made the button look broken: with any real conversation in the mode, pressing
 * New chat returned that conversation, so the press changed nothing on screen.
 * Restoring your last chat and starting a new one are opposite intents and have
 * to stay separate.
 */
export async function startNewChat(deps: NewChatDeps): Promise<NewChatOutcome> {
  const { api, mode } = deps;
  try {
    const all = await api.listConversations().catch(() => []);
    const { reuse, prune, reason } = pickConversationForMode(all, mode);
    for (const id of prune) {
      // Best effort: a leftover row is untidy, not worth failing a press over.
      // Runs on the create branch too. Skipping it there left a blank behind on
      // every press made from a mode that also had a real chat -- which is every
      // press a user with a history makes, so the blanks accumulated quietly.
      await api.deleteConversation(id).catch(() => undefined);
    }
    // `empty-reuse` is the only reason that means "there is a blank chat to
    // reuse". `recent` names a conversation with messages, and reusing that here
    // would answer "New chat" with the user's previous conversation.
    if (reuse && reason === "empty-reuse") {
      await deps.open(reuse.id);
      return {
        conversationId: reuse.id,
        draftReset: true,
        // Only worth saying when the chat we landed on is the one already on
        // screen. Landing on a blank chat the user had left behind is a real
        // change, even if it happens to be empty.
        alreadyOnNewChat: deps.isOpen(reuse.id),
      };
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
