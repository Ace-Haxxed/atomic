/**
 * Picking the conversation to open for a mode.
 *
 * The rule is that a blank chat is a resource, not a leftover. Creating one on
 * every launch, and one on every mode switch, buried the user's real chats
 * under a growing pile of empty `Untitled` rows — the list looked like noise and
 * the "new chat" you just made was not the one you got back.
 *
 * So: an empty chat for a mode is reused, extra empty chats are pruned, and only
 * when the mode has nothing at all is a new one created.
 */

import type { ConversationSummary } from "../storage/repositories.js";
import type { Mode } from "../settings/schema.js";

/** A conversation with nothing in it. Pinned chats are never treated as empty. */
export function isEmptyConversation(conversation: ConversationSummary): boolean {
  return conversation.messageCount === 0 && !conversation.pinned;
}

export interface PickConversationResult {
  /** The conversation to open, or `null` when the mode has none. */
  readonly reuse: ConversationSummary | null;
  /** Ids of surplus empty chats to delete. Never includes `reuse`. */
  readonly prune: readonly string[];
  /** Why this conversation was chosen, for the UI's own logging. */
  readonly reason: "empty-reuse" | "recent" | "none";
}

/**
 * Decide what to open for `mode`, given its conversations newest-first.
 *
 * Order matters and is part of the contract: the caller passes the list as
 * `listConversations` returns it (pinned first, then most recently updated), and
 * the newest empty chat is the one worth keeping.
 */
export function pickConversationForMode(
  conversations: readonly ConversationSummary[],
  mode: Mode,
): PickConversationResult {
  const forMode = conversations.filter((conversation) => conversation.mode === mode);

  // Prefer a real chat over a blank one: a conversation with messages is what
  // the user most likely wants back after a restart.
  const withMessages = forMode.find((conversation) => !isEmptyConversation(conversation));
  if (withMessages) {
    return { reuse: withMessages, prune: emptyIds(forMode), reason: "recent" };
  }

  // Nothing but blanks. Keep the newest, drop the rest.
  const empties = forMode.filter(isEmptyConversation);
  const [keep, ...drop] = empties;
  if (keep) {
    return { reuse: keep, prune: drop.map((c) => c.id), reason: "empty-reuse" };
  }

  return { reuse: null, prune: [], reason: "none" };
}

/**
 * Empty chats to clean up at startup, across every mode.
 *
 * Deleting all of them would fight the reuse rule above, so this keeps the
 * newest empty chat per mode and prunes the rest.
 */
export function pruneEmptyConversations(
  conversations: readonly ConversationSummary[],
): readonly string[] {
  const seen = new Set<Mode>();
  const stale: string[] = [];
  // Newest-first per mode, so the first empty seen for a mode is the keeper.
  for (const conversation of conversations) {
    if (!isEmptyConversation(conversation)) continue;
    if (seen.has(conversation.mode)) {
      stale.push(conversation.id);
      continue;
    }
    seen.add(conversation.mode);
  }
  return stale;
}

function emptyIds(conversations: readonly ConversationSummary[]): readonly string[] {
  // Only the surplus is pruned; the caller opens the one it was given.
  const empties = conversations.filter(isEmptyConversation);
  return empties.slice(1).map((conversation) => conversation.id);
}
