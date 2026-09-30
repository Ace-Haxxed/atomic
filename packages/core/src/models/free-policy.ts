/**
 * The free-only policy, in one place, for every path that can pick a model.
 *
 * The rule exists because "free" is the promise the whole app makes, and a
 * promise that only holds on one code path is not a promise. Auto-selection was
 * the first path and it is guarded; pinning a model in the dropdown is the
 * second, and it used to sail straight past the policy. So the decision lives
 * here, and both ask it the same question.
 *
 * Three outcomes, not two, because conflating them is what produced the original
 * bug:
 *
 *  - `allowed`: nothing to ask.
 *  - `confirm`: the user may legitimately want this, but they cannot have it by
 *    accident. A paid model, or one whose price nobody has published. Both are
 *    real choices -- some people would rather pay -- so this is a question, not
 *    a refusal, and it must be answered per model rather than by flipping a
 *    global switch nobody remembers turning on.
 *  - `blocked`: nobody can answer their way out of this. A model Atomic has
 *    called and been refused is not going to work because the user agreed to
 *    try it, and offering a confirmation here would be a lie.
 */

import { freenessFor, type Freeness } from "./freeness.js";
import type { ModelInfo } from "./provider.js";
import type { ProviderDefinition } from "../providers/registry.js";
import type { Usage } from "./types.js";

/**
 * Thrown when a turn is refused by the policy.
 *
 * A distinct type because the UI has to do two different things with it: a
 * `confirm` is a question, answered by re-sending with `allowPaidModel`, and a
 * `blocked` is not a question at all. Rendering both as a red banner is what
 * made the original credential error so confusing.
 */
export class FreePolicyError extends Error {
  readonly model: string;
  readonly decision: "confirm" | "blocked";
  readonly detail: string;

  constructor(
    message: string,
    input: {
      model: string;
      kind: "confirm" | "blocked";
      reason: string;
    },
  ) {
    super(message);
    this.name = "FreePolicyError";
    this.model = input.model;
    this.decision = input.kind;
    this.detail = input.reason;
  }
}

export type PolicyDecision =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "confirm";
      /** Why the user is being asked, in their terms. */
      readonly reason: string;
      readonly freeness: "paid" | "unknown";
    }
  | { readonly kind: "blocked"; readonly reason: string };

export interface FreePolicy {
  /**
   * When true, anything that is not known to be free has to be agreed to
   * before it runs. This is the "Free models only" switch, and it defaults on:
   * an app that quietly spends money is worse than one that occasionally asks.
   */
  readonly onlyFree: boolean;
  /**
   * What a real call in this session showed, when it showed anything.
   *
   * Preferred over any published price, in both directions. A price is a claim
   * about a model; a completed request is evidence about it, and it is the only
   * evidence that covers this session. `unknown` is an observation too -- "the
   * call went through and nobody could say what it cost" -- and it counts
   * against the model rather than in its favour, because a free-only policy is
   * a promise not to spend, not a hope.
   *
   * Session-scoped on purpose. What one provider billed today is not a property
   * of the model, and writing it into the catalog would outlive the reason.
   */
  readonly observed?: ObservedCost | undefined;
}

/** A turn's observed cost, when the turn showed one. */
export type ObservedCost = "free" | "paid" | "unknown";

/**
 * May this model run under this policy?
 *
 * Deliberately not cached or memoised: it is cheap, and a stale answer here
 * would be a stale answer about money.
 */
export function checkModelPolicy(
  model: ModelInfo,
  provider: ProviderDefinition,
  policy: FreePolicy,
): PolicyDecision {
  // Checked before the price, because no price matters if the call cannot be
  // made at all.
  if (model.unavailableInAtomic) {
    return {
      kind: "blocked",
      reason: model.unavailableInAtomic.reason,
    };
  }

  if (!policy.onlyFree) return { kind: "allowed" };

  if (policy.observed === "free") return { kind: "allowed" };
  if (policy.observed === "paid") {
    return {
      kind: "confirm",
      freeness: "paid",
      reason: `${model.name} was charged on a real call earlier in this session, so using it costs money.`,
    };
  }
  if (policy.observed === "unknown") {
    return {
      kind: "confirm",
      freeness: "unknown",
      reason: `A real call to ${model.name} finished without reporting what it cost, so Atomic cannot promise it was free.`,
    };
  }

  const detail = freenessFor(provider, model);
  switch (detail.freeness) {
    case "free":
    case "free-tier":
      return { kind: "allowed" };
    case "paid":
      return {
        kind: "confirm",
        freeness: "paid",
        reason: `${model.name} is charged per token, so using it costs money.`,
      };
    default:
      return {
        kind: "confirm",
        freeness: "unknown",
        reason: `Nobody has published a price for ${model.name}, so Atomic cannot tell whether it costs anything.`,
      };
  }
}

/**
 * What a turn actually cost, in dollars, from a model's published prices.
 *
 * Returns `null` when the price is unknown rather than guessing zero. A zero
 * would read as "free" and quietly defeat the policy this module exists to
 * enforce -- an unpriced model is exactly the case that needs the guard most.
 */
export function turnCost(
  model: ModelInfo,
  usage: Pick<Usage, "inputTokens" | "outputTokens">,
): number | null {
  const cost = model.cost;
  if (!cost) return null;
  const { input, output } = cost;
  if (typeof input !== "number" || typeof output !== "number") return null;
  return (usage.inputTokens * input + usage.outputTokens * output) / 1_000_000;
}

/**
 * What a finished step's cost review concluded.
 *
 * A union, not a string, because "the run must stop" and "the user should read
 * this" are different things and the UI treats them differently. A step that
 * succeeded on a free model with no published price is a note; a step that was
 * actually charged is a refusal.
 */
export type TurnCostReview =
  | {
      readonly ok: true;
      readonly note?: string | undefined;
      /**
       * What this turn actually proved, for the session's observed-cost memory.
       *
       * Not merely "it was allowed". A turn whose price nobody could work out
       * proved nothing about cost, and recording it as free is how a model
       * Atomic has only ever *assumed* free ends up treated as known free for
       * the rest of the session -- so the user stops being asked about it on the
       * strength of an absence of evidence.
       */
      readonly observed?: ObservedCost | undefined;
    }
  | { readonly ok: false; readonly reason: string; readonly cost: number | null };

/**
 * The check that runs after a turn, on the number the provider actually billed.
 *
 * Prices are published per million tokens and can be wrong, stale, or describe
 * a tier the user is not on. A turn that came back more expensive than the
 * catalog claimed is therefore treated as evidence rather than as a rounding
 * error: the response is stopped and the user is told, because at that point
 * the alternative is discovering it on an invoice.
 */
export function reviewTurnCost(input: {
  readonly model: ModelInfo;
  readonly usage: Pick<Usage, "inputTokens" | "outputTokens">;
  readonly policy: FreePolicy;
  /** Charged by the provider for this turn, when it reports one. */
  readonly providerReportedCost?: number | undefined;
  /**
   * How the provider and catalog classify this model, when they could.
   *
   * Required for the "unpriced but known free" case, which is the whole point:
   * many genuinely free models publish no per-token price at all, so "no price"
   * and "no cost" are indistinguishable from the number alone. Without this the
   * guard stopped a turn *after* it had already succeeded on a model the same
   * policy had just allowed -- the user paid nothing, read a refusal, and had no
   * way to tell those apart from a model that had charged them.
   */
  readonly freeness?: Freeness | undefined;
}): TurnCostReview {
  const { model, usage, policy } = input;
  // Kept apart on purpose. One of these is a number a provider reported for
  // this turn; the other is a published price multiplied by token counts. They
  // are not the same kind of claim, and conflating them is what made the toggle
  // for "free only" stop working.
  const billed = input.providerReportedCost;
  const estimated = billed ?? turnCost(model, usage);

  /*
   * A reported charge is a fact, but a fact is not automatically a reason to
   * stop. It stops the turn when either of two things is true:
   *
   *  - the free-only policy is on, in which case any cost at all is the thing
   *    the user asked to be protected from; or
   *  - the model was classified free or free-tier, in which case being charged
   *    is a broken promise rather than a bill, and the user chose this model
   *    *because* it was free.
   *
   * With the policy off and a model the user picked knowing it was paid, a
   * charge is the expected outcome and the turn completes. Stopping there made
   * paid models unreachable however the user configured them -- the same bug as
   * the estimate branch below, reached by a different route.
   */
  const classifiedFree = input.freeness === "free" || input.freeness === "free-tier";
  if (billed !== undefined && billed > 0 && (policy.onlyFree || classifiedFree)) {
    return {
      ok: false,
      cost: billed,
      reason: classifiedFree
        ? `${model.name} is classified as free but reported a charge of $${billed.toFixed(4)} for that turn. The turn was stopped.`
        : `${model.name} reported a charge of $${billed.toFixed(4)} for that turn. The turn was stopped because free-only is on.`,
    };
  }

  /*
   * A catalog price is a calculation, not an observation, so it is the policy's
   * business rather than the guard's. This branch used to fire on any positive
   * estimate, which quietly made the free-only toggle a no-op: the paid models
   * it was supposed to allow could never run, and a user who had explicitly
   * turned it off had no way to spend money on purpose.
   */
  if (estimated !== null && estimated > 0 && policy.onlyFree) {
    return {
      ok: false,
      cost: estimated,
      reason: `${model.name} cost about $${estimated.toFixed(4)} for that turn, so it is not free. The turn was stopped because free-only is on.`,
    };
  }

  if (estimated === null) {
    // Unpriced. A model the catalog and provider both call free is the common
    // case and gets a note rather than a refusal: the user is told the price is
    // unknown, and told the model is classified free, and the answer stays.
    //
    // An unclassified model gets no note at all. It was already asked about
    // before the turn by `checkModelPolicy`, so the user has agreed to it once;
    // announcing the same uncertainty again after a successful reply is noise,
    // and the uncertainty is the reason they were asked.
    if (policy.onlyFree && (input.freeness === "free" || input.freeness === "free-tier")) {
      return {
        ok: true,
        note: `${model.name} does not publish a per-token price, so Atomic cannot price this turn. It is classified as free, and this turn reported no charge.`,
        // No observation. "We could not price it" is not "it was free", and
        // treating it as one means the next turn skips the question the user
        // still has no basis to skip.
        observed: undefined,
      };
    }
    return { ok: true, observed: undefined };
  }

  // A number, and a zero one. That is the only thing that proves a model is
  // free, so it is the only case that gets remembered.
  return { ok: true, observed: estimated === 0 ? "free" : undefined };
}
