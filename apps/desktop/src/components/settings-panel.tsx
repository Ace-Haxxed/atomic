/**
 * Settings.
 *
 * Five sections, in the order a user actually needs them: connect a provider,
 * pick a model, set how much the agent may do, say which folders the agent may
 * touch, then the app's own behaviour.
 *
 * Two rules hold everywhere in this file:
 *  - an API key is written straight to the keychain and never enters state, so
 *    it cannot be echoed back into the form after a save;
 *  - permission changes are applied immediately and the level selector refuses
 *    to move to `bypass` without acknowledging the warning once.
 */

import { useEffect, useMemo, useState } from "react";
import type {
  HostApi,
  Mode,
  PermissionLevel,
  PermissionModeSettings,
  Settings,
} from "@atomic/core";
import {
  AUTO_MODEL,
  FREENESS_LABELS,
  parseCatalogKey,
  selectionKey,
  PROVIDERS,
  MODES,
  PERMISSION_LEVELS,
  detectProviderFromKey,
  isConfident,
  modelProviderFor,
} from "@atomic/core";
import { useModels } from "../app/use-models.js";
import { AutoModelNote, FreenessLegend } from "./model-select.js";
import { ModelsTab } from "./models-tab.js";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Separator,
  Spinner,
  Switch,
  cn,
} from "@atomic/ui";

import { Icon } from "./sidebar.js";

export interface SettingsPanelProps {
  readonly api: HostApi;
  readonly initial: Settings;
  readonly mode: Mode;
  readonly onModeChange: (mode: Mode) => void;
  readonly onClose: () => void;
  readonly onSettings: (settings: Settings) => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings>(props.initial);
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [keyState, setKeyState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  // The result of the last connection test, kept structured rather than as a
  // pre-formatted string: the reason a test failed determines the colour, and a
  // rejected key must not be painted the same as a rate limit.
  const [connection, setConnection] = useState<{
    ok: boolean;
    outcome: string;
    message: string;
    detail?: string;
  } | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  // Kept separate from the connection-test result: a failed *save* is a
  // different problem from a rejected key, and they need different words.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [bypassOpen, setBypassOpen] = useState(false);

  useEffect(() => setSettings(props.initial), [props.initial]);

  // The catalog is a separate concern from the form, so a failure to reach the
  // provider cannot take the rest of Settings down with it. The hook owns
  // loading, the reason, and the retry.
  const catalog = useModels(props.api, {
    mode: props.mode,
    configured: settings.models[props.mode],
    onlyFree: settings.autoSelectFreeModelsOnly,
    // Auto ranks the mode's own provider, so "why this model" has to come from
    // the same one. Falling back to the global provider here showed a ranking
    // for a provider the mode was not actually using.
    providerId: modelProviderFor(settings, props.mode),
  });

  useEffect(() => {
    let cancelled = false;
    props.api
      .hasApiKey(settings.providerId)
      .then((present) => {
        if (!cancelled) setHasKey(present);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Only the provider id matters: a key is per provider, not per mode.
  }, [props.api, settings.providerId]);

  /** Apply a settings patch, and hand the result back so callers can adopt it. */
  const patch = async (
    update: Parameters<HostApi["updateSettings"]>[0],
  ): Promise<Settings | null> => {
    try {
      const next = await props.api.updateSettings(update);
      setSettings(next);
      props.onSettings(next);
      return next;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  // Recomputed on every keystroke. Pure, so this is cheap.
  const detected = useMemo(() => detectProviderFromKey(apiKey), [apiKey]);

  /**
   * Save the key under the provider this form is showing.
   *
   * The provider is taken from the form and never from the key's shape. Detection
   * used to re-point the whole app -- `settings.providerId` -- at the provider it
   * recognised, on the theory that holding the right key under the wrong provider
   * is a confusing state. It is a much worse one: saving a key silently moved the
   * active provider out from under the current chat and the model selection, and
   * the only way to store a second provider's key was to switch the app to that
   * provider first, so the app looked like it could hold one or two keys at most.
   *
   * A mismatching key is now a note under the field with a one-click "save it to
   * <provider>" that targets that provider's own slot, and nothing else changes.
   */
  const saveKey = async () => {
    // Clear the previous failure up front, so a successful save does not leave
    // the old error sitting next to the fresh "key saved" badge.
    setSaveError(null);
    setKeyState("saving");
    const target = settings.providerId;
    try {
      await props.api.setApiKey(target, apiKey.trim() || null);
      // Cleared immediately: the value now lives in the OS keychain, and leaving
      // it in a React state field is a liability with no benefit.
      setApiKey("");
      // Presence is re-read from the credential store rather than assumed from
      // the length of what was typed, so an unconfirmed write is not shown as a
      // success. `setApiKey` already throws in that case; this is the belt to
      // that braces, and it keeps the badge honest across a restart.
      setHasKey(await props.api.hasApiKey(target));
      setKeyState("saved");
      // A new key can change what the provider will answer, and the catalog is
      // cached, so refresh rather than leaving a stale list on screen.
      catalog.reload();
    } catch (error) {
      setKeyState("error");
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * Point the app at the detected provider.
   *
   * This changes the app's selected provider, which is what the Provider select
   * above already does -- so it is an explicit click on a labelled control, not
   * something a save does behind the user's back. The key itself is still saved
   * to whichever provider this form is showing.
   */
  const useDetectedProvider = async () => {
    if (!detected.providerId) return;
    const next = await patch({ providerId: detected.providerId });
    if (next) catalog.reload();
  };

  const test = async () => {
    setTesting(true);
    setConnection(null);
    setShowDetail(false);
    try {
      const result = await props.api.testConnection(settings.providerId);
      setConnection({
        ok: result.ok,
        outcome: result.outcome,
        message: result.ok
          ? `Key verified in ${result.latencyMs ?? 0} ms`
          : result.message,
        detail: result.detail,
      });
      // A verified key is the best moment to refresh the list.
      if (result.ok) catalog.reload();
    } catch (error) {
      setConnection({
        ok: false,
        outcome: "network",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  };

  const permission = settings.permissions[props.mode];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-surface-sunken">
      <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
        <header className="flex items-center gap-2">
          <h1 className="flex-1 text-base font-semibold text-content">
            Settings
          </h1>
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onClose}
            title="Close settings"
          >
            <Icon name="x" />
          </Button>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>Provider</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[11px] text-content-muted">
                  Provider
                </span>
                <Select
                  value={settings.providerId}
                  onChange={(event) =>
                    void patch({ providerId: event.target.value })
                  }
                >
                  {PROVIDERS.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-content-muted">
                  Base URL
                </span>
                <input
                  className="h-8 w-full rounded-md border border-border-base bg-surface px-2 text-sm text-content"
                  value={settings.providers[settings.providerId]?.baseUrl ?? ""}
                  placeholder="Default"
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      providers: {
                        ...settings.providers,
                        [settings.providerId]: {
                          ...(settings.providers[settings.providerId] ?? {
                            baseUrl: "",
                            apiKeySource: "unset" as const,
                            apiKeyEnvVar: "",
                          }),
                          baseUrl: event.target.value,
                        },
                      },
                    })
                  }
                />
              </label>
            </div>

            <div>
              <p className="mb-1 text-[11px] text-content-muted">
                API key — stored in your OS keychain, never in the app database
              </p>
              <div className="flex items-center gap-1.5">
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 flex-1 rounded-md border border-border-base bg-surface px-2 font-mono text-sm text-content"
                  placeholder={
                    hasKey ? "Saved — type to replace" : "Paste your key"
                  }
                  value={apiKey}
                  aria-describedby="api-key-detection"
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setKeyState("idle");
                  }}
                />
                <Button
                  size="sm"
                  onClick={() => void saveKey()}
                  disabled={keyState === "saving"}
                >
                  {keyState === "saving" ? (
                    <Spinner className="size-3" />
                  ) : (
                    "Save"
                  )}
                </Button>
                {hasKey ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setApiKey("");
                      void props.api
                        .setApiKey(settings.providerId, null)
                        .then(() => {
                          setHasKey(false);
                          setKeyState("saved");
                        })
                        .catch((error: unknown) => {
                          setKeyState("error");
                          setSaveError(
                            error instanceof Error
                              ? error.message
                              : String(error),
                          );
                        });
                    }}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
              {/*
                The key is the input; the provider is inferred from it. Saying so
                while the user is still typing means a wrong guess is corrected
                before it is ever saved, rather than discovered later as a 401.
              */}
              <p
                id="api-key-detection"
                className="mt-1 min-h-[14px] text-[11px]"
              >
                {detected.providerId ? (
                  <>
                    <span className="text-content-muted">Looks like a </span>
                    <span className="font-medium text-content">
                      {detected.label}
                    </span>
                    {detected.providerId === settings.providerId ? (
                      <span className="text-content-subtle">
                        {" "}
                        — this is the selected provider
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="ml-1 underline underline-offset-2"
                        onClick={() => void useDetectedProvider()}
                      >
                        select {detected.label} as the provider
                      </button>
                    )}
                  </>
                ) : apiKey.trim() ? (
                  <span className="text-content-subtle">
                    This key is not a shape Atomic recognises. It will be saved
                    for {providerLabel(settings.providerId)}.
                  </span>
                ) : null}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void test()}
                disabled={testing}
              >
                {testing ? "Testing…" : "Test connection"}
              </Button>
              {keyState === "saved" ? (
                <Badge tone="success">key saved</Badge>
              ) : null}
              {keyState === "error" ? (
                <Badge tone="danger">not saved</Badge>
              ) : null}
              {saveError ? (
                <span className="text-[11px] text-danger">{saveError}</span>
              ) : null}
              {connection ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={cn(
                      "text-[11px]",
                      // A rate limit is not a broken key, and telling the user
                      // to re-paste a key that works would be a wild goose chase.
                      connection.outcome === "rate-limited"
                        ? "text-warning"
                        : connection.ok
                          ? "text-success"
                          : "text-danger",
                    )}
                  >
                    {connection.message}
                  </span>
                  {connection.detail ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowDetail((open) => !open)}
                        className="text-[11px] text-content-muted underline underline-offset-2 hover:text-content"
                      >
                        {showDetail ? "Hide details" : "Details"}
                      </button>
                      {showDetail ? (
                        <pre className="mt-1 w-full overflow-x-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-surface-sunken p-2 text-[11px] text-content-muted">
                          {connection.detail}
                        </pre>
                      ) : null}
                    </>
                  ) : null}
                </span>
              ) : null}
            </div>
          </CardBody>
        </Card>

        <ModelsTab
          api={props.api}
          settings={settings}
          mode={props.mode}
          catalog={catalog}
          onSettings={(next: Settings) => {
            setSettings(next);
            props.onSettings(next);
          }}
        />

        <Card>
          <CardHeader>
            <CardTitle>Permissions</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="flex items-center gap-1 rounded-md border border-border-base p-0.5">
              {MODES.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => props.onModeChange(candidate)}
                  className={cn(
                    "h-6 flex-1 rounded text-[11px] font-medium capitalize transition-colors",
                    candidate === props.mode
                      ? "bg-accent text-accent-foreground"
                      : "text-content-muted hover:text-content",
                  )}
                >
                  {candidate}
                </button>
              ))}
            </div>

            {PERMISSION_LEVELS.map((level) => {
              const dangerous = level === "bypass";
              const selected = permission.level === level;
              return (
                <label
                  key={level}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5",
                    selected
                      ? "border-accent bg-accent-subtle"
                      : "border-border-base",
                  )}
                >
                  <input
                    type="radio"
                    name="permission-level"
                    className="mt-0.5"
                    checked={selected}
                    onChange={() => {
                      if (dangerous) {
                        setBypassOpen(true);
                        return;
                      }
                      void props.api.setPermission(props.mode, { level });
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-content">
                      {LEVEL_LABELS[level]}
                    </span>
                    <span className="block text-[11px] text-content-muted">
                      {LEVEL_DESCRIPTIONS[level]}
                    </span>
                  </span>
                  {dangerous ? <Badge tone="danger">danger</Badge> : null}
                </label>
              );
            })}

            <Switch
              label="Never ask clarifying questions"
              description="The agent makes its own call instead of stopping to ask."
              checked={permission.noQuestionsMode}
              onCheckedChange={(value) =>
                void props.api.setPermission(props.mode, {
                  noQuestionsMode: value,
                })
              }
            />
            <Switch
              label="Auto-accept file edits"
              description="Commands, network and MCP still ask."
              checked={permission.autoApprove.fileWrite}
              onCheckedChange={(value) =>
                void props.api.setPermission(props.mode, {
                  autoApprove: { ...permission.autoApprove, fileWrite: value },
                })
              }
            />
            <Switch
              label="Load project instructions"
              description="Reads AGENTS.md or ATOMIC.md from the workspace."
              checked={settings.loadProjectMemory}
              onCheckedChange={(value) =>
                void patch({ loadProjectMemory: value })
              }
            />

            <Separator />
            {/*
              The schema has always had hard limits on a single run. They were
              never editable, which made a value like `maxSpendUsd: 5` a constant
              the user could not reason about and could not raise.
            */}
            <RunLimits
              permission={permission}
              setPermission={props.api.setPermission}
              mode={props.mode}
            />

            <Separator />
            {/*
              Allow/deny lists. Deny is checked first by the gate, so an entry on
              both sides resolves to deny; the editor says so rather than leaving
              the user to work it out.
            */}
            <RuleLists
              permission={permission}
              setPermission={props.api.setPermission}
              mode={props.mode}
            />
          </CardBody>
        </Card>

        <FilesCard api={props.api} settings={settings} onPatch={patch} />

        <Card>
          <CardHeader>
            <CardTitle>App</CardTitle>
          </CardHeader>
          <CardBody className="space-y-1">
            <label className="block">
              <span className="mb-1 block text-[11px] text-content-muted">
                Theme
              </span>
              <Select
                value={settings.theme}
                onChange={(event) =>
                  void patch({ theme: event.target.value as Settings["theme"] })
                }
              >
                <option value="system">Match system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </Select>
            </label>
            <div className="flex items-center gap-3 py-1">
              <label className="flex-1" htmlFor="setting-font-size">
                <span className="block text-[11px] text-content-muted">
                  Interface text size
                </span>
                <span className="block text-[10px] text-content-subtle">
                  Applies everywhere, including this panel
                </span>
              </label>
              <input
                id="setting-font-size"
                type="range"
                min={11}
                max={22}
                step={1}
                value={settings.fontSize}
                onChange={(event) => {
                  void patch({ fontSize: Number(event.target.value) });
                }}
                className="w-32 accent-accent"
              />
              <span className="w-8 text-right text-[11px] tabular-nums text-content-muted">
                {settings.fontSize}
              </span>
            </div>
            <Switch
              label="Close to tray"
              description="Closing the window keeps Atomic running in the tray."
              checked={settings.app.closeToTray}
              onCheckedChange={(value) =>
                void patch({ app: { ...settings.app, closeToTray: value } })
              }
            />
            <Switch
              label="Launch at login"
              checked={settings.app.launchAtLogin}
              onCheckedChange={(value) =>
                void patch({ app: { ...settings.app, launchAtLogin: value } })
              }
            />
            <Switch
              label="Notify when a task finishes"
              checked={settings.notifications.onTaskComplete}
              onCheckedChange={(value) =>
                void patch({
                  notifications: {
                    ...settings.notifications,
                    onTaskComplete: value,
                  },
                })
              }
            />
          </CardBody>
        </Card>

        <p className="pb-6 text-[10px] text-content-muted">
          Telemetry is off and there is no analytics endpoint. Nothing in this
          app phones home except the model requests you start.
        </p>
      </div>

      {bypassOpen ? (
        <BypassWarning
          mode={props.mode}
          onCancel={() => setBypassOpen(false)}
          onConfirm={async () => {
            setBypassOpen(false);
            await props.api.setPermission(props.mode, {
              level: "bypass",
              bypassWarningAccepted: true,
            });
            const next = await props.api.getSettings();
            setSettings(next);
            props.onSettings(next);
          }}
        />
      ) : null}
    </div>
  );
}

const LEVEL_LABELS: Readonly<Record<PermissionLevel, string>> = {
  ask: "Ask every time",
  "auto-accept": "Auto-accept edits",
  plan: "Plan only",
  bypass: "Bypass all permissions",
};

const LEVEL_DESCRIPTIONS: Readonly<Record<PermissionLevel, string>> = {
  ask: "Every tool call that changes something waits for your approval.",
  "auto-accept": "File edits go through; commands and network still ask.",
  plan: "Read-only. The agent investigates and stops with a plan.",
  bypass: "Nothing asks. Only do this in a folder you can throw away.",
};

/**
 * Bypass is the one setting that removes the safety net, so it gets a modal and
 * a written acknowledgement instead of a checkbox.
 */
function BypassWarning({
  mode,
  onCancel,
  onConfirm,
}: {
  mode: Mode;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bypass-title"
    >
      <Card className="w-full max-w-sm border-danger/50">
        <CardHeader>
          <CardTitle id="bypass-title" className="text-danger">
            Turn off all permission checks?
          </CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-xs leading-relaxed text-content-muted">
            In <strong className="text-content">{mode}</strong> mode the agent
            will run commands, edit files and reach the network without asking.
            Only the built-in deny list still applies. A mistake here can delete
            work.
          </p>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={() => void onConfirm()}>
              I understand, bypass everything
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * Temperature, output cap and reasoning effort.
 *
 * Kept in one place because all three share a failure mode: the settings schema
 * validates the whole object, so a single out-of-range value would reject the
 * entire patch and silently leave the form lying about what is saved. Each
 * control therefore clamps before it writes, and the number fields commit on
 * blur so a half-typed "0" is not pushed to the provider mid-keystroke.
 */
function GenerationControls({
  settings,
  patch,
}: {
  readonly settings: Settings;
  readonly patch: (
    update: Parameters<HostApi["updateSettings"]>[0],
  ) => Promise<Settings | null>;
}) {
  const { temperature, maxOutputTokens, reasoningEffort } = settings.generation;

  return (
    <div className="space-y-2">
      <NumberRow
        id="setting-temperature"
        label="Temperature"
        hint="0 is most predictable, 2 is most creative"
        value={temperature}
        min={0}
        max={2}
        step={0.1}
        format={(value) => value.toFixed(1)}
        onCommit={(value) =>
          void patch({ generation: { temperature: clamp(value, 0, 2) } })
        }
      />
      <NumberRow
        id="setting-max-output"
        label="Max output tokens"
        hint="Longer answers cost more"
        value={maxOutputTokens}
        min={256}
        max={1_000_000}
        step={256}
        format={(value) => value.toLocaleString()}
        onCommit={(value) =>
          void patch({
            generation: {
              maxOutputTokens: Math.round(clamp(value, 256, 1_000_000)),
            },
          })
        }
      />
      <label className="flex items-center gap-3" htmlFor="setting-reasoning">
        <span className="w-28 shrink-0 text-[11px] text-content-muted">
          Reasoning effort
        </span>
        <Select
          id="setting-reasoning"
          value={reasoningEffort}
          onChange={(event) => {
            void patch({
              generation: {
                reasoningEffort: event.target
                  .value as Settings["generation"]["reasoningEffort"],
              },
            });
          }}
        >
          {REASONING_EFFORTS.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
}

const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

function NumberRow({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onCommit,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  readonly onCommit: (value: number) => void;
}) {
  // Local state while typing, so a partial number is not fought by the prop.
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  return (
    <div className="flex items-center gap-3">
      <label className="flex w-28 shrink-0 flex-col" htmlFor={id}>
        <span className="text-[11px] text-content-muted">{label}</span>
        <span className="text-[10px] text-content-subtle">{hint}</span>
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={draft}
        onFocus={() => setFocused(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setFocused(false);
          const parsed = Number(draft);
          if (!Number.isFinite(parsed) || parsed === value) {
            setDraft(String(value));
            return;
          }
          onCommit(parsed);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="h-8 w-28 rounded-md border border-border-base bg-surface px-2 text-sm text-content focus:border-accent focus:outline-none"
        aria-describedby={`${id}-value`}
      />
      <span id={`${id}-value`} className="text-[11px] text-content-subtle">
        {format(value)}
      </span>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Hard stops for a single run.
 *
 * `0` means unlimited, which is what the schema promises, so each field says so
 * rather than showing a bare zero that reads like "do nothing".
 */
function RunLimits({
  permission,
  setPermission,
  mode,
}: {
  readonly permission: PermissionModeSettings;
  readonly setPermission: HostApi["setPermission"];
  readonly mode: Mode;
}) {
  const commit = (update: Partial<PermissionModeSettings>) =>
    void setPermission(mode, update);

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-content-muted">
        Limits for a single run.{" "}
        <span className="text-content-subtle">0 means no limit.</span>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <LimitInput
          id="limit-steps"
          label="Max steps"
          value={permission.maxSteps}
          min={0}
          step={10}
          suffix=""
          onCommit={(value) =>
            commit({ maxSteps: Math.round(Math.max(0, value)) })
          }
        />
        <LimitInput
          id="limit-runtime"
          label="Max runtime"
          value={permission.maxRuntimeSeconds}
          min={0}
          step={60}
          suffix="min"
          onCommit={(value) =>
            commit({ maxRuntimeSeconds: Math.round(Math.max(0, value) * 60) })
          }
        />
        <LimitInput
          id="limit-spend"
          label="Max spend"
          value={permission.maxSpendUsd}
          min={0}
          step={1}
          suffix="USD"
          onCommit={(value) => commit({ maxSpendUsd: Math.max(0, value) })}
        />
      </div>
    </div>
  );
}

function LimitInput({
  id,
  label,
  value,
  min,
  step,
  suffix,
  onCommit,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly step: number;
  readonly suffix: string;
  readonly onCommit: (value: number) => void;
}) {
  // Runtime is stored in seconds but is far clearer in minutes. The input shows
  // the same unit as its label, and `onCommit` converts back, so the number the
  // user reads and the number the user types are the same number.
  const shown = suffix === "min" ? Math.round(value / 60) : value;
  const [draft, setDraft] = useState(String(shown));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(shown));
  }, [shown, focused]);

  return (
    <label
      className="flex items-center gap-1.5 text-[11px] text-content-muted"
      htmlFor={id}
    >
      <span>{label}</span>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        step={step}
        value={draft}
        onFocus={() => setFocused(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setFocused(false);
          const parsed = Number(draft);
          if (!Number.isFinite(parsed)) {
            setDraft(String(shown));
            return;
          }
          onCommit(parsed);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="h-7 w-20 rounded-md border border-border-base bg-surface px-1.5 text-[11px] text-content focus:border-accent focus:outline-none"
      />
      {suffix ? <span className="text-content-subtle">{suffix}</span> : null}
    </label>
  );
}

type ListKey =
  | "allowedCommands"
  | "deniedCommands"
  | "allowedDomains"
  | "deniedDomains"
  | "allowedPaths"
  | "deniedPaths";

const LIST_SPECS: readonly {
  readonly key: ListKey;
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
}[] = [
  {
    key: "allowedCommands",
    label: "Allowed commands",
    hint: "Glob patterns, e.g. npm run *",
    placeholder: "npm run *",
  },
  {
    key: "deniedCommands",
    label: "Denied commands",
    hint: "Checked first, so deny always wins",
    placeholder: "rm -rf *",
  },
  {
    key: "allowedPaths",
    label: "Allowed paths",
    hint: "Directories the agent may write to",
    placeholder: "/home/you/projects",
  },
  {
    key: "deniedPaths",
    label: "Denied paths",
    hint: "Checked first, so deny always wins",
    placeholder: "~/.ssh",
  },
  {
    key: "allowedDomains",
    label: "Allowed domains",
    hint: "Hostnames the agent may reach",
    placeholder: "example.com",
  },
  {
    key: "deniedDomains",
    label: "Denied domains",
    hint: "Checked first, so deny always wins",
    placeholder: "*.internal.example",
  },
];

/** Allow and deny lists, one row per kind, editable in place. */
function RuleLists({
  permission,
  setPermission,
  mode,
}: {
  readonly permission: PermissionModeSettings;
  readonly setPermission: HostApi["setPermission"];
  readonly mode: Mode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-content-muted">
        Allow and deny rules. Deny is evaluated first, so an entry on both lists
        resolves to deny.
      </p>
      {LIST_SPECS.map((spec) => (
        <RuleList
          key={spec.key}
          spec={spec}
          values={permission[spec.key]}
          onChange={(values) =>
            void setPermission(mode, { [spec.key]: values })
          }
        />
      ))}
    </div>
  );
}

function RuleList({
  spec,
  values,
  onChange,
}: {
  readonly spec: (typeof LIST_SPECS)[number];
  readonly values: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
}) {
  const [entry, setEntry] = useState("");

  const add = () => {
    const trimmed = entry.trim();
    // A duplicate is silently ignored by the gate, so refuse it here where the
    // reason is visible.
    if (!trimmed || values.includes(trimmed)) {
      setEntry("");
      return;
    }
    onChange([...values, trimmed]);
    setEntry("");
  };

  return (
    <div className="space-y-1">
      <label className="flex items-baseline gap-2" htmlFor={`rule-${spec.key}`}>
        <span className="text-[11px] text-content-muted">{spec.label}</span>
        <span className="text-[10px] text-content-subtle">{spec.hint}</span>
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          id={`rule-${spec.key}`}
          value={entry}
          placeholder={spec.placeholder}
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          className="h-7 flex-1 font-mono text-[11px]"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={add}
          disabled={!entry.trim()}
        >
          Add
        </Button>
      </div>
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {values.map((value) => (
            <li key={value}>
              <Badge tone={spec.key.startsWith("denied") ? "danger" : "info"}>
                <span className="font-mono">{value}</span>
                <button
                  type="button"
                  aria-label={`Remove ${value}`}
                  className="ml-1 opacity-60 hover:opacity-100"
                  onClick={() =>
                    onChange(
                      values.filter((entryValue) => entryValue !== value),
                    )
                  }
                >
                  ×
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[10px] text-content-subtle">None</p>
      )}
    </div>
  );
}

/** A readable name for a provider id, falling back to the raw id. */
function providerLabel(providerId: string): string {
  return (
    PROVIDERS.find((provider) => provider.id === providerId)?.label ??
    providerId
  );
}

/**
 * Folders the agent may use besides the open workspace.
 *
 * The wording here is the load-bearing part. This is a grant of file access, and
 * the only thing standing between "add a folder" and "read my SSH keys" is that
 * the user picks the folder -- the model can name a path all it likes, but it
 * cannot add a root, and a path outside every folder here is refused. So the
 * list says what it is, and says that the model picks nothing.
 */
function FilesCard({
  api,
  settings,
  onPatch,
}: {
  readonly api: HostApi;
  readonly settings: Settings;
  readonly onPatch: (update: Parameters<HostApi["updateSettings"]>[0]) => Promise<Settings | null>;
}) {
  const folders = settings.files?.allowedFolders ?? [];
  // A folder can arrive twice -- pasted by hand, or picked again after being
  // removed elsewhere. Adding it a second time would be a no-op that looks like a
  // success, so it is refused here with a reason rather than silently accepted.
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setError(null);
    const picked = await api.pickFolder("Choose a folder the agent may use");
    if (!picked) return;
    if (folders.some((folder) => folder.replace(/[/\\]+$/, "") === picked.replace(/[/\\]+$/, ""))) {
      setError(`${picked} is already on the list.`);
      return;
    }
    await onPatch({ files: { allowedFolders: [...folders, picked] } });
  };

  const remove = async (folder: string) => {
    setError(null);
    await onPatch({ files: { allowedFolders: folders.filter((entry) => entry !== folder) } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Files</CardTitle>
      </CardHeader>
      <CardBody className="space-y-2">
        <p className="text-[11px] text-content-muted">
          The agent can read and write inside the folder you open for a chat. Add
          folders here to let it work in those too -- it can use a folder you have
          listed, but it cannot add one itself.
        </p>
        {folders.length === 0 ? (
          <p className="text-[11px] text-content-muted">
            No extra folders. Only the folder a chat has open is usable.
          </p>
        ) : (
          <ul className="space-y-1">
            {folders.map((folder) => (
              <li
                key={folder}
                className="flex items-center gap-2 rounded-md border border-border-base px-2 py-1"
              >
                <span className="min-w-0 flex-1 truncate text-[11px]" title={folder}>
                  {folder}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Stop using ${folder}`}
                  onClick={() => void remove(folder)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error ? (
          <p role="alert" className="text-[11px] text-danger">
            {error}
          </p>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void add()}>
          Add folder
        </Button>
      </CardBody>
    </Card>
  );
}
