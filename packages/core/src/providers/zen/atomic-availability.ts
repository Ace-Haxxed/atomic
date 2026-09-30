/**
 * What Atomic has learned, from real traffic, about which models it can reach.
 *
 * The problem this exists for: OpenCode Zen lists models that are free on paper
 * but that its own client is entitled to and other clients are not. Asked for
 * one of those, Zen answers `403` with a `FreeTierError` saying the free tier
 * "can only be used from within OpenCode". `big-pickle` is the confirmed case.
 *
 * Why this is learned rather than listed: a hardcoded exception is a guess about
 * one model on one day. The gate could be lifted, or extended to models nobody
 * has tried yet, and a hardcoded list would be wrong in both directions without
 * anyone noticing. Recording what actually happened is both more accurate and
 * self-correcting -- a model that starts working is discovered the next time it
 * is called.
 *
 * Two facts are recorded, and they are not the same fact:
 *
 *  - `blocked`: Atomic called it and was refused, repeatedly. Excluded from
 *    automatic selection, because picking a model we already know is refused
 *    wastes a round trip and shows the user an error they can do nothing about.
 *  - `reachable`: Atomic called it with no credential and got a real answer.
 *    Preferred among otherwise-equal free models, because "free" is a claim
 *    about price and this is evidence about whether we can actually use it.
 *
 * Why one refusal is not enough to block
 * --------------------------------------
 * An earlier build recorded a block on the *first* `FreeTierError`. That is the
 * wrong conclusion from a single observation, and `space-bunny-free` is the
 * proof: it was marked unusable by one 403, the user was told it was
 * unavailable, and minutes later the same model answered 200 unauthenticated.
 * One failure is a moment, not a fact about the model -- a proxy hiccup, a
 * gateway hiccup, or a single request that hit a different backend all produce
 * the same 403.
 *
 * So a refusal is now *counted*. The first one makes the model `suspect`: still
 * out of automatic rotation (so the same call is not repeated forever), but
 * visibly not a verdict, and the user can retry it. The second, from a separate
 * request, confirms it. Only `blocked` -- confirmed twice -- is treated as
 * settled anywhere in the UI or the ranking.
 *
 * Both are keyed by model id and cached, and both are discarded on a catalog
 * refresh -- see `invalidateAtomicAvailability` for why.
 */

import type { ModelInfo } from "../../models/provider.js";

/** What one real call taught us. */
export interface AtomicAvailabilityMark {
  /** ISO timestamp of the observation. */
  readonly since: string;
  /** The provider's own words, trimmed. Shown to the user. */
  readonly reason: string;
  /**
   * Refusals so far, on a `suspect` entry. Absent once confirmed, because at
   * that point the count has stopped mattering.
   */
  readonly count?: number;
}

export interface AtomicAvailability {
  /** Model id -> refused, with the reason the provider gave. */
  readonly blocked: Readonly<Record<string, AtomicAvailabilityMark>>;
  /**
   * Model id -> refused once. Kept apart from `blocked` because a single
   * refusal is a suspicion, not a conclusion; see the note above.
   */
  readonly suspect: Readonly<Record<string, AtomicAvailabilityMark>>;
  /** Model ids that answered a real request made without any credential. */
  readonly reachable: readonly string[];
}

export const EMPTY_AVAILABILITY: AtomicAvailability = { blocked: {}, suspect: {}, reachable: [] };

/**
 * Refusals needed before a model is treated as unusable.
 *
 * Two, not one: the cost of being wrong in the other direction -- a free model
 * written off because of a single bad response, and never retried -- is higher
 * than the cost of one wasted request. One is not enough evidence, and the
 * confirmed case for that is a model that was blocked by one 403 and then
 * worked.
 */
export const REFUSALS_TO_CONFIRM = 2;

/**
 * Does this failure mean "Atomic may not use this model", as opposed to
 * "your key is wrong" or "this model is off for you"?
 *
 * The message is matched as well as the status. A bare 403 is ambiguous -- Zen
 * uses it both for a model a workspace has disabled (fixable by an admin) and
 * for the free-tier gate (fixable by nobody) -- and treating the two the same
 * sends users to do something that cannot work.
 */
export function isAtomicGated(failure: {
  status?: number;
  message: string;
}): boolean {
  if (failure.status !== 403) return false;
  return (
    /free tier can only be used from within OpenCode/i.test(failure.message) ||
    /FreeTierError/i.test(failure.message)
  );
}

/**
 * Record a refusal.
 *
 * The first one marks the model `suspect`; only from the second onwards is it
 * `blocked`. Either way a success at any point clears both, so a model that
 * works is never left carrying a stale count.
 *
 * A `reason` given alongside the count means the refusal is being confirmed
 * deliberately -- by an explicit user retry that has already failed, rather than
 * by a fresh independent attempt.
 */
export function markBlocked(
  availability: AtomicAvailability,
  modelId: string,
  reason: string,
  since = new Date().toISOString(),
): AtomicAvailability {
  return {
    reachable: availability.reachable.filter((id) => id !== modelId),
    blocked: availability.blocked,
    suspect: markSuspect(availability, modelId, reason, since).suspect,
  };
}

/**
 * Count one refusal, promoting the model to `blocked` once there are enough.
 *
 * Returns the updated availability rather than a boolean so the caller has to
 * decide what to persist -- and a caller that persists nothing on the first
 * refusal is the bug this shape exists to prevent.
 */
export function markSuspect(
  availability: AtomicAvailability,
  modelId: string,
  reason: string,
  since = new Date().toISOString(),
): AtomicAvailability {
  const mark: AtomicAvailabilityMark = { since, reason: trim(reason) };
  // A model already confirmed blocked stays blocked; re-counting it would let a
  // stale entry drift back to "suspect" if two maps were ever merged.
  if (modelId in availability.blocked) {
    return {
      blocked: availability.blocked,
      suspect: omit(availability.suspect, modelId),
      reachable: availability.reachable.filter((id) => id !== modelId),
    };
  }
  const counted = (availability.suspect[modelId]?.count ?? 0) + 1;
  const suspect = omit(availability.suspect, modelId);
  if (counted >= REFUSALS_TO_CONFIRM) {
    return {
      blocked: { ...availability.blocked, [modelId]: mark },
      suspect,
      reachable: availability.reachable.filter((id) => id !== modelId),
    };
  }
  return {
    blocked: availability.blocked,
    suspect: { ...suspect, [modelId]: { ...mark, count: counted } },
    reachable: availability.reachable.filter((id) => id !== modelId),
  };
}

/** Record a model that answered a real unauthenticated call. */
export function markReachable(
  availability: AtomicAvailability,
  modelId: string,
): AtomicAvailability {
  if (availability.reachable.includes(modelId)) return availability;
  // Any success clears both the suspicion and the block. The gate can be lifted,
  // and a model that works is not one the app should keep arguing with.
  return {
    blocked: omit(availability.blocked, modelId),
    suspect: omit(availability.suspect, modelId),
    reachable: [...availability.reachable, modelId],
  };
}

function omit<T extends object>(map: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!(key in map)) return { ...map };
  const { [key]: _dropped, ...rest } = map;
  return rest;
}

function trim(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Attach the learned facts to a catalog entry so the UI and ranking can see them. */
export function applyAvailability(
  model: ModelInfo,
  availability: AtomicAvailability,
): ModelInfo {
  // Both learned fields are cleared before being reapplied. Earlier builds
  // persisted catalogs with the marks already baked in, so a row read today can
  // still carry a block from a run of a version that no longer exists. Spreading
  // the model through and only adding fields would leave that mark in place with
  // nothing left to remove it, and a model the user had already recovered would
  // stay unusable with no way back except clearing the whole cache.
  const {
    unavailableInAtomic: _stale,
    suspectedInAtomic: _staleSuspect,
    verifiedReachable: _staleReach,
    ...rest
  } = model;
  const block = availability.blocked[model.id];
  if (block) {
    return {
      ...rest,
      unavailableInAtomic: { reason: block.reason, since: block.since },
    };
  }
  const suspect = availability.suspect[model.id];
  if (suspect) {
    // Deliberately *not* `unavailableInAtomic`. The UI has to be able to say
    // "refused once, try again" and offer a retry, which it cannot do for a
    // model it has been told is settled.
    return {
      ...rest,
      suspectedInAtomic: { reason: suspect.reason, since: suspect.since, count: suspect.count },
    };
  }
  return {
    ...rest,
    ...(availability.reachable.includes(model.id)
      ? { verifiedReachable: true }
      : {}),
  };
}

/** True when Atomic has evidence that this model cannot be called. */
export function isBlockedInAtomic(
  model: ModelInfo,
  availability: AtomicAvailability,
): boolean {
  return model.id in availability.blocked;
}

/**
 * True when this model has been refused once but not confirmed.
 *
 * Kept separate from `isBlockedInAtomic` because the two lead to opposite UI:
 * one is a greyed-out row with a reason, the other is a row that is still
 * selectable and offers a retry.
 */
export function isSuspectedInAtomic(
  model: ModelInfo,
  availability: AtomicAvailability,
): boolean {
  return !(model.id in availability.blocked) && model.id in availability.suspect;
}

/** True when Atomic has actually completed a call to this model unauthenticated. */
export function isVerifiedReachable(
  model: ModelInfo,
  availability: AtomicAvailability,
): boolean {
  return availability.reachable.includes(model.id);
}

/**
 * Drop everything we have learned.
 *
 * Called when the catalog is force-refreshed. The marks are not evidence that a
 * model is *permanently* unusable -- the gate is OpenCode's to change -- so a
 * refresh is the user saying "check again", and honouring that is the only way
 * a model that has been unblocked can come back. Without this, one observation
 * would disable a model permanently and the user would have no way to undo it.
 */
export function invalidateAtomicAvailability(): AtomicAvailability {
  return EMPTY_AVAILABILITY;
}

/**
 * Make a learned-state row from anywhere safe to read.
 *
 * Rows written by earlier builds predate the `suspect` map, and a row from
 * anywhere may be missing a field. Every reader indexes these maps directly, so
 * a missing one is a crash rather than a default -- the defaults are filled in
 * here, once, at the boundary.
 *
 * A `suspect` entry is also capped at `REFUSALS_TO_CONFIRM`, so a row cannot
 * claim a count that would promote it to blocked without ever passing through
 * the check that does the promoting.
 */
export function normalizeAvailability(value: unknown): AtomicAvailability {
  const row = (value ?? {}) as Partial<AtomicAvailability>;
  return {
    blocked: marks(row.blocked),
    suspect: marks(row.suspect),
    reachable: Array.isArray(row.reachable)
      ? row.reachable.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function marks(value: unknown): Readonly<Record<string, AtomicAvailabilityMark>> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, AtomicAvailabilityMark> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const mark = raw as Partial<AtomicAvailabilityMark>;
    if (typeof mark.reason !== "string" || typeof mark.since !== "string") continue;
    out[id] = {
      reason: trim(mark.reason),
      since: mark.since,
      ...(typeof mark.count === "number" && mark.count > 0
        ? { count: Math.min(Math.floor(mark.count), REFUSALS_TO_CONFIRM) }
        : {}),
    };
  }
  return out;
}
