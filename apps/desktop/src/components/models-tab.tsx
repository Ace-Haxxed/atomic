import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AUTO_MODEL,
  FREENESS_LABELS,
  catalogKey,
  filterModels,
  formatBytes,
  parseCatalogKey,
  selectionKey,
  detectProviderFromKey,
  isConfident,
  OLLAMA_DEFAULT_ROOT,
  OLLAMA_PROVIDER_ID,
  ollamaRootFrom,
  PROVIDERS,
  ZEN_PROVIDER_ID,
  type ApiKeySource,
  type CatalogModel,
  type Freeness,
  type Mode,
  type ModelFilters,
  type ProviderDefinition,
  type Settings,
} from "@atomic/core";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Select, cn } from "@atomic/ui";
import type { HostApi } from "@atomic/core";
import type { ModelCatalogState, ModelOption } from "../app/use-models.js";

/**
 * The Models tab: what the keys and the local Ollama actually serve.
 *
 * The organising idea is that a provider is a section, not a filter. A user with
 * two keys saved is looking at two catalogs, and merging them into one anonymous
 * list would hide which vendor a model is billed by and where a request goes.
 * Within a section, though, everything is a plain list with one shared search
 * box -- searching across all providers at once, because a name is often the only
 * thing someone remembers.
 *
 * Three states get deliberate treatment rather than an empty div:
 *
 * - No key: a prompt to add one, not an empty catalog. "No models" and "you are
 *   not connected" are different facts and the user needs to know which is true.
 * - Unreachable with a cache: the last known models, marked stale, with the
 *   reason. An empty picker during an outage is strictly worse than an old one.
 * - Reachable and empty: a real, common state for a fresh Ollama, and the pull
 *   box is the answer.
 */

export interface ModelsTabProps {
  readonly api: HostApi;
  readonly settings: Settings;
  readonly mode: Mode;
  readonly catalog: ModelCatalogState;
  readonly onSettings: (next: Settings) => void;
}

type Tab = "models" | "providers";

export function ModelsTab({ api, settings, mode, catalog, onSettings }: ModelsTabProps) {
  const [tab, setTab] = useState<Tab>("models");

  return (
    <div className="space-y-4">
      <nav aria-label="Model settings" className="flex gap-1 border-b border-border">
        {(
          [
            ["models", "Models"],
            ["providers", "API keys"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={
              tab === id
                ? "border-b-2 border-accent px-3 py-1.5 text-xs font-medium text-content"
                : "border-b-2 border-transparent px-3 py-1.5 text-xs text-content-muted hover:text-content"
            }
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "models" ? (
        <ModelsBrowser api={api} settings={settings} mode={mode} catalog={catalog} onSettings={onSettings} />
      ) : (
        <ApiKeysTab api={api} settings={settings} />
      )}
    </div>
  );
}

/**
 * Every provider's key, in one place, scoped to that provider.
 *
 * This tab used to be declared and then render `null`, so the only key field in
 * the app lived in Settings bound to whichever provider was currently selected.
 * Storing a second key therefore meant re-pointing the whole app at that
 * provider first, and saving a key could silently move the app's active provider
 * out from under the running chat -- which is what made the app look capable of
 * holding only one or two keys.
 *
 * Each row is independent: saving here writes that provider's keychain slot and
 * nothing else. Detection is a hint next to the field, with a one-click "save it
 * to <provider>" that targets that provider's row, never the app's selection.
 * Presence is re-read from the credential store after every write rather than
 * assumed from the length of what was typed, so an unconfirmed write is reported
 * as a failure.
 */
function ApiKeysTab({
  api,
  settings,
}: {
  readonly api: HostApi;
  readonly settings: Settings;
}) {
  const [sources, setSources] = useState<Readonly<Record<string, ApiKeySource>>>({});
  const [row, setRow] = useState<ApiKeyRow | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSources(await api.apiKeySources());
    } catch {
      setSources({});
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A catalog section is where a key first matters, so a save has to re-check it.
  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-snug text-content-muted">
        Keys are stored in your OS credential store, never in Atomic's database.
        Each provider keeps its own key, so saving one here does not change which
        provider Atomic sends to.
      </p>
      {PROVIDERS.map((provider) => (
        <ProviderKeyRow
          key={provider.id}
          provider={provider}
          source={sources[provider.id] ?? "none"}
          baseUrl={settings.providers[provider.id]?.baseUrl ?? ""}
          api={api}
          row={row?.providerId === provider.id ? row : null}
          onRowChange={(next) =>
            setRow((current) => (next === null ? null : { providerId: provider.id, ...next }))
          }
          onSaved={refresh}
        />
      ))}
    </div>
  );
}

interface ApiKeyRow {
  readonly providerId: string;
  readonly value: string;
  readonly state: "idle" | "saving" | "saved" | "error";
  readonly error: string | null;
  readonly detectedProviderId: string | null;
  readonly detectedLabel: string | null;
  readonly detectionIsCertain: boolean;
  /** The provider the last successful write actually went to. */
  readonly savedProviderId: string | null;
}

function ProviderKeyRow({
  provider,
  source,
  baseUrl,
  api,
  row,
  onRowChange,
  onSaved,
}: {
  readonly provider: ProviderDefinition;
  readonly source: ApiKeySource;
  readonly baseUrl: string;
  readonly api: HostApi;
  readonly row: ApiKeyRow | null;
  readonly onRowChange: (row: Omit<ApiKeyRow, "providerId"> | null) => void;
  readonly onSaved: () => void | Promise<void>;
}) {
  const value = row?.value ?? "";
  const detected = useMemo(() => detectProviderFromKey(value), [value]);
  // Ollama takes no key: a slot written for it would never be read, and the
  // field would be a promise the app cannot keep.
  const keyless = provider.id === OLLAMA_PROVIDER_ID;
  const mismatch = detected.providerId !== null && detected.providerId !== provider.id;
  const certain = isConfident(detected) && mismatch;

  const labelFor = (id: string | null) =>
    id === null ? null : (PROVIDERS.find((candidate) => candidate.id === id)?.label ?? id);

  /**
   * Where a paste of `value` is allowed to go.
   *
   * A conclusive mismatch gets exactly one destination -- the provider the key
   * actually belongs to. The field it was pasted into is not an option, because
   * the alternative is worse than doing nothing: it writes a working key over
   * the slot for a different vendor, and the user finds out later as a
   * confusing authentication failure with no trace of what replaced what.
   *
   * An inconclusive guess is left alone. Prefixes get shared, and for those the
   * field the user chose is the one piece of evidence there is.
   */
  const saveTarget = certain ? (detected.providerId as string) : provider.id;

  const set = (patch: Partial<Omit<ApiKeyRow, "providerId">>) =>
    onRowChange({
      value,
      state: "idle",
      error: null,
      detectedProviderId: detected.providerId,
      detectedLabel: detected.label,
      detectionIsCertain: certain,
      savedProviderId: null,
      ...patch,
    });

  const save = async (target: string) => {
    onRowChange({
      value,
      state: "saving",
      error: null,
      detectedProviderId: detected.providerId,
      detectedLabel: detected.label,
      detectionIsCertain: certain,
      savedProviderId: target,
    });
    try {
      await api.setApiKey(target, value.trim() || null);
      // Presence comes from the credential store, not from the length of what
      // was typed: a store that accepted the write and cannot return it would
      // otherwise be reported here as a success.
      const present = await api.hasApiKey(target);
      if (present !== (value.trim().length > 0)) {
        set({
          state: "error",
          error:
            value.trim() === ""
              ? "The key was not removed. Check your system credential store."
              : "The credential store did not return the key, so Atomic cannot confirm it is usable.",
        });
        return;
      }
      set({ value: "", state: "saved", error: null });
      await onSaved();
    } catch (error) {
      set({ state: "error", error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{provider.label}</CardTitle>
      </CardHeader>
      <CardBody className="space-y-2">
        {keyless ? (
          <p className="text-[11px] text-content-muted">
            Runs on this machine and needs no key.
            {baseUrl ? ` Serving ${baseUrl}.` : ""}
          </p>
        ) : (
          <>
            <p className="text-[11px] text-content-muted">
              {source === "keychain" ? (
                <span className="text-content">Key saved in your OS credential store.</span>
              ) : source === "env" ? (
                <>
                  No saved key. This provider is reached with the{" "}
                  <code>{provider.envVar}</code> environment variable.
                </>
              ) : (
                <>No key saved. {provider.note}</>
              )}
            </p>
            <div className="flex gap-2">
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={source === "keychain" ? "Replace the saved key" : "Paste your API key"}
                aria-label={`${provider.label} API key`}
                value={value}
                onChange={(event) => set({ value: event.target.value })}
              />
              <Button
                onClick={() => void save(saveTarget)}
                disabled={value.trim() === "" || row?.state === "saving"}
              >
                {row?.state === "saving"
                  ? "Saving"
                  : certain
                    ? `Add to ${detected.label} instead`
                    : "Save"}
              </Button>
              {source !== "none" ? (
                <Button
                  variant="ghost"
                  onClick={() => void save(provider.id)}
                  disabled={row?.state === "saving"}
                  title={`Remove the ${provider.label} key`}
                >
                  Remove
                </Button>
              ) : null}
            </div>
            {mismatch ? (
              <p className="text-[11px] leading-snug text-content-muted">
                {`This looks like a ${detected.label} key.`}{" "}
                {certain ? (
                  <>
                    Its shape is conclusive, so the button above adds it to{" "}
                    {detected.label} and leaves {provider.label} untouched
                    {row?.savedProviderId && row.savedProviderId !== provider.id
                      ? ` — it is now saved under ${labelFor(row.savedProviderId)}.`
                      : "."}
                  </>
                ) : (
                  <>
                    Many vendors share this prefix, so check before you rely on it. To add it to{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => void save(detected.providerId as string)}
                    >
                      {`${detected.label} instead`}
                    </button>
                    .
                  </>
                )}
              </p>
            ) : null}
            {row?.error ? (
              <p className="text-[11px] leading-snug text-danger">{row.error}</p>
            ) : null}
            {row?.state === "saved" ? (
              <p className="text-[11px] text-content-muted">
                {row.savedProviderId && row.savedProviderId !== provider.id
                  ? `Saved to ${labelFor(row.savedProviderId)}.`
                  : "Saved."}
              </p>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function ModelsBrowser({
  api,
  settings,
  mode,
  catalog,
  onSettings,
}: ModelsTabProps) {
  const pick = useCallback(
    async (next: Mode, modelId: string, providerId: string) => {
      const next_ = await api.setModelForMode(next, modelId, providerId);
      onSettings(next_);
    },
    [api, onSettings],
  );

  return (
    <div className="space-y-4">
      <ModelFiltersBar catalog={catalog} />

      {catalog.sections.map((section) => (
        <ProviderCatalogSection
          key={section.providerId}
          api={api}
          section={section}
          catalog={catalog}
          settings={settings}
          mode={mode}
          onPick={pick}
          onApplySettings={onSettings}
        />
      ))}

      {catalog.loading ? <CatalogSkeleton /> : null}
    </div>
  );
}

/**
 * What OpenCode Zen's free tier is, said before anything is sent to it.
 *
 * Worth its own line because the label "free" is doing a lot of work in this
 * app and is easy to over-read. A free-tier model needs no key, and OpenCode
 * funds it from the accounts people use its own app with -- it is the same
 * arrangement that makes a handful of these models refuse to answer anywhere
 * else, which is why the ones Atomic cannot use say so on their own row. Someone
 * who wants to know where the tokens are coming from can find out here, without
 * having to discover it from a 403.
 *
 * Not a warning against using them, and not a paywall notice: they are the
 * default and the good option. It is the one sentence that keeps "free" from
 * quietly meaning "unlimited".
 */
function ZenFreeTierWarning() {
  return (
    <p className="rounded border border-border bg-surface-sunken px-2 py-1.5 text-[11px] leading-snug text-content-muted">
      <span className="font-medium text-content">Free tier:</span> these need no API
      key. OpenCode funds them from the accounts used by its own app, and some of
      them are restricted to that app. A model Atomic has found cannot answer here
      is marked below, and Refresh rechecks it.
    </p>
  );
}

/**
 * The freeness groups a user can narrow to.
 *
 * Ordered free, then unknown, then paid -- the order a person deciding where to
 * look would read them in.
 */
const FREENESS_GROUPS: readonly (readonly [Freeness, string])[] = [
  ["free", "Free"],
  ["free-tier", "Free tier"],
  ["unknown", "Unknown"],
  ["paid", "Paid"],
];

/** One search box and the filters, shared by every section. */
function ModelFiltersBar({ catalog }: { readonly catalog: ModelCatalogState }) {
  const { filters, setFilters } = catalog;
  return (
    <div className="space-y-2">
      <Input
        aria-label="Search models"
        placeholder="Search by name, id, or provider"
        value={filters.query ?? ""}
        onChange={(event) => setFilters({ ...filters, query: event.target.value })}
      />
      <div className="flex flex-wrap gap-3 text-[11px] text-content-muted">
        {(
          [
            /*
             * No "free only" checkbox here. The Free and Free tier chips below
             * are the same filter with the cases named, and having both meant
             * three controls whose labels overlapped: this one, the chips, and
             * the spending policy in the header. The chips win because they can
             * also show Unknown, which the checkbox cannot express.
             */
            ["toolsOnly", "Supports tools"],
            ["localOnly", "Local only"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={filters[key] === true}
              onChange={(event) => setFilters({ ...filters, [key]: event.target.checked || undefined })}
            />
            {label}
          </label>
        ))}
      </div>
      {/* Free / Unknown / Paid as separate groups rather than one "not free"
          bucket. Unknown is the group that needs reading: it is every model
          whose price nobody has published, and collapsing it into "paid" would
          either hide it or libel it. */}
      <div className="flex flex-wrap gap-2 text-[11px] text-content-muted">
        {FREENESS_GROUPS.map(([value, label]) => {
          const on = filters.freeness?.includes(value) ?? false;
          return (
            <label key={value} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={on}
                onChange={(event) => {
                  const next = new Set(filters.freeness ?? []);
                  if (event.target.checked) next.add(value);
                  else next.delete(value);
                  setFilters({ ...filters, freeness: next.size ? [...next] : undefined });
                }}
              />
              {label}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ProviderCatalogSection({
  api,
  section,
  catalog,
  settings,
  mode,
  onPick,
  onApplySettings,
}: {
  readonly api: HostApi;
  readonly section: ModelCatalogState["sections"][number];
  readonly catalog: ModelCatalogState;
  readonly settings: Settings;
  readonly mode: Mode;
  readonly onPick: (mode: Mode, modelId: string, providerId: string) => void;
  readonly onApplySettings: (next: Settings) => void;
}) {
  const filtered = useMemo(
    () => filterSectionModels(section.models, catalog.filters),
    [section.models, catalog.filters],
  );
  const selected = selectionKey(settings, mode);
  // Counted from the *unfiltered* list, so the summary does not change meaning
  // when a search box is used: it is a statement about what this provider offers,
  // not about what the filters happen to be showing right now.
  const breakdown = useMemo(() => freenessBreakdown(section.models), [section.models]);

  return (
    <Card>
      <CardHeader>
        <div className="flex w-full items-center gap-2">
          <CardTitle className="flex-1">{section.providerLabel}</CardTitle>
          <SectionStatus section={section} />
          <Button size="sm" variant="ghost" onClick={catalog.reload} disabled={catalog.refreshing}>
            {catalog.refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </CardHeader>
      <CardBody className="space-y-2">
        {section.unconfigured ? <AddKeyPrompt providerId={section.providerId} /> : null}
        {section.providerId === ZEN_PROVIDER_ID ? <ZenFreeTierWarning /> : null}
        {section.unconfigured || section.models.length === 0 ? null : (
          // The number is the point. "Free" without a count leaves the user
          // hunting through badges to find out whether switching provider is
          // worth anything, which is the question this page exists to answer.
          <FreeOptionsSummary breakdown={breakdown} />
        )}

        {section.unconfigured ? null : section.models.length === 0 ? (
          <p className="text-[11px] text-content-muted">
            {section.providerId === "ollama"
              ? "No models installed. Pull one below to get started."
              : "This provider returned no models."}
          </p>
        ) : (
          <>
            {section.stale ? (
              <p role="status" className="text-[11px] text-content-muted">
                Showing the last known models. {section.error ?? "The last refresh failed."}
              </p>
            ) : section.error ? (
              <p role="alert" className="text-[11px] text-danger">
                {section.error}{" "}
                <button type="button" className="underline underline-offset-2" onClick={catalog.reload}>
                  Retry
                </button>
              </p>
            ) : null}
            {filtered.length === 0 ? (
              <p className="text-[11px] text-content-muted">
                No models match the current search or filters.
              </p>
            ) : (
              <ul className="space-y-1">
                {filtered.map((model) => (
                  <ModelRow
                    key={model.key}
                    model={model}
                    selected={selected === model.key}
                    onPick={() => void onPick(mode, model.id, model.providerId)}
                  />
                ))}
              </ul>
            )}
          </>
        )}

        {section.providerId === "ollama" ? (
          <OllamaControls
            api={api}
            catalog={catalog}
            settings={settings}
            onSettings={onApplySettings}
            reachable={section.status === "connected"}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

function SectionStatus({ section }: { readonly section: ModelCatalogState["sections"][number] }) {
  const when = section.fetchedAt ? new Date(section.fetchedAt).toLocaleTimeString() : null;
  const label =
    section.unconfigured
      ? "No key"
      : section.status === "connected"
        ? section.stale
          ? "Cached"
          : `${section.models.length} models`
        : section.status === "unconfigured"
          ? "No key"
          : "Unreachable";
  return (
    <span className="text-[11px] text-content-muted" title={when ? `Last refreshed ${when}` : undefined}>
      {label}
    </span>
  );
}

function AddKeyPrompt({ providerId }: { readonly providerId: string }) {
  return (
    <p className="text-[11px] text-content-muted">
      No API key saved for {providerId}. Add one on the <strong>API keys</strong> tab to see
      the models it provides.
    </p>
  );
}

function ModelRow({
  model,
  selected,
  onPick,
}: {
  readonly model: ModelOption;
  readonly selected: boolean;
  readonly onPick: () => void;
}) {
  return (
    // A column when there is something to say, so the reason gets a full line.
    // Truncated into the row it would be exactly the text nobody can read,
    // which is the text a person needs most.
    <li
      className={cn(
        "flex gap-2",
        model.unavailableReason || model.suspectedReason ? "flex-col" : "items-center",
      )}
    >
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
        <input type="radio" name="default-model" checked={selected} onChange={onPick} />
        <span className="min-w-0 flex-1 truncate text-xs text-content">
          {model.name}
          {/* The section heading already names the provider, so this is
              redundant here on purpose -- it is omitted rather than repeated. */}
          {model.contextWindow ? (
            <span className="ml-1 text-[10px] text-content-muted">
              {formatContext(model.contextWindow)} ctx
            </span>
          ) : null}
        </span>
        <BadgeList model={model} />
      </label>
      {model.unavailableReason ? (
        <p className="text-[10px] text-content-muted pl-6 leading-snug">
          Unusable from Atomic: {model.unavailableReason}
        </p>
      ) : null}
      {model.suspectedReason ? (
        // Deliberately not "unusable". One refusal is not a verdict, and saying
        // so is what stops the user writing a free model off over a hiccup --
        // the reason this state exists separately from the one above.
        <p className="text-[10px] text-content-muted pl-6 leading-snug">
          Refused once by the provider, so it has been kept out of Auto. It is still
          selectable, and one retry is worth making. {model.suspectedReason}
        </p>
      ) : null}
    </li>
  );
}

/**
 * "N free of M" for one provider.
 *
 * Shown as a line rather than a badge so it can be read without counting the
 * rows, and worded to say what it counted: models this provider offers that
 * Atomic can actually use.
 */
/**
 * How a provider's models divide up, counted by the same value the badge reads.
 *
 * Every count here is a tally over one freeness value, so the header cannot
 * disagree with the rows: a model badged "free tier" lands in the free-tier
 * column because that is the badge it carries, and there is no second place for
 * it to be counted.
 */
interface FreenessBreakdown {
  readonly total: number;
  readonly free: number;
  readonly freeTier: number;
  readonly paid: number;
  readonly unknown: number;
  readonly unusable: number;
}

function freenessBreakdown(models: readonly ModelOption[]): FreenessBreakdown {
  const counts: Record<Freeness, number> = { free: 0, "free-tier": 0, paid: 0, unknown: 0 };
  for (const model of models) counts[model.freeness] += 1;
  return {
    total: models.length,
    free: counts.free,
    freeTier: counts["free-tier"],
    paid: counts.paid,
    unknown: counts.unknown,
    // Counted separately rather than removed from a category: a model that is
    // both free and currently refused is still a free model, and hiding it
    // behind a smaller total is what made the two numbers feel like different
    // statements about the same list.
    unusable: models.filter((model) => model.unavailableReason !== undefined).length,
  };
}

function FreeOptionsSummary({ breakdown }: { readonly breakdown: FreenessBreakdown }) {
  const { total, free, freeTier, paid, unknown, unusable } = breakdown;

  if (free === total) {
    return (
      <p className="text-[11px] text-content-muted">
        All {total} available {total === 1 ? "model is" : "models are"} free to use.
        {unusable > 0 ? ` ${unusable} of them ${unusable === 1 ? "is" : "are"} unusable in Atomic.` : ""}
      </p>
    );
  }

  // Spelled out per category rather than collapsed into a single "free" number.
  // Collapsing is what produced the original disagreement: a provider with 12
  // free, 3 free tier and 2 unknown models announced "12 free of 17", and the
  // other five rows were badged in words the header never mentioned.
  const parts = [
    free > 0 ? `${free} free` : null,
    freeTier > 0 ? `${freeTier} free tier` : null,
    unknown > 0 ? `${unknown} unknown` : null,
    paid > 0 ? `${paid} paid` : null,
  ].filter((part) => part !== null);

  return (
    <p className="text-[11px] text-content-muted">
      {parts.join(" · ")}, of {total} {total === 1 ? "model" : "models"}.
      {free === 0
        ? " Nothing here is confirmed free, so Auto will not choose from this provider."
        : ""}
      {unusable > 0
        ? ` ${unusable} ${unusable === 1 ? "is" : "are"} marked unusable in Atomic.`
        : ""}
    </p>
  );
}

function BadgeList({ model }: { readonly model: ModelOption }) {
  return (
    <span className="flex shrink-0 gap-1">
      {model.local ? <Badge tone="info">local</Badge> : null}
      {model.verifiedReachable ? <Badge tone="success">reachable</Badge> : null}
      {model.unavailableReason ? <Badge tone="warning">unusable</Badge> : null}
      {model.suspectedReason ? <Badge tone="warning">refused once</Badge> : null}
      <Badge tone={freenessTone(model.freeness)}>{FREENESS_LABELS[model.freeness]}</Badge>
      {model.tools ? <Badge>tools</Badge> : null}
      {model.vision ? <Badge>vision</Badge> : null}
      {model.reasoning ? <Badge>reasoning</Badge> : null}
    </span>
  );
}

function freenessTone(freeness: Freeness): "success" | "warning" | "neutral" {
  if (freeness === "free") return "success";
  if (freeness === "free-tier") return "warning";
  return "neutral";
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1000)}k`;
}

/** The pull / delete controls, which only make sense for a local Ollama. */
function OllamaControls({
  api,
  catalog,
  settings,
  onSettings,
  reachable,
}: {
  readonly api: HostApi;
  readonly catalog: ModelCatalogState;
  readonly settings: Settings;
  readonly onSettings: (next: Settings) => void;
  readonly reachable: boolean;
}) {
  const [model, setModel] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = settings.providers.ollama?.baseUrl ?? "";
  const [url, setUrl] = useState(saved);
  /** What the last save found at the entered URL, before it was applied. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // Only what is actually installed locally. A hosted model has nothing to
  // remove, and offering a delete for one would be a button that cannot work.
  const installed = catalog.models.filter((entry) => entry.local);

  const remove = useCallback(
    async (target: string) => {
      setConfirmRemove(null);
      setBusy(true);
      setError(null);
      const result = await api.ollamaDelete(target);
      setBusy(false);
      if (!result.ok) {
        setError(result.message ?? `Could not remove ${target}.`);
        return;
      }
      catalog.reload();
    },
    [api, catalog],
  );

  /**
   * Apply a URL, and say whether anything answered before keeping it.
   *
   * Saving an address that is not serving is the mistake that looks like a
   * working app: every later failure is reported against the models rather than
   * the endpoint they never arrived at. The check runs on the typed value
   * because that is the value the user is about to be stuck with.
   */
  const saveUrl = useCallback(async () => {
    const target = url.trim() || OLLAMA_DEFAULT_ROOT;
    setError(null);
    /*
     * Checked here rather than left to the host, so the message appears beside
     * the field the user is looking at. The host rejects the same address, and
     * the settings store now rolls a failed write back rather than reporting a
     * change it did not make -- but both of those are invisible from here, and
     * a save that silently does nothing reads as a broken button.
     */
    try {
      ollamaRootFrom(target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    setBusy(true);
    try {
      const next = await api.updateSettings({
        providers: { ollama: { baseUrl: target } },
      });
      onSettings(next);
      // The cache is keyed per host, so the previous URL's list has to be
      // refetched rather than reused.
      catalog.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [api, catalog, onSettings, url]);

  const pull = useCallback(async () => {
    const target = model.trim();
    if (!target) return;
    setBusy(true);
    setError(null);
    setProgress("starting…");
    const result = await api.ollamaPull(target, (update) => {
      const completed = update.completed ?? 0;
      if (update.total && update.total > 0) {
        const pct = Math.min(100, Math.round((completed / update.total) * 100));
        setProgress(`${update.status} ${pct}%`);
      } else {
        setProgress(update.status);
      }
    });
    setBusy(false);
    setProgress(null);
    if (!result.ok) {
      setError(result.message ?? "The pull failed.");
      return;
    }
    setModel("");
    catalog.reload();
  }, [api, model, catalog]);

  return (
    <div className="space-y-2 border-t border-border pt-2">
      <div className="flex gap-2">
        <Input
          aria-label="Ollama server URL"
          placeholder={OLLAMA_DEFAULT_ROOT}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={url === saved || busy}
          onClick={() => void saveUrl()}
        >
          Save
        </Button>
      </div>
      {!reachable ? (
        <p className="text-[11px] text-content-muted">
          Nothing is answering at this URL. Start Ollama with{" "}
          <code className="text-content">ollama serve</code>, or point this at wherever it
          runs, then Refresh.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Input
          aria-label="Ollama model to pull"
          placeholder="model to pull, e.g. qwen3-coder:30b"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
        {busy ? (
          <Button size="sm" variant="ghost" onClick={() => api.cancelOllamaPull()}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" onClick={() => void pull()} disabled={!model.trim()}>
            Pull
          </Button>
        )}
      </div>
      {progress ? (
        <p role="status" className="text-[11px] text-content-muted">
          {progress}
        </p>
      ) : null}
      {installed.length > 0 ? (
        <div className="space-y-1 border-t border-border pt-2">
          <p className="text-[11px] text-content-muted">Installed on this machine</p>
          {installed.map((entry) => (
            <div key={entry.key} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-content">
                {entry.name}
              </span>
              {confirmRemove === entry.id ? (
                <>
                  {/* Deleting a model is not undoable and there is no copy kept
                      anywhere, so it gets the same treatment as anything else
                      that destroys work: a second, explicit press. */}
                  <span className="text-[11px] text-content-muted">
                    Remove {entry.name}?
                  </span>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() => void remove(entry.id)}
                  >
                    Remove
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmRemove(null)}
                  >
                    Keep
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmRemove(entry.id)}
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-[11px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CatalogSkeleton() {
  return (
    <div role="status" aria-live="polite" className="space-y-2">
      <span className="sr-only">Loading models…</span>
      {[0, 1].map((row) => (
        <div key={row} className="h-9 animate-pulse rounded bg-surface-sunken" />
      ))}
    </div>
  );
}

/**
 * Apply the shared filters to one section's rows, without re-deriving the
 * catalog.
 *
 * Delegates to the core filter rather than reimplementing it. The two copies
 * disagreed -- this one honoured `freeness` and the header picker's did not --
 * so the same chips narrowed the list in one place and did nothing in the
 * other, and there was no way to tell which of them was wrong.
 */
function filterSectionModels(
  models: readonly ModelOption[],
  filters: ModelFilters,
): readonly ModelOption[] {
  const asCatalog: readonly CatalogModel[] = models.map(toCatalogModel);
  const kept = new Set(
    filterModels(asCatalog, filters).map((model) => catalogKey(model.providerId, model.id)),
  );
  return models.filter((model) => kept.has(catalogKey(model.providerId, model.id)));
}

/**
 * The shape the core filter takes.
 *
 * Named here because the header picker needs the same projection, and two
 * projections that drift produce exactly the bug the delegation above fixes.
 */
export function toCatalogModel(model: ModelOption): CatalogModel {
  return {
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
  };
}
