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

import { freenessFor } from "./freeness.js";
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
}):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly cost: number | null;
    } {
  const { model, usage, policy } = input;
  const cost = input.providerReportedCost ?? turnCost(model, usage);

  if (cost === null) {
    // Unpriced, and a free-only policy is in force. Nothing can be proven, so
    // the honest answer is to ask rather than to wave it through.
    if (policy.onlyFree) {
      return {
        ok: false,
        cost: null,
        reason: `Atomic cannot tell what ${model.name} costs, so the turn was stopped rather than assumed free.`,
      };
    }
    return { ok: true };
  }

  if (policy.onlyFree && cost > 0) {
    return {
      ok: false,
      cost,
      reason: `${model.name} cost $${cost.toFixed(4)} for that turn, so it is not free. The turn was stopped.`,
    };
  }

  return { ok: true };
}
