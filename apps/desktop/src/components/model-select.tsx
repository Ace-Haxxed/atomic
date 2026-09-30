import { useMemo, useState } from "react";
import {
  AUTO_MODEL,
  FREENESS_LABELS,
  catalogKey,
  filterModels,
  parseCatalogKey,
  selectionKey,
  type CatalogModel,
  type Freeness,
  type ModelFilters,
  type Mode,
  type Settings,
} from "@atomic/core";
import type { AutoResolution, ModelCatalogState, ModelOption } from "../app/use-models.js";
import { Button, Select } from "@atomic/ui";

/**
 * A model picker that always tells the truth.
 *
 * The old version rendered nothing when the list was empty, so a failed fetch and
 * a legitimately empty list looked the same and the control vanished. This one
 * always renders: a spinner while loading, the reason plus a Retry on failure,
 * and the Auto option first, always.
 *
 * The Auto option is the point of the picker. Once a user pins a model they must
 * be able to hand control back, so selecting Auto always fires `onChange` -- an
 * earlier version skipped the empty value and quietly made that impossible.
 */
export interface ModelSelectProps {
  /** Identifies the picker in tests and in the accessibility tree. */
  readonly label: string;
  readonly state: ModelCatalogState;
  /**
   * The mode's current model, the `auto` sentinel, or "" for auto.
   *
   * A bare model id, not a key: the stored setting is the id, and the provider
   * recorded alongside it disambiguates. See `selectionKey`.
   */
  readonly value: string;
  readonly settings?: Settings;
  readonly mode?: Mode;
  /**
   * Reports the model *and* the provider that serves it.
   *
   * Both, because a model id alone cannot be routed: several vendors publish the
   * same id, and sending a request for one to the other is a 404 at best.
   */
  readonly onChange: (modelId: string, providerId: string) => void;
  readonly className?: string;
  /** Rendered next to the control when there is a problem. */
  readonly showRetryInline?: boolean;
  /** Narrow the options by text and badges. */
  readonly filters?: ModelFilters;
}

export function ModelSelect({
  label,
  state,
  value,
  settings,
  mode = "chat",
  onChange,
  className,
  showRetryInline = true,
  filters,
}: ModelSelectProps) {
  const { models, loading, error, reload, refreshing, auto } = state;
  const isAuto = !value || value === AUTO_MODEL;

  // The same `CatalogModel` list the Models tab uses, so search and badge
  // filters behave identically in the dropdown and on the settings page.
  const byKey = useMemo(() => new Map(models.map((m) => [m.key, m])), [models]);
  const visible = useMemo(
    () => filterModels(toCatalog(models), filters).map((entry) => byKey.get(catalogKey(entry.providerId, entry.id))),
    [models, byKey, filters],
  );
  const currentKey = settings ? selectionKey(settings, mode) : null;

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Select
        aria-label={label}
        className={className ?? "h-7 w-56 text-xs"}
        value={isAuto ? AUTO_MODEL : (currentKey ?? catalogKeyFor(value))}
        disabled={loading || models.length === 0}
        onChange={(event) => {
          if (event.target.value === AUTO_MODEL) {
            onChange(AUTO_MODEL, state.models[0]?.providerId ?? "");
            return;
          }
          // A native select carries a string, so the option value is the
          // provider-qualified key; this is where it becomes a real selection.
          const parsed = parseCatalogKey(event.target.value);
          if (parsed) onChange(parsed.modelId, parsed.providerId);
        }}
      >
        <option value={AUTO_MODEL}>{autoLabel(auto)}</option>
        {groupByProvider(visible.filter((m): m is ModelOption => m !== undefined)).map(
          ([providerLabel, group]) => (
          <optgroup key={providerLabel} label={providerLabel}>
            {group.map((model) => (
              <option key={model.key} value={model.key}>
                {/* Provider repeated per row as well as in the optgroup: browsers
                    flatten this control in several places -- comboboxes on
                    Linux, the macOS menu -- and a flattened list that drops the
                    grouping leaves the user unable to tell which account a model
                    belongs to. */}
                {model.name} · {model.providerLabel} · {FREENESS_LABELS[model.freeness]}
                {model.unavailableReason ? " · unusable from Atomic" : ""}
                {model.suspectedReason ? " · refused once" : ""}
                {model.stale ? " · cached" : ""}
              </option>
            ))}
          </optgroup>
          ),
        )}
      </Select>

      <Button
        size="sm"
        variant="ghost"
        onClick={reload}
        disabled={refreshing}
        title="Re-fetch the model list from the provider"
      >
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>

      {error && showRetryInline ? (
        <Button size="sm" variant="ghost" onClick={reload} title={error}>
          Retry
        </Button>
      ) : null}
    </span>
  );
}

/** Group rows by provider so the dropdown reads as a list of catalogs. */
function groupByProvider(
  models: readonly ModelOption[],
): readonly (readonly [string, readonly ModelOption[]])[] {
  const groups = new Map<string, ModelOption[]>();
  // `visible` is CatalogModel-shaped, so index back into `models` by key to
  // render the row's own badges.
  for (const model of models) {
    const bucket = groups.get(model.providerLabel);
    if (bucket) bucket.push(model);
    else groups.set(model.providerLabel, [model]);
  }
  return [...groups];
}

function toCatalog(models: readonly ModelOption[]): readonly CatalogModel[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    providerId: model.providerId,
    providerLabel: model.providerLabel,
    freeness: model.freeness,
    freenessReason: model.freenessReason,
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    tools: model.tools,
    vision: model.vision,
    reasoning: model.reasoning,
    local: model.local,
  }));
}

/** Best-effort option value when the caller did not pass settings. */
function catalogKeyFor(modelId: string): string {
  return modelId;
}

/** The Auto row says what it picked, not just that it is automatic. */
/**
 * The Auto row.
 *
 * Names the provider as well as the model. Auto picks across every configured
 * provider, so the model name alone does not say which account the next request
 * will be billed to or rate-limited by -- and a free model quietly served by
 * OpenRouter instead of Zen is exactly the sort of thing worth being explicit
 * about.
 */
function autoLabel(auto: AutoResolution | null): string {
  if (!auto) return "Auto";
  if (auto.modelName) {
    return auto.providerLabel
      ? `Auto — ${auto.modelName} · ${auto.providerLabel}`
      : `Auto — ${auto.modelName}`;
  }
  if (auto.cheapestPaidName) return "Auto — no free model";
  return "Auto";
}

/** The free/paid breakdown, with the reason behind each label. */
export function FreenessLegend({ state }: { readonly state: ModelCatalogState }) {
  const counts = new Map<Freeness, number>();
  for (const model of state.models) {
    counts.set(model.freeness, (counts.get(model.freeness) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2 text-[11px] text-content-muted">
      {[...counts].map(([freeness, count]) => (
        <li key={freeness} title={state.models.find((m) => m.freeness === freeness)?.freenessReason}>
          {count} {FREENESS_LABELS[freeness]}
        </li>
      ))}
    </ul>
  );
}

/**
 * Why Auto chose what it chose, and the honest warning when it could not.
 *
 * The paid-confirmation case is the important one: when free-only leaves nothing
 * eligible, this says so and names the cheapest alternative rather than quietly
 * selecting a paid model.
 */
export function AutoModelNote({ state }: { readonly state: ModelCatalogState }) {
  const [open, setOpen] = useState(false);
  const auto = state.auto;
  if (!auto) return null;

  if (auto.needsPaidConfirmation) {
    return (
      <p className="text-xs text-content-muted">
        No free model is available for this provider.
        {auto.cheapestPaidName ? ` The cheapest capable option is ${auto.cheapestPaidName}.` : null} Turn
        off{" "}
        <strong>Only auto-select free models</strong> to allow a paid model, or pick one yourself.
      </p>
    );
  }

  return (
    <div className="text-xs text-content-muted">
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        Why this model?
      </button>
      {open ? (
        <div className="mt-1 space-y-1">
          <p>{auto.reason}</p>
          <ul className="space-y-0.5">
            {auto.topFactors.map((factor) => (
              <li key={factor.label}>
                <span className="text-content">{factor.label}</span>: {factor.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** The only-free policy toggle, shown next to the picker. */
export function OnlyFreeToggle({ state }: { readonly state: ModelCatalogState }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-content-muted">
      <input
        type="checkbox"
        checked={state.onlyFree}
        onChange={(event) => state.setOnlyFree(event.target.checked)}
      />
      Only auto-select free models
    </label>
  );
}

/** The message shown under a picker when the catalog could not be loaded. */
export function ModelErrorNote({
  state,
  id,
}: {
  readonly state: ModelCatalogState;
  readonly id: string;
}) {
  if (!state.error) return null;
  return (
    <p id={id} role="alert" className="text-xs text-danger">
      {state.error}{" "}
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={state.reload}
      >
        Retry
      </button>
    </p>
  );
}

/** Placeholder text for a picker whose catalog is still on its way. */
export function modelPlaceholder(state: ModelCatalogState): string | undefined {
  if (state.loading) return "Loading models…";
  if (state.error) return "Models unavailable";
  return undefined;
}
