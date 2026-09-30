import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AUTO_MODEL,
  catalogKey,
  isUnconfigured,
  modelFor,
  mergeModels,
  providerById,
  toCatalogModel,
  resolveModelForMode,
  type CatalogModel,
  type Freeness,
  type HostApi,
  type ModelFilters,
  type ModelInfo,
  type Mode,
  type ProviderDefinition,
  type ProviderModels,
  type ProviderStatus,
  type Settings,
} from "@atomic/core";

export interface ModelOption {
  /** Provider-qualified key, safe to use as a `<select>` value. */
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly freeness: Freeness;
  /** Why this model carries that label. Shown in the "Why this model?" panel. */
  readonly freenessReason: string;
  readonly contextWindow?: number;
  readonly tools: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  /** Runs on this machine through Ollama. */
  readonly local: boolean;
  /** The model is being shown from cache after a failed refresh. */
  readonly stale: boolean;
  /**
   * Atomic called this model and was refused, with the provider's reason.
   *
   * Learned at runtime rather than declared, so the note can be shown without
   * anything in the app naming a specific model.
   */
  readonly unavailableReason?: string;
  /**
   * Refused once, not confirmed. The row stays selectable and the note asks for
   * a retry rather than declaring the model gone.
   */
  readonly suspectedReason?: string;
  /** Atomic completed a real unauthenticated call to this model. */
  readonly verifiedReachable?: boolean;
}

/** What the Auto option currently resolves to, for the dropdown label. */
export interface AutoResolution {
  readonly modelId: string;
  readonly modelName: string;
  /**
   * Which provider will actually serve the Auto pick.
   *
   * Not the active one. Auto ranks across every configured provider, so the
   * answer can be a model this user has not thought about -- and a request that
   * silently goes somewhere else is exactly what the user is asking to be able
   * to see.
   */
  readonly providerLabel: string;
  readonly reason: string;
  /** Set when free-only left nothing eligible; the UI must not auto-spend. */
  readonly needsPaidConfirmation: boolean;
  readonly cheapestPaidName: string | null;
  readonly topFactors: readonly {
    readonly label: string;
    readonly detail: string;
  }[];
}

export interface ProviderSectionState {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly models: readonly ModelOption[];
  readonly status: ProviderStatus;
  readonly error: string | null;
  readonly fetchedAt: number | null;
  readonly stale: boolean;
  /** No key saved: the section is an "Add key" prompt, not an empty list. */
  readonly unconfigured: boolean;
}

export interface ModelCatalogState {
  /** Every configured provider's models, flattened, in provider order. */
  readonly models: readonly ModelOption[];
  /** The same list, per provider, for the grouped dropdown and Models tab. */
  readonly sections: readonly ProviderSectionState[];
  readonly loading: boolean;
  /** A user-facing reason the catalog is unavailable. Null while it is fine. */
  readonly error: string | null;
  /** Re-fetch, bypassing the cache. Wired to the Retry button. */
  readonly reload: () => void;
  /** `true` while a forced refresh is in flight, so the button can show progress. */
  readonly refreshing: boolean;
  /** Resolved Auto pick for the mode this state was built for. */
  readonly auto: AutoResolution | null;
  /** True when the user's mode setting is the `auto` sentinel. */
  readonly usingAuto: boolean;
  /** Restrict automatic selection to zero-cost models. */
  readonly onlyFree: boolean;
  readonly setOnlyFree: (value: boolean) => void;
  /** Narrow the list. Undefined fields mean "no constraint". */
  readonly filters: ModelFilters;
  readonly setFilters: (next: ModelFilters) => void;
}

function toOption(entry: CatalogModel, stale: boolean): ModelOption {
  return {
    key: catalogKey(entry.providerId, entry.id),
    id: entry.id,
    name: entry.name,
    providerId: entry.providerId,
    providerLabel: entry.providerLabel,
    freeness: entry.freeness,
    freenessReason: entry.freenessReason,
    ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}),
    ...(entry.suspectedReason ? { suspectedReason: entry.suspectedReason } : {}),
    ...(entry.verifiedReachable ? { verifiedReachable: true } : {}),
    ...(entry.contextWindow !== undefined
      ? { contextWindow: entry.contextWindow }
      : {}),
    tools: entry.tools,
    vision: entry.vision,
    reasoning: entry.reasoning,
    local: entry.local,
    stale,
  };
}

/**
 * Load every configured provider's catalog, label it, and resolve the Auto pick.
 *
 * Four things this deliberately does not do:
 *
 * - It never swallows the error. The old code did `.catch(() => [])`, which made
 *   a network failure indistinguishable from "this provider has no models": the
 *   dropdown rendered empty and the user had no idea anything had gone wrong.
 * - It never leaves the UI in a permanent loading state. A failed request settles
 *   into `error`, not into an endless spinner.
 * - It does not fire repeatedly. `reload` is a manual action, so a retry storm
 *   cannot be triggered by a re-render.
 * - It never reduces the catalog to the active provider. A model id is only
 *   unique within a provider, so the list has to stay provider-tagged for a
 *   selection to be routable at all.
 *
 * Freeness and the Auto ranking are computed here, in the view, from the catalog
 * the host already returns. The host stays the single source of truth for what
 * each provider charges; this only reads it.
 */
export function useModels(
  api: HostApi,
  options: {
    readonly enabled?: boolean;
    readonly mode?: Mode;
    /** The mode's current setting, used to decide if Auto is active. */
    readonly configured?: string;
    readonly onlyFree?: boolean;
    /** The provider recorded for the mode's model, for the Auto ranking. */
    readonly providerId?: string;
  } = {},
): ModelCatalogState {
  const {
    enabled = true,
    mode = "chat",
    configured,
    onlyFree: onlyFreeProp = true,
    providerId: providerIdProp,
  } = options;
  const [sections, setSections] = useState<readonly ProviderModels[]>([]);
  const [providerId, setProviderId] = useState<string>(
    providerIdProp ?? "opencode-zen",
  );
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyFree, setOnlyFreeState] = useState(onlyFreeProp);
  const [filters, setFilters] = useState<ModelFilters>({});
  const attempt = useRef(0);

  // Keep the local mirror in step when settings change elsewhere.
  useEffect(() => setOnlyFreeState(onlyFreeProp), [onlyFreeProp]);
  useEffect(() => {
    if (providerIdProp) setProviderId(providerIdProp);
  }, [providerIdProp]);

  const provider = useMemo<ProviderDefinition>(
    () => providerById(providerId) ?? providerById("opencode-zen")!,
    [providerId],
  );

  const load = useCallback(
    async (force: boolean) => {
      const mine = ++attempt.current;
      if (force) setRefreshing(true);
      else setLoading(true);
      try {
        // Each section lands as its provider answers, so a slow or hanging one
        // no longer holds back the sections that already have data. The final
        // `setSections` is what guarantees the list is complete and ordered.
        const available = await api.listProviderModels(force, (section) => {
          if (mine !== attempt.current) return;
          setSections((current) => {
            const next = current.filter(
              (item) => item.provider.id !== section.provider.id,
            );
            next.push(section);
            return next;
          });
        });
        if (mine !== attempt.current) return;
        setSections(available);
        setError(null);
      } catch (cause) {
        if (mine !== attempt.current) return;
        // Surfaced in the UI rather than only the webview console, which is
        // invisible on Linux and therefore useless in a user's bug report.
        setError(describe(cause));
      } finally {
        if (mine === attempt.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [api],
  );

  useEffect(() => {
    if (!enabled) return;
    void load(false);
  }, [enabled, load]);

  const reload = useCallback(() => {
    void load(true);
  }, [load]);

  const sectionStates = useMemo<readonly ProviderSectionState[]>(
    () =>
      sections.map((section) => ({
        providerId: section.provider.id,
        providerLabel: section.provider.label,
        models: section.models.map((model) =>
          toOption(toCatalogModel(section.provider, model), section.stale),
        ),
        status: section.status,
        error: section.error,
        fetchedAt: section.fetchedAt,
        stale: section.stale,
        unconfigured: isUnconfigured(section),
      })),
    [sections],
  );

  // The flattened list comes from the tagged catalog rather than from the
  // sections, so a model and the provider that serves it stay bound together.
  const models = useMemo<readonly ModelOption[]>(() => {
    const stale = new Set(
      sections.filter((s) => s.stale).map((s) => s.provider.id),
    );
    return mergeModels(sections).map((entry) =>
      toOption(entry, stale.has(entry.providerId)),
    );
  }, [sections]);

  const auto = useMemo<AutoResolution | null>(() => {
    if (models.length === 0) return null;
    // Every configured provider, not just the active one. This preview has to
    // agree with what the host will actually resolve, or the dropdown says one
    // model and the request goes to another.
    const candidates = sections
      .filter((section) => section.status === "connected" && section.models.length > 0)
      .flatMap((section) =>
        section.models.map((model) => ({ provider: section.provider, model })),
      );
    if (candidates.length === 0) return null;
    const resolved = resolveModelForMode({
      configured: configured ?? AUTO_MODEL,
      mode,
      provider,
      candidates,
      onlyFree,
      // The fallbacks this produces are walked after the chosen model fails, so
      // they lead with a different provider. Same rule the host uses.
      avoidProviderId: providerId,
    });
    const chosen = resolved.selection?.chosen ?? null;
    return {
      modelId: resolved.model,
      modelName: chosen?.candidate.model.name ?? "",
      providerLabel: chosen?.candidate.provider.label ?? "",
      reason: chosen?.reason ?? "",
      needsPaidConfirmation: resolved.selection?.needsPaidConfirmation ?? false,
      cheapestPaidName: resolved.selection?.cheapestPaid?.candidate.model.name ?? null,
      topFactors: (chosen?.factors ?? []).slice(0, 3).map((f) => ({
        label: f.label,
        detail: f.detail,
      })),
    };
  }, [
    sections,
    models.length,
    configured,
    mode,
    provider,
    providerId,
    onlyFree,
  ]);

  const setOnlyFree = useCallback(
    (value: boolean) => {
      setOnlyFreeState(value);
      void api.updateSettings({ autoSelectFreeModelsOnly: value }).catch(() => {
        // A failed write must not leave the UI claiming a policy that is not
        // actually in effect, so put the control back.
        setOnlyFreeState(!value);
      });
    },
    [api],
  );

  return {
    models,
    sections: sectionStates,
    loading,
    refreshing,
    error,
    reload,
    auto,
    usingAuto: !configured || configured === AUTO_MODEL,
    onlyFree,
    setOnlyFree,
    filters,
    setFilters,
  };
}

function describe(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return "Could not load models.";
}

/**
 * Fold the host's two answers into one row per mode.
 *
 * Kept out of the hook so the part that decides what a person is told can be
 * checked without rendering, and so it is obvious that the notice comes from the
 * host's `missingSelections` and is not re-derived here from a catalog that may
 * be stale.
 */
export function toModeResolutions(
  settings: Settings,
  resolved: Record<Mode, string>,
  notices: readonly {
    readonly mode: Mode;
    readonly notice: string;
    readonly effective: string;
  }[],
): readonly ModeResolution[] {
  // `settings` is the fallback the host mirrors on a thrown resolution, and is
  // kept in the signature so the hook can pass the live settings through
  // unchanged.
  void settings;
  const byMode = new Map(notices.map((entry) => [entry.mode, entry]));
  return (Object.keys(resolved) as readonly Mode[]).map((mode) => {
    const got = resolved[mode];
    const missing = byMode.get(mode) ?? null;
    // Two distinct ways to end up with nothing to send to, and they need
    // different words. The sentinel means resolution produced no model at all
    // (no catalog, no free model, no provider). An empty replacement means a
    // pinned model is gone and nothing was found to stand in for it -- the host
    // echoes the configured id back in that case, so the id alone proves
    // nothing.
    const unresolvable = got === AUTO_MODEL || (missing !== null && !missing.effective);
    return {
      mode,
      resolved: got,
      unresolvable,
      effective: missing?.effective || null,
      notice: missing?.notice ?? null,
    };
  });
}

/**
 * What the host would do for each mode right now, without asking it to commit.
 *
 * `resolveModels` is deliberately total: it answers for every mode and never
 * rejects, because the question it is answering is "what would happen if the
 * user pressed send", and an app that cannot answer that is not more usable than
 * one that answers badly. Reporting the configured sentinel when resolution fails
 * is the point -- it is what the send path will actually meet, and hiding it
 * behind a blank would leave the header claiming a model nothing will use.
 *
 * Separate from the catalog above on purpose. This asks the host, which is where
 * the real provider and the real credential live, so it stays correct even when
 * the merged catalog is mid-load, stale, or served from cache.
 */
export interface ModeResolution {
  readonly mode: Mode;
  /** What the header shows: a model id, or the Auto sentinel. */
  readonly resolved: string;
  /** True when the configured model could not be resolved at all. */
  readonly unresolvable: boolean;
  /** What will actually be used, when it is not what was configured. */
  readonly effective: string | null;
  readonly notice: string | null;
}

export function useModeResolutions(
  api: HostApi,
  settings: Settings,
): readonly ModeResolution[] {
  const [rows, setRows] = useState<readonly ModeResolution[]>([]);
  // Every input that can change an answer, and nothing that cannot. A missing
  // provider, an emptied model list and a flipped free-only switch each change
  // what will actually be sent, so all three belong here.
  const signature = JSON.stringify([
    settings.models.chat,
    settings.models.cowork,
    settings.models.code,
    settings.models.providers,
    settings.providerId,
    settings.autoSelectFreeModelsOnly,
  ]);

  useEffect(() => {
    let cancelled = false;
    // A missing selection is reported by the host, which has the provider to
    // check against. Both calls are total, but a rejected one -- an unopened
    // database, a torn-down host -- must not take the header with it.
    void Promise.all([api.resolveModels(), api.selectionNotices()])
      .then(([resolved, notices]) => {
        if (!cancelled) setRows(toModeResolutions(settings, resolved, notices));
      })
      .catch(() => {
        // Nothing actionable to say, and saying nothing is better than
        // replacing the app with an error page at startup.
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
    // `settings` is read only through the signature above; depending on the
    // object itself would refetch on every unrelated settings write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, signature]);

  return rows;
}
