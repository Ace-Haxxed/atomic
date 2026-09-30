/**
 * The catalog the whole app reads: every model every configured provider can
 * reach, grouped by provider.
 *
 * This is deliberately a pure layer over data the host has already fetched. The
 * host owns the network and the keychain; this owns the decisions the UI and the
 * dropdowns both need to agree on, so that "free only" cannot mean one thing in
 * the Models tab and another in the header:
 *
 *  - which providers count as configured, and therefore appear at all
 *  - what freeness and capabilities each model is reported as
 *  - how search and the filters narrow the list
 *  - what happens to a pinned model that has disappeared
 *
 * Nothing here fetches, and nothing here sees a key.
 */

import { freenessFor, type Freeness } from "./freeness.js";
import type { ModelInfo } from "./provider.js";
import type { ProviderDefinition } from "../providers/registry.js";
import { PROVIDERS, providerById } from "../providers/registry.js";
import type { Settings, Mode } from "../settings/schema.js";
import { modelFor, modelProviderFor, MODES } from "../settings/schema.js";
import { AUTO_MODEL, isAutoModel } from "./auto-model.js";
import * as ranking from "./model-ranking.js";

/** Why a provider's section looks the way it does. */
export type ProviderStatus = "connected" | "unconfigured" | "unreachable" | "error";

export interface ProviderModels {
  readonly provider: ProviderDefinition;
  /** Models the provider reported, in the provider's own order. */
  readonly models: readonly ModelInfo[];
  /** `cache` means these are from cache and may be out of date. */
  readonly source: "api" | "cache" | "fallback";
  readonly status: ProviderStatus;
  /** Specific, user-facing reason. Null when there is nothing to report. */
  readonly error: string | null;
  /** Epoch ms of the fetch these models came from, or null if never. */
  readonly fetchedAt: number | null;
  /** True when `models` is known to be stale rather than merely cached. */
  readonly stale: boolean;
}

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly freeness: Freeness;
  /** Never contains a key. */
  readonly freenessReason: string;
  readonly contextWindow?: number;
  readonly tools: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  /** Local providers are free by construction; worth its own badge. */
  readonly local: boolean;
  readonly description?: string;
  /**
   * Atomic has called this model and been refused, with the provider's reason.
   *
   * Carried through to the picker so the note is the provider's own words
   * rather than something this app decided about someone else's model.
   */
  readonly unavailableReason?: string;
  /**
   * Atomic was refused once, but not confirmed. Carried separately because the
   * two states need different words and different affordances: this one still
   * deserves a retry.
   */
  readonly suspectedReason?: string;
  /** Atomic completed a real call to this model with no credential. */
  readonly verifiedReachable?: boolean;
}

export interface ModelFilters {
  readonly query?: string;
  readonly freeOnly?: boolean;
  readonly toolsOnly?: boolean;
  readonly localOnly?: boolean;
  /**
   * The freeness groups to show, as a set of exact `Freeness` values.
   *
   * Separate from `freeOnly` because "not free" is two different situations that
   * need different decisions. Paid means money. Unknown means nobody has said,
   * which is the case where a user most needs to see the list rather than have
   * it filtered away by a checkbox whose name implies a fact.
   */
  readonly freeness?: readonly Freeness[];
}

/** Providers that need no credential, so are always "configured". */
export const KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(["ollama"]);

export function isKeylessProvider(providerId: string): boolean {
  return KEYLESS_PROVIDERS.has(providerId);
}

/**
 * Which providers to show.
 *
 * A provider is included when it holds a saved key, when it is local, or when it
 * is the one the app is currently pointed at. The last case matters: a user who
 * has just pasted a key into the *default* provider should see its section
 * immediately, not a page of "add a key" prompts for services they never intended
 * to use.
 */
export function configuredProviders(
  settings: Settings,
  hasKey: Readonly<Record<string, boolean>>,
): readonly ProviderDefinition[] {
  return PROVIDERS.filter(
    (provider) =>
      isKeylessProvider(provider.id) ||
      hasKey[provider.id] === true ||
      provider.id === settings.providerId,
  );
}

/** A provider with no key and no models: the UI shows an "Add key" prompt. */
export function isUnconfigured(section: ProviderModels): boolean {
  return section.status === "unconfigured" && section.models.length === 0;
}

export function toCatalogModel(provider: ProviderDefinition, model: ModelInfo): CatalogModel {
  const detail = freenessFor(provider, model);
  return {
    id: model.id,
    name: model.name || model.id,
    providerId: provider.id,
    providerLabel: provider.label,
    freeness: detail.freeness,
    freenessReason: detail.reason,
    ...(model.capabilities.contextWindow !== undefined
      ? { contextWindow: model.capabilities.contextWindow }
      : {}),
    tools: model.capabilities.tools,
    vision: model.capabilities.vision,
    reasoning: model.capabilities.reasoning,
    local: isKeylessProvider(provider.id),
    ...(model.description ? { description: model.description } : {}),
    ...(model.unavailableInAtomic
      ? { unavailableReason: model.unavailableInAtomic.reason }
      : {}),
    ...(model.suspectedInAtomic
      ? { suspectedReason: model.suspectedInAtomic.reason }
      : {}),
    ...(model.verifiedReachable ? { verifiedReachable: true } : {}),
  };
}

/** The flat, provider-tagged list. Order is provider order, then provider order within it. */
export function mergeModels(sections: readonly ProviderModels[]): readonly CatalogModel[] {
  return sections.flatMap((section) =>
    section.models.map((model) => toCatalogModel(section.provider, model)),
  );
}

function matchesQuery(model: CatalogModel, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  // Provider label included so "ollama" or "openrouter" narrows to one source.
  return (
    model.id.toLowerCase().includes(needle) ||
    model.name.toLowerCase().includes(needle) ||
    model.providerLabel.toLowerCase().includes(needle) ||
    (model.description?.toLowerCase().includes(needle) ?? false)
  );
}

/**
 * Apply the search box and the filters.
 *
 * The single implementation, used by the settings browser *and* the header
 * picker. It was duplicated per surface, and the copy in the header silently
 * ignored `freeness` -- so the Free / Unknown / Paid chips narrowed the list in
 * Settings and did nothing in the dropdown, which looks like the chips are
 * broken rather than like two filters disagree.
 *
 * "Free only" keeps models whose freeness is confirmed `free` *or* `free-tier`,
 * because a rate-limited free tier still costs the user nothing, which is what
 * the filter is asking about. `unknown` is excluded: a model with no reported
 * price must not appear under a filter that promises it is free.
 *
 * `freeness` is applied *after* `freeOnly` rather than instead of it, so a
 * filter object carrying both is the intersection. Neither is removed: they are
 * two shapes the same question can arrive in, and one of them is a checkbox.
 */
export function filterModels(
  models: readonly CatalogModel[],
  filters: ModelFilters = {},
): readonly CatalogModel[] {
  return models.filter((model) => {
    if (filters.freeOnly && model.freeness !== "free" && model.freeness !== "free-tier") {
      return false;
    }
    // An empty group list is not "show nothing": it is the absence of a choice,
    // and treating it as an empty intersection hid every row in the catalog.
    if (filters.freeness && filters.freeness.length > 0 && !filters.freeness.includes(model.freeness)) {
      return false;
    }
    if (filters.toolsOnly && !model.tools) return false;
    if (filters.localOnly && !model.local) return false;
    return matchesQuery(model, filters.query ?? "");
  });
}

export interface SectionFilters extends ModelFilters {
  readonly providerId: string;
}

/** Filter within one provider, for rendering that provider's rows. */
export function filterSection(
  section: ProviderModels,
  filters: SectionFilters,
): readonly CatalogModel[] {
  return filterModels(mergeModels([section]), filters);
}

/** A provider section with nothing to show under the current filters. */
export function isSectionFilteredOut(section: ProviderModels, filters: ModelFilters): boolean {
  if (section.models.length === 0) return false;
  return filterSection(section, { ...filters, providerId: section.provider.id }).length === 0;
}

// ---- the pinned model disappears -----------------------------------------

export type SelectionHealth = "ok" | "auto" | "missing" | "unavailable";

export interface SelectionState {
  readonly health: SelectionHealth;
  /** The model id to actually use. Equals the configured id unless it vanished. */
  readonly effective: string;
  /** Set when the configured model is not available, so the UI can say so. */
  readonly notice: string | null;
  /** Candidates offered as the replacement, best first. */
  readonly replacements: readonly CatalogModel[];
}

/**
 * What to do about a mode's pinned model.
 *
 * A pinned model that is not in the list is a real situation: the user deleted it
 * from Ollama, or the vendor retired it. Sending anyway fails at the provider
 * with a 404 that means nothing to the user, so the mode moves to the best
 * remaining model *and says so*. It is a notice, not a silent swap -- the user
 * finds out that a different model is answering their next message.
 *
 * An empty list is different from a missing model. With nothing available at all
 * there is nothing to fall back to, so the configured id is kept and the caller
 * is told the catalog is unavailable; the send path reports the real error rather
 * than this layer inventing a model.
 *
 * Auto is never touched: it is resolved from the ranking, so it cannot be
 * "missing".
 */
export function resolveSelection(
  settings: Settings,
  mode: Mode,
  models: readonly CatalogModel[],
  sections: readonly ProviderModels[] = [],
): SelectionState {
  const configured = modelFor(settings, mode);

  if (isAutoModel(configured)) {
    return { health: "auto", effective: AUTO_MODEL, notice: null, replacements: [] };
  }

  if (models.length === 0) {
    return {
      health: "unavailable",
      effective: configured,
      notice:
        "The model list could not be loaded, so the model this mode was set to is being used as-is.",
      replacements: [],
    };
  }

  const configuredProviderId = modelProviderFor(settings, mode);
  const present = models.find(
    (model) => model.id === configured && model.providerId === configuredProviderId,
  );
  if (present) {
    return { health: "ok", effective: configured, notice: null, replacements: [] };
  }

  // "Not in the list" is only evidence of removal when we actually have that
  // provider's catalog. An empty or failed section means we have not looked, and
  // reporting a model as deleted because one endpoint hiccuped is a lie the user
  // acts on -- they go looking for a replacement that was never needed. This is
  // the difference between `unavailable` and `missing`.
  const section = sections.find((entry) => entry.provider.id === configuredProviderId);
  const providerLabel =
    section?.provider.label ?? providerById(configuredProviderId)?.label ?? configuredProviderId;
  if (!section || section.models.length === 0 || section.status !== "connected") {
    const because = !section
      ? `${providerLabel} is not configured`
      : section.status === "unreachable"
        ? `${providerLabel} could not be reached`
        : `${providerLabel} reported no models`;
    return {
      health: "unavailable",
      effective: configured,
      notice: `${configured} could not be checked because ${because}. It will be used as-is if it still works.`,
      replacements: [],
    };
  }

  // The provider answered and the model is genuinely not in it. Only now is a
  // replacement a fact rather than a guess.
  const candidates = rankReplacements(
    models.filter((model) => model.id !== configured),
    mode,
    settings.autoSelectFreeModelsOnly,
  );
  const replacement = candidates[0] ?? null;
  return {
    health: "missing",
    effective: replacement ? replacement.id : configured,
    // The provider is named because the replacement may well be served by a
    // different one, and "chat will use a different model" is not something
    // anyone can check without knowing where it is going.
    notice: replacement
      ? `${configured} is no longer offered by ${providerLabel}. ${mode} will use ${replacement.name} from ${replacement.providerLabel} instead.`
      : `${configured} is no longer offered by ${providerLabel}.`,
    replacements: candidates.slice(0, 5),
  };
}

/**
 * Order the models a vanished pinned model could be replaced with.
 *
 * `freeOnly` is applied *here* rather than assumed, because the alternative is
 * the failure this function used to have: it took the first row of a flat,
 * all-providers catalog, which with free-only on is a paid model from whichever
 * provider happened to be listed first, chosen without any idea whether it was
 * free, capable, or even reachable.
 *
 * Ranked rather than filtered-and-first, so the replacement is a sensible
 * all-rounder instead of an arbitrary one.
 */
function rankReplacements(
  candidates: readonly CatalogModel[],
  mode: Mode,
  freeOnly: boolean,
): readonly CatalogModel[] {
  const scored = candidates
    .map((model) => {
      const definition = providerById(model.providerId);
      if (!definition) return null;
      // `unavailableInAtomic` is carried on the catalog row, so it is honoured
      // here: a replacement that Atomic has already been refused is not a
      // replacement.
      if (model.unavailableReason || model.suspectedReason) return null;
      const info: ModelInfo = {
        id: model.id,
        name: model.name,
        // The catalog row is provider-tagged and already resolved to a
        // provider, so the dialect is whatever that provider speaks. Ranking
        // reads neither field; both are required by the type.
        wireFormat: definition.defaultWireFormat,
        capabilities: {
          tools: model.tools,
          vision: model.vision,
          reasoning: model.reasoning,
          streaming: true,
          reasoningEffort: false,
          ...(model.contextWindow !== undefined
            ? { contextWindow: model.contextWindow }
            : {}),
        },
        ...(model.description ? { description: model.description } : {}),
      };
      const { ineligibility, scoreModel } = ranking;
      if (ineligibility(info, { provider: definition, mode, onlyFree: freeOnly })) return null;
      return { model, score: scoreModel(info, { provider: definition, mode, onlyFree: freeOnly }).score };
    })
    .filter((entry): entry is { model: CatalogModel; score: number } => entry !== null);

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.model.id.localeCompare(b.model.id) ||
      a.model.providerId.localeCompare(b.model.providerId),
  );
  return scored.map((entry) => entry.model);
}

export interface MissingSelection {
  readonly mode: Mode;
  readonly notice: string;
  readonly effective: string;
  /** Where the replacement will actually come from, when one will. */
  readonly effectiveProviderId: string | null;
  readonly effectiveProviderLabel: string | null;
}

/**
 * Every mode whose pinned model has vanished, for a single banner.
 *
 * Returned rather than rendered so the caller decides where the notice appears,
 * and so the "one model disappeared" case can be stated once instead of three
 * times in three dropdowns.
 */
export function missingSelections(
  settings: Settings,
  models: readonly CatalogModel[],
  sections: readonly ProviderModels[] = [],
): readonly MissingSelection[] {
  const out: MissingSelection[] = [];
  for (const mode of MODES) {
    const state = resolveSelection(settings, mode, models, sections);
    if (state.health !== "missing" || state.notice === null) continue;
    const replacement = state.replacements.find(
      (entry) => entry.id === state.effective,
    );
    out.push({
      mode,
      notice: state.notice,
      effective: state.effective,
      effectiveProviderId: replacement?.providerId ?? null,
      effectiveProviderLabel: replacement?.providerLabel ?? null,
    });
  }
  return out;
}

/**
 * Separator for a provider-qualified model key.
 *
 * A native `<select>` can only carry string values, and a model id is not unique
 * on its own -- several vendors publish `gpt-4o-mini`, and OpenRouter ids contain
 * `/`. U+001F cannot appear in a model id, so joining on it is unambiguous where
 * `"provider/id"` is not.
 */
const KEY_SEPARATOR = "\u001f";

/** A `<select>`-safe, collision-free key for one row of the merged list. */
export function catalogKey(providerId: string, modelId: string): string {
  return `${providerId}${KEY_SEPARATOR}${modelId}`;
}

/** Split a key from `catalogKey`. Returns null for anything else. */
export function parseCatalogKey(
  key: string,
): { readonly providerId: string; readonly modelId: string } | null {
  const at = key.indexOf(KEY_SEPARATOR);
  if (at <= 0 || at === key.length - 1) return null;
  return { providerId: key.slice(0, at), modelId: key.slice(at + 1) };
}

/**
 * The key for a mode's current selection, or null when it is on Auto.
 *
 * Matching prefers the recorded provider and falls back to a bare id match, so a
 * settings file written before per-mode providers existed still resolves.
 */
export function selectionKey(settings: Settings, mode: Mode): string | null {
  const id = modelFor(settings, mode);
  if (!id || isAutoModel(id)) return null;
  return catalogKey(modelProviderFor(settings, mode), id);
}
