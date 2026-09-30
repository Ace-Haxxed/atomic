/**
 * What a model costs the user.
 *
 * The four states are the point. Collapsing "unknown" into "not free" would hide
 * a model we simply have no pricing for; collapsing it into "free" would let the
 * auto-selector pick something the user then gets billed for. So a missing or
 * null cost is `unknown`, and `unknown` is never eligible for automatic
 * selection while "only free models" is on.
 *
 * Freeness is decided from provider metadata, never from a list of model names.
 * Names change weekly; costs and documented free tiers do not.
 */

import type { ModelInfo } from "./provider.js";
import type { ProviderDefinition } from "../providers/registry.js";

export const FREENESS = ["free", "free-tier", "paid", "unknown"] as const;
export type Freeness = (typeof FREENESS)[number];

/**
 * Which piece of evidence decided the classification.
 *
 * Kept alongside the verdict because the user has to be able to audit it: "free"
 * on the strength of an exact price is a different claim from "free" on the
 * strength of a word in the name, and a badge that hides which one it was makes
 * both look equally trustworthy.
 */
export const FREENESS_SIGNALS = [
  "cost",
  "published",
  "suffix",
  "local",
  "tier",
  "paid",
  "none",
] as const;
export type FreenessSignal = (typeof FREENESS_SIGNALS)[number];

export interface FreenessDetail {
  readonly freeness: Freeness;
  /** Short, user-facing explanation. Never contains a key or a full env dump. */
  readonly reason: string;
  /** Which signal decided it. See `FREENESS_SIGNALS`. */
  readonly signal: FreenessSignal;
  /** USD per million tokens, when the provider reported it. */
  readonly costPerMillion?: { readonly input: number; readonly output: number };
}

/**
 * Id shapes providers use to say "this one costs nothing".
 *
 * A heuristic, and treated as the third-priority signal for that reason. It is
 * checked last because a name can lie in both directions -- a paid model could
 * be named "...-free" as marketing -- whereas a published price cannot.
 */
const FREE_SUFFIXES = ["-free", ":free", "_free"] as const;

function hasFreeSuffix(id: string): boolean {
  const lower = id.toLowerCase();
  return FREE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Cost that can be trusted.
 *
 * A price of zero is a real, deliberate value; an absent or null field is not.
 * Treating them alike is how a model with no pricing data ends up labelled free
 * and quietly selected.
 */
export function knownCost(
  model: ModelInfo,
): { readonly input: number; readonly output: number } | null {
  const cost = model.cost;
  if (!cost) return null;
  if (!Number.isFinite(cost.input) || !Number.isFinite(cost.output))
    return null;
  return { input: cost.input, output: cost.output };
}

/** Free when the provider bills nothing for both directions. */
function costFreeness(model: ModelInfo, providerLabel: string): FreenessDetail {
  const cost = knownCost(model);
  if (!cost) {
    return {
      freeness: "unknown",
      reason: `${providerLabel} did not report a price for this model.`,
      signal: "none",
    };
  }
  if (cost.input === 0 && cost.output === 0) {
    return {
      freeness: "free",
      reason: `Billed at $0 per million tokens by ${providerLabel}.`,
      signal: "cost",
      costPerMillion: cost,
    };
  }
  return {
    freeness: "paid",
    reason: `$${cost.input}/$${cost.output} per million input/output tokens.`,
    signal: "cost",
    costPerMillion: cost,
  };
}

/**
 * Zen's classification, in strict priority order.
 *
 * 1. A published machine-readable price. `0/0` is free. This is the only
 *    signal that is both authoritative and complete, and it is what identifies
 *    `big-pickle`, whose name says nothing about cost.
 * 2. The provider's own published pricing table, scraped from its docs. Weaker
 *    because it is keyed by display name rather than model id, but it covers
 *    models the feed has not priced yet.
 * 3. A free-looking id suffix.
 * 4. `unknown`, which is never free.
 *
 * The order is the whole point. A `-free` suffix is a naming convention that any
 * provider can adopt without honouring it, so it must never be able to override
 * a real price; but it is still better than `unknown`, because a model with no
 * price at all would otherwise be excluded from free-only selection for the
 * mistake of being unlisted.
 */
function zenFreeness(model: ModelInfo, providerLabel: string): FreenessDetail {
  const cost = knownCost(model);
  if (cost) {
    if (cost.input === 0 && cost.output === 0) {
      return {
        freeness: "free",
        reason: `Billed at $0 per million tokens by ${providerLabel}.`,
        signal: "cost",
        costPerMillion: cost,
      };
    }
    return {
      freeness: "paid",
      reason: `$${cost.input}/$${cost.output} per million input/output tokens.`,
      signal: "cost",
      costPerMillion: cost,
    };
  }

  const published = model.publishedPricing;
  if (published) {
    return published.free
      ? {
          freeness: "free",
          reason: `Listed as free in ${published.source}.`,
          signal: "published",
        }
      : {
          freeness: "paid",
          reason: `Listed with a price in ${published.source}.`,
          signal: "published",
        };
  }

  if (hasFreeSuffix(model.id)) {
    return {
      freeness: "free",
      reason:
        "The provider marks this model free in its name, but has not published a price for it.",
      signal: "suffix",
    };
  }

  return {
    freeness: "unknown",
    reason: `${providerLabel} did not report a price for this model.`,
    signal: "none",
  };
}

/**
 * Local compute. Every model is free to the user because the machine is the
 * user's, and there is no provider to bill.
 */
function localFreeness(providerLabel: string): FreenessDetail {
  return {
    freeness: "free",
    reason: `Runs on your own machine via ${providerLabel}.`,
    signal: "local",
  };
}

/**
 * A provider with a documented free tier but no per-model flag. The tier is
 * rate-limited and can be withdrawn, so it is labelled honestly rather than
 * being called flatly free.
 */
function freeTierFreeness(
  providerLabel: string,
  limitNote: string,
): FreenessDetail {
  return {
    freeness: "free-tier",
    reason: `${providerLabel} offers a free tier (${limitNote}). It is rate-limited.`,
    signal: "tier",
  };
}

/**
 * A free tier, applied only to a model the tier actually covers.
 *
 * The account-level tier is real but it is not a property of a model, and the
 * previous version applied it to every model the provider listed. That produced
 * a "free tier" badge on models with a published price of $15 per million, which
 * is the exact overclaim this avoids: the badge reads as a statement about the
 * model, and on some of them it is false.
 *
 * So a published per-model price wins. $0/$0 is free outright; any other price
 * means this model is billed, and the tier is not extended to cover it. Only when
 * the provider has said nothing about this specific model -- no price either way
 * -- is the account tier the best available evidence, and then the reason says
 * so, because "your account might be in the free tier" is not the same claim as
 * "this model is free".
 */
function tieredFreeness(
  providerLabel: string,
  model: ModelInfo,
  limitNote: string,
): FreenessDetail {
  if (knownCost(model)) {
    const priced = costFreeness(model, providerLabel);
    return {
      ...priced,
      // The price is the finding; the tier is context for it.
      reason: `${priced.reason} ${providerLabel} also offers a free tier (${limitNote}), which this price does not appear to cover.`,
    };
  }
  return freeTierFreeness(providerLabel, limitNote);
}

function paidFreeness(providerLabel: string): FreenessDetail {
  return {
    freeness: "paid",
    reason: `${providerLabel} charges per token. No free tier.`,
    signal: "paid",
  };
}

/** OpenRouter publishes a price string per model; "0" means free. */
function openRouterFreeness(model: ModelInfo): FreenessDetail {
  const pricing = (
    model as { pricing?: { prompt?: unknown; completion?: unknown } }
  ).pricing;
  const prompt =
    typeof pricing?.prompt === "string" ? Number(pricing.prompt) : NaN;
  const completion =
    typeof pricing?.completion === "string" ? Number(pricing.completion) : NaN;
  if (Number.isFinite(prompt) && Number.isFinite(completion)) {
    if (prompt === 0 && completion === 0) {
      return {
        freeness: "free",
        reason: "OpenRouter lists this model at $0.",
        signal: "cost",
      };
    }
    return {
      freeness: "paid",
      reason: `OpenRouter lists $${prompt}/$${completion} per million tokens.`,
      signal: "cost",
    };
  }
  // The `:free` suffix is OpenRouter's own convention for zero-cost routing.
  // Treated as a signal, not proof: it is corroborated by the price check above
  // whenever OpenRouter reports prices at all.
  if (hasFreeSuffix(model.id)) {
    return {
      freeness: "free",
      reason: "OpenRouter marks this model with the :free routing suffix.",
      signal: "suffix",
    };
  }
  return {
    freeness: "unknown",
    reason: "OpenRouter did not report a price for this model.",
    signal: "none",
  };
}

/**
 * Decide what a model costs, for one provider.
 *
 * The provider's own `freeness` policy is authoritative; this function only
 * interprets the data. Providers with a per-model price (Zen, OpenRouter) are
 * decided from it, local providers are free by construction, and the rest fall
 * back to what the provider documents about its free tier.
 */
export function freenessFor(
  provider: ProviderDefinition,
  model: ModelInfo,
): FreenessDetail {
  switch (provider.id) {
    case "opencode-zen":
      return zenFreeness(model, provider.label);
    case "openrouter":
      return openRouterFreeness(model);
    case "ollama":
      return localFreeness(provider.label);
    case "google":
      return tieredFreeness(provider.label, model, "free tier subject to quotas");
    case "groq":
      return tieredFreeness(provider.label, model, "developer free tier");
    case "mistral":
      return tieredFreeness(provider.label, model, "experimental free tier");
    case "anthropic":
    case "openai":
    case "deepseek":
      return paidFreeness(provider.label);
    default:
      // An unknown provider must not be guessed into "free".
      return costFreeness(model, provider.label);
  }
}

/**
 * Whether a model survives the "only auto-select free models" filter.
 *
 * "Unknown" is allowed only when the filter is off, because the user has then
 * said cost is not a constraint. It stays unranked-high in `costScore` so a
 * model with a known price still wins. `selectAutoModel` treats a *free-only*
 * request as requiring a confirmed `free`, so an unknown-priced model is never
 * picked automatically on the user's behalf.
 *
 * `free-tier` is deliberately *not* equal to `free`: a free tier is rate-limited
 * and can be withdrawn without notice, so under a hard free-only guarantee it
 * is not good enough. Users who want it opt out of the guarantee.
 */
export function isFreeEnough(freeness: Freeness, onlyFree: boolean): boolean {
  if (freeness === "free") return true;
  // Everything else is only eligible when the user has switched the free-only
  // filter off, which is the explicit statement that cost is not a constraint.
  return !onlyFree;
}

/** Human label for the dropdown badge. */
export const FREENESS_LABELS: Readonly<Record<Freeness, string>> = {
  free: "free",
  "free-tier": "free tier",
  paid: "paid",
  unknown: "unknown",
};
