import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AUTO_MODEL,
  FREENESS_LABELS,
  formatBytes,
  parseCatalogKey,
  selectionKey,
  OLLAMA_DEFAULT_ROOT,
  ZEN_PROVIDER_ID,
  type Freeness,
  type Mode,
  type ModelFilters,
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
      ) : null}
    </div>
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
      <ModeDefaults settings={settings} catalog={catalog} onPick={pick} />

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
            ["freeOnly", "Free only"],
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

/**
 * The three per-mode defaults, above the catalog.
 *
 * Placed here rather than in each section because a mode's default is the one
 * setting that is not scoped to a provider: it is the answer to "what does Chat
 * use", and the answer may be any of them.
 */
function ModeDefaults({
  settings,
  catalog,
  onPick,
}: {
  readonly settings: Settings;
  readonly catalog: ModelCatalogState;
  readonly onPick: (mode: Mode, modelId: string, providerId: string) => void;
}) {
  const modes: readonly Mode[] = ["chat", "cowork", "code"];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Defaults per mode</CardTitle>
      </CardHeader>
      <CardBody className="space-y-2">
        {modes.map((mode) => (
          <label key={mode} className="flex items-center gap-3">
            <span className="w-16 text-[11px] capitalize text-content-muted">{mode}</span>
            <Select
              aria-label={`Default model for ${mode} mode`}
              className="h-7 flex-1 text-xs"
              value={selectionKey(settings, mode) ?? AUTO_MODEL}
              disabled={catalog.models.length === 0}
              onChange={(event) => {
                if (event.target.value === AUTO_MODEL) {
                  void onPick(mode, AUTO_MODEL, settings.providerId);
                  return;
                }
                const parsed = parseCatalogKey(event.target.value);
                if (parsed) void onPick(mode, parsed.modelId, parsed.providerId);
              }}
            >
              <option value={AUTO_MODEL}>
                {mode === "chat" && catalog.auto?.modelName
                  ? `Auto — ${catalog.auto.modelName}`
                  : "Auto (best free)"}
              </option>
              {catalog.models.map((model) => (
                <option key={model.key} value={model.key}>
                  {model.providerLabel} / {model.name}
                </option>
              ))}
            </Select>
          </label>
        ))}
        <p className="text-[11px] text-content-muted">
          A model id only means something together with its provider, so each mode records
          both. Auto picks the best free model from the active provider.
        </p>
      </CardBody>
    </Card>
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
  const freeOptions = useMemo(
    () =>
      section.models.filter(
        (model) => model.freeness === "free" && !model.unavailableReason,
      ),
    [section.models],
  );

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
          <FreeOptionsSummary count={freeOptions.length} total={section.models.length} />
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
function FreeOptionsSummary({ count, total }: { readonly count: number; readonly total: number }) {
  if (count === total) {
    return (
      <p className="text-[11px] text-content-muted">
        All {total} available {total === 1 ? "model is" : "models are"} free to use.
      </p>
    );
  }
  return (
    <p className="text-[11px] text-content-muted">
      {count} free of {total} {total === 1 ? "model" : "models"}.
      {count === 0 ? " Nothing here is free, so Auto will not choose from this provider." : ""}
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
    setBusy(true);
    setError(null);
    const next = await api.updateSettings({
      providers: { ollama: { baseUrl: target } },
    });
    onSettings(next);
    // The cache is keyed per host, so the previous URL's list has to be
    // refetched rather than reused.
    catalog.reload();
    setBusy(false);
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

/** Apply the shared filters to one section's rows, without re-deriving the catalog. */
function filterSectionModels(
  models: readonly ModelOption[],
  filters: ModelFilters,
): readonly ModelOption[] {
  const query = filters.query?.trim().toLowerCase() ?? "";
  return models.filter((model) => {
    if (filters.freeOnly && model.freeness !== "free" && model.freeness !== "free-tier") return false;
    if (filters.freeness && !filters.freeness.includes(model.freeness)) return false;
    if (filters.toolsOnly && !model.tools) return false;
    if (filters.localOnly && !model.local) return false;
    if (!query) return true;
    return (
      model.id.toLowerCase().includes(query) ||
      model.name.toLowerCase().includes(query) ||
      model.providerLabel.toLowerCase().includes(query)
    );
  });
}
