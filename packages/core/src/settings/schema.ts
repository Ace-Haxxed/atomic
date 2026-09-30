/**
 * Settings schema.
 *
 * Everything the user can change lives here, validated with zod. Safe defaults:
 * permission level is `ask` on every mode, bypass is off, telemetry is off.
 *
 * API keys are NOT here — they live in the OS keychain and are only referenced
 * by `apiKeySource`.
 *
 * zod v4 requires `.default()` to receive a fully-resolved value, so each
 * sub-schema's defaults are produced by parsing `{}` through the schema itself.
 * That keeps the declared defaults and the applied defaults from drifting.
 */

import { z } from "zod";
import { ReasoningEffortSchema } from "../models/types.js";

export const MODES = ["chat", "cowork", "code"] as const;
export const ModeSchema = z.enum(MODES);
export type Mode = z.infer<typeof ModeSchema>;

/**
 * Modes that can act on the machine.
 *
 * Chat is only a conversation, so a permission level there governs nothing that
 * can be granted. Surfacing "bypass" on a mode with no tools is alarming and
 * untrue at the same time, so the affordances that imply power are gated on this.
 */
export const TOOL_MODES = ["cowork", "code"] as const;
export const TOOL_MODE_SET: ReadonlySet<Mode> = new Set(TOOL_MODES);

/** True when the mode can call tools, so permission levels have something to gate. */
export function hasTools(mode: Mode): boolean {
  return TOOL_MODE_SET.has(mode);
}

/**
 * Whether the mode is live in this build.
 *
 * Kept next to `hasTools` so the two cannot drift: a mode with tools that is
 * not shipped shows a permission level the user can never exercise, and a mode
 * that is shipped without tools would offer approvals for nothing.
 */
const UNSHIPPED_MODES: ReadonlySet<Mode> = new Set<Mode>(["cowork"]);

export function isModeShipped(mode: Mode): boolean {
  return !UNSHIPPED_MODES.has(mode);
}

/** Ordered by increasing autonomy. `bypass` is deliberately last. */
export const PermissionLevelSchema = z.enum(["ask", "auto-accept", "plan", "bypass"]);
export const PERMISSION_LEVELS = PermissionLevelSchema.options;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const PERMISSION_LEVEL_LABELS: Readonly<Record<PermissionLevel, string>> = {
  ask: "Ask every time",
  "auto-accept": "Auto-accept edits",
  plan: "Plan only",
  bypass: "Bypass all permissions",
};

export const PERMISSION_LEVEL_DESCRIPTIONS: Readonly<Record<PermissionLevel, string>> = {
  ask: "Every tool call that changes anything waits for your approval.",
  "auto-accept": "File edits go through without asking. Commands and network still ask.",
  plan: "Read-only. The agent investigates and proposes a plan, then stops.",
  bypass: "Nothing asks. Only use this in a workspace you can throw away.",
};

/**
 * `file-read` is separate from `file-write` on purpose. Reads are governed by
 * `isReadOnlyTool` in the gate, and labelling them with a write-side category
 * would let a user's "auto-approve network" toggle silently wave through
 * `read_file`, which is a different decision entirely.
 */
export const TOOL_CATEGORIES = ["file-read", "file-write", "bash", "browser", "network", "mcp"] as const;
export const ToolCategorySchema = z.enum(TOOL_CATEGORIES);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

export const ApiKeySourceSchema = z.enum(["unset", "keychain", "env"]);

/** Patterns refused regardless of permission level, including bypass. */
export const DEFAULT_DENIED_COMMANDS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf *",
  "mkfs",
  "dd if=",
  ":(){",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "format ",
  "diskpart",
  "del /f /s /q",
  "chmod -R 777 /",
  "chown -R",
] as const;

export const ProviderSettingsSchema = z.object({
  /** Base URL override. Empty string means "use the provider default". */
  baseUrl: z.string().max(2048).default(""),
  /** How the key was supplied, for display only. The value never touches SQLite. */
  apiKeySource: ApiKeySourceSchema.default("unset"),
  /** Env var to read a key from, for users who prefer not to use the keychain. */
  apiKeyEnvVar: z.string().max(128).default(""),
});
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;
const providerDefaults = (): ProviderSettings => ProviderSettingsSchema.parse({});

export const ProviderModelsSchema = z.object({
  chat: z.string().default(""),
  cowork: z.string().default(""),
  code: z.string().default(""),
  lastUsed: z.string().default(""),
  /**
   * Which provider serves each mode's model.
   *
   * A model id is only unique within a provider -- several vendors publish a
   * `gpt-4o-mini` -- so a bare id cannot say where a request should go. Absent an
   * entry the mode falls back to the top-level `providerId`, which is what every
   * settings file written before this existed means, so old files keep working.
   */
  providers: z
    .object({
      chat: z.string().default(""),
      cowork: z.string().default(""),
      code: z.string().default(""),
    })
    .default(() => ({ chat: "", cowork: "", code: "" })),
});
export type ProviderModels = z.infer<typeof ProviderModelsSchema>;
const modelDefaults = (): ProviderModels => ProviderModelsSchema.parse({});

export const GenerationSettingsSchema = z.object({
  temperature: z.number().min(0).max(2).default(1),
  maxOutputTokens: z.number().int().min(256).max(1_000_000).default(8192),
  reasoningEffort: ReasoningEffortSchema.default("medium"),
  /** 0 means "use the model's own context window". */
  contextWindowOverride: z.number().int().min(0).default(0),
});
export type GenerationSettings = z.infer<typeof GenerationSettingsSchema>;
const generationDefaults = (): GenerationSettings => GenerationSettingsSchema.parse({});

export const AutoApproveSchema = z.object({
  fileWrite: z.boolean().default(false),
  bash: z.boolean().default(false),
  browser: z.boolean().default(false),
  network: z.boolean().default(false),
  mcp: z.boolean().default(false),
});
export type AutoApproveSettings = z.infer<typeof AutoApproveSchema>;
const autoApproveDefaults = (): AutoApproveSettings => AutoApproveSchema.parse({});

export const PermissionModeSettingsSchema = z.object({
  level: PermissionLevelSchema.default("ask"),
  /** The agent never asks clarifying questions; it makes its best call and continues. */
  noQuestionsMode: z.boolean().default(false),
  autoApprove: AutoApproveSchema.default(() => autoApproveDefaults()),
  /** Deny wins over every allow. Glob patterns; paths and commands are both supported. */
  allowedCommands: z.array(z.string().max(512)).default(() => []),
  deniedCommands: z.array(z.string().max(512)).default(() => [...DEFAULT_DENIED_COMMANDS]),
  allowedDomains: z.array(z.string().max(253)).default(() => []),
  deniedDomains: z.array(z.string().max(253)).default(() => []),
  allowedPaths: z.array(z.string().max(4096)).default(() => []),
  deniedPaths: z.array(z.string().max(4096)).default(() => []),
  /** Hard stops for a single run. 0 means unlimited. */
  maxSteps: z.number().int().min(0).default(200),
  maxRuntimeSeconds: z.number().int().min(0).default(1800),
  maxSpendUsd: z.number().min(0).default(5),
  /** Set only after the user acknowledges the one-time bypass warning. */
  bypassWarningAccepted: z.boolean().default(false),
});
export type PermissionModeSettings = z.infer<typeof PermissionModeSettingsSchema>;
/** A *fresh* copy per call: settings objects are handed to callers who may mutate them. */
export const permissionModeDefaults = (): PermissionModeSettings =>
  PermissionModeSettingsSchema.parse({});

export const NotificationSettingsSchema = z.object({
  onTaskComplete: z.boolean().default(true),
  onApprovalNeeded: z.boolean().default(true),
  sound: z.boolean().default(false),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;
const notificationDefaults = (): NotificationSettings => NotificationSettingsSchema.parse({});

export const AppSettingsSchema = z.object({
  globalHotkey: z.string().max(64).default("Alt+Space"),
  pushToTalkHotkey: z.string().max(64).default("Alt+Shift+V"),
  screenshotHotkey: z.string().max(64).default("Alt+Shift+S"),
  launchAtLogin: z.boolean().default(false),
  closeToTray: z.boolean().default(true),
  startMinimized: z.boolean().default(false),
  spellcheck: z.boolean().default(true),
  lastWindowWidth: z.number().int().min(480).default(1280),
  lastWindowHeight: z.number().int().min(360).default(860),
  sidebarCollapsed: z.boolean().default(false),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;
const appDefaults = (): AppSettings => AppSettingsSchema.parse({});

export const SlashCommandSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(256).default(""),
  prompt: z.string().max(20_000),
});

export const McpServerSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  transport: z.enum(["stdio", "http"]),
  command: z.string().max(1024).default(""),
  args: z.array(z.string().max(512)).default(() => []),
  env: z.record(z.string().max(256), z.string().max(1024)).default(() => ({})),
  url: z.string().max(2048).default(""),
  enabled: z.boolean().default(true),
});
export type McpServerSettings = z.infer<typeof McpServerSchema>;

export const SettingsSchema = z.object({
  version: z.number().int().default(1),
  onboardingCompleted: z.boolean().default(false),
  lastMode: ModeSchema.default("chat"),
  lastWorkspace: z.string().default(""),

  providerId: z.string().default("opencode-zen"),
  /**
   * When a mode's model is the `auto` sentinel, restrict automatic selection to
   * models the provider reports as costing nothing. On by default: auto-selecting
   * a paid model on the user's behalf is the one thing that must never happen
   * without them agreeing to it.
   */
  autoSelectFreeModelsOnly: z.boolean().default(true),
  providers: z.record(z.string().max(64), ProviderSettingsSchema).default(() => ({})),
  models: ProviderModelsSchema.default(() => modelDefaults()),
  generation: GenerationSettingsSchema.default(() => generationDefaults()),

  permissions: z
    .object({
      chat: PermissionModeSettingsSchema.default(() => permissionModeDefaults()),
      cowork: PermissionModeSettingsSchema.default(() => permissionModeDefaults()),
      code: PermissionModeSettingsSchema.default(() => permissionModeDefaults()),
    })
    // Factories, never object literals: zod reuses a literal default across every
    // parse, so one settings mutation would leak into every other settings object.
    .default(() => ({
      chat: permissionModeDefaults(),
      cowork: permissionModeDefaults(),
      code: permissionModeDefaults(),
    })),

  theme: z.enum(["light", "dark", "system"]).default("system"),
  fontSize: z.number().min(11).max(22).default(14),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
  language: z.string().max(16).default("en"),
  sendKey: z.enum(["enter", "cmd-enter"]).default("enter"),
  streamMarkdown: z.boolean().default(true),

  notifications: NotificationSettingsSchema.default(() => notificationDefaults()),
  app: AppSettingsSchema.default(() => appDefaults()),

  /** Appended to the system prompt in every mode. */
  customInstructions: z.string().max(20_000).default(""),
  customSlashCommands: z.array(SlashCommandSchema).default(() => []),
  mcpServers: z.array(McpServerSchema).default(() => []),

  /** No telemetry, ever, unless the user opts in. */
  telemetryEnabled: z.boolean().default(false),
  loadProjectMemory: z.boolean().default(true),
  checkpointsEnabled: z.boolean().default(true),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SlashCommandSettings = z.infer<typeof SlashCommandSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export function providerSettings(settings: Settings, providerId: string): ProviderSettings {
  return settings.providers[providerId] ?? providerDefaults();
}

export function permissionFor(settings: Settings, mode: Mode): PermissionModeSettings {
  return settings.permissions[mode];
}

/** True when any mode is unrestricted. Drives the persistent red indicator. */
export function isBypassActive(settings: Settings, mode?: Mode): boolean {
  if (mode) return permissionFor(settings, mode).level === "bypass";
  return MODES.some((m) => permissionFor(settings, m).level === "bypass");
}

/** The default model configured for a mode, if any. */
export function modelFor(settings: Settings, mode: Mode): string {
  return settings.models[mode] || settings.models.lastUsed;
}

/**
 * The provider that serves a mode's model.
 *
 * Prefers the per-mode provider, then the top-level one. The fallback is what
 * keeps every settings file written before per-mode providers existed working:
 * such a file has no per-mode entry, and its models all came from `providerId`.
 */
export function modelProviderFor(settings: Settings, mode: Mode): string {
  return settings.models.providers[mode] || settings.providerId;
}

/**
 * Set a mode's model, and the provider that serves it, together.
 *
 * Both are written in one place because writing one without the other produces
 * a model routed to a provider that has never heard of it.
 *
 * `lastUsed` is deliberately not touched. `modelFor` falls back to it for modes
 * with no explicit model, so updating it here would mean pinning `code` silently
 * repointed every unset mode at the same model.
 */
export function withModelForMode(
  settings: Settings,
  mode: Mode,
  model: string,
  providerId: string,
): Settings {
  return {
    ...settings,
    models: {
      ...settings.models,
      [mode]: model,
      providers: { ...settings.models.providers, [mode]: providerId },
    },
  };
}
