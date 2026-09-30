/**
 * Resolving "which model should this mode actually use".
 *
 * The settings store holds either a concrete model id the user picked, or the
 * `AUTO_MODEL` sentinel meaning "work it out from the catalog". The distinction
 * matters: an explicit choice is never overwritten by a re-resolve, a catalog
 * refresh, or a provider change. Only a mode that is on Auto follows the
 * ranking.
 */

import type { ModelInfo } from "./provider.js";
import {
  selectAutoModelAcrossProviders,
  type CrossProviderAutoSelection,
  type ScoredCandidate,
  type ScoredModel,
} from "./model-ranking.js";
import { checkModelPolicy, type PolicyDecision } from "./free-policy.js";
import type { ProviderDefinition } from "../providers/registry.js";
import type { Mode } from "../settings/schema.js";

/** One model's catalog entry, together with the provider that actually serves it. */
export interface ProviderModel {
  readonly provider: ProviderDefinition;
  readonly model: ModelInfo;
}

/** Sentinel stored in settings when the user has not pinned a model. */
export const AUTO_MODEL = "auto";

/** Label for the dropdown row. The resolved name is appended by the UI. */
export const AUTO_MODEL_LABEL = "Auto (best free)";

export function isAutoModel(value: string | null | undefined): boolean {
  return !value || value === AUTO_MODEL;
}

export interface ResolveInput {
  /** The value from settings: a model id, `auto`, or empty. */
  readonly configured: string | null | undefined;
  /** The provider the *pinned* model belongs to. */
  readonly provider: ProviderDefinition;
  /**
   * Every model to choose from, each tagged with the provider serving it.
   *
   * A flat list of ids cannot work once Auto may cross providers: the same id
   * can exist on two providers, and a fallback chosen from a different provider
   * has to be *sent* to that provider. The pairing is therefore part of the
   * input, not looked up afterwards.
   *
   * `catalog` is kept for the single-provider case, which is what almost every
   * caller has, and is folded into `candidates` below.
   */
  readonly candidates?: readonly ProviderModel[];
  readonly catalog?: readonly ModelInfo[];
  readonly onlyFree: boolean;
  readonly mode: Mode;
  readonly now?: number;
  /**
   * The provider whose model will be tried first, for fallback ordering.
   *
   * Normally the resolved model's own provider, but the host passes it
   * explicitly because for a cross-provider Auto pick the winner's provider is
   * not known until after the ranking runs.
   */
  readonly avoidProviderId?: string;
}

export interface ResolvedModel {
  /** The id to send to the provider. Empty when nothing could be resolved. */
  readonly model: string;
  /**
   * The provider that serves `model`.
   *
   * Not the mode's provider: Auto ranks across every configured provider, so the
   * winner may be served by a different one, and sending it to the mode's
   * provider would either 404 or, worse, quietly reach a same-named model that
   * is charged.
   */
  readonly providerId: string;
  /** `true` when the model came from the ranking rather than a pinned choice. */
  readonly auto: boolean;
  /** Full ranking result, for the UI and the fallback list. */
  readonly selection: CrossProviderAutoSelection | null;
  /** `true` when a pinned model is no longer in the catalog. */
  readonly missingFromCatalog: boolean;
  /**
   * Whether this model may run under the user's free-only policy.
   *
   * Always present, for pinned and automatic choices alike. A pinned model used
   * to be returned without ever being checked, which meant the policy held for
   * Auto and silently did nothing for everyone who picked a model by hand.
   */
  readonly policy: PolicyDecision;
}

/**
 * Resolve the model for a mode.
 *
 * A pinned model is returned as-is even if the catalog cannot be reached: the
 * user chose it, and silently switching models because a refresh failed would be
 * worse than the failure. A pinned model that *is* missing from a catalog we
 * successfully fetched is reported, so the UI can say so, but still used.
 */
export function resolveModelForMode(input: ResolveInput): ResolvedModel {
  const candidates =
    input.candidates ??
    (input.catalog ?? []).map((model) => ({ provider: input.provider, model }));
  const selection = selectAutoModelAcrossProviders(candidates, {
    mode: input.mode,
    onlyFree: input.onlyFree,
    ...(input.now !== undefined ? { now: input.now } : {}),
    // The fallbacks this produces are walked *after* the chosen model fails, so
    // they are ordered to change provider first. Set here rather than left to
    // each caller: forgetting it produces a fallback list that keeps retrying the
    // provider that just refused, which is the one that cannot work.
    ...(input.avoidProviderId ? { avoidProviderId: input.avoidProviderId } : {}),
  });

  if (!isAutoModel(input.configured)) {
    const pinned = input.configured as string;
    // Matched on provider *and* id. A model id is only unique within the
    // provider that serves it, so looking it up across the whole merged list
    // can find a same-named model on another provider and check its price --
    // pricing the wrong thing, or clearing a pin because an unrelated provider
    // happens to share the name.
    const known = candidates.find(
      (entry) => entry.provider.id === input.provider.id && entry.model.id === pinned,
    );
    return {
      model: pinned,
      providerId: input.provider.id,
      auto: false,
      selection,
      missingFromCatalog: candidates.length > 0 && !known,
      // With no catalog to check against, the pin is honoured. Refusing a model
      // we cannot price would break the user every time the network hiccuped.
      policy: known
        ? checkModelPolicy(known.model, known.provider, { onlyFree: input.onlyFree })
        : { kind: "allowed" },
    };
  }

  const chosen = selection.chosen;
  return {
    model: chosen?.candidate.model.id ?? "",
    // Recorded from the winning entry rather than assumed to be the mode's
    // provider. Auto is allowed to cross providers now, so the provider the
    // model is actually served by is the only correct one.
    providerId: chosen?.candidate.provider.id ?? input.provider.id,
    auto: true,
    selection,
    missingFromCatalog: false,
    // Auto already ranks under the policy, so this is a second, cheap look
    // rather than a new rule: it also catches a model the ranking was told
    // about by a catalog that has since gone stale.
    policy: chosen
      ? checkModelPolicy(chosen.candidate.model, chosen.candidate.provider, {
          onlyFree: input.onlyFree,
        })
      : { kind: "allowed" },
  };
}

/** Short "why this model" lines for the settings panel. */
export function explainSelection(
  chosen: ScoredModel | ScoredCandidate | null,
  limit = 3,
): readonly { readonly label: string; readonly detail: string }[] {
  if (!chosen) return [];
  return chosen.factors.slice(0, limit).map((factor) => ({
    label: factor.label,
    detail: factor.detail,
  }));
}
