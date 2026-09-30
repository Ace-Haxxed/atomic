/**
 * `@atomic/core` public surface.
 *
 * Nothing in the UI should import from a deep path; everything the desktop app
 * needs is re-exported here. That keeps the boundary explicit and makes a future
 * move of implementation between the webview and a sidecar invisible to callers.
 */

export const CORE_VERSION = "0.1.0";

// ---- platform ------------------------------------------------------------
export {
  ARCHITECTURES,
  OS_PLATFORMS,
  describePlatform,
  isLinux,
  isMac,
  isWindows,
  normalizeArch,
  normalizeOs,
  type Architecture,
  type OsPlatform,
  type PlatformInfo,
} from "./platform/platform.js";
export {
  basename,
  dirname,
  extname,
  isAbsolutePath,
  isPathInside,
  joinPath,
  normalizePath,
  relativePath,
  resolvePath,
  shellQuote,
} from "./platform/paths.js";
export {
  SHELLS,
  buildShellCommand,
  describeShell,
  fallbackShell,
  quoteForShell,
  shellCandidates,
  type ShellInvocation,
  type ShellKind,
  type ShellProfile,
} from "./platform/shell.js";
export {
  APP_DIR_NAME,
  APP_ID,
  APP_NAME,
  DATABASE_FILE,
  LOG_FILE,
  assertResolvedDirs,
  assertSingleAppDir,
  databasePath,
  deriveAppDirs,
  logFilePath,
  resolveAppDirs,
  type AppDirs,
  type HostEnvironment,
  type ResolvedDirs,
} from "./platform/dirs.js";

// ---- settings ------------------------------------------------------------
export {
  DEFAULT_DENIED_COMMANDS,
  DEFAULT_SETTINGS,
  MODES,
  PERMISSION_LEVELS,
  TOOL_CATEGORIES,
  isBypassActive,
  permissionFor,
  type Mode,
  type PermissionLevel,
  type PermissionModeSettings,
  type Settings,
  type ToolCategory,
} from "./settings/schema.js";
export {
  setProviderDiagnostics,
  providerDiagnosticsEnabled,
  redactSecrets,
  type ProviderDiagnostic,
} from "./providers/diagnostics.js";
export {
  SettingsSchema,
  ProviderSettingsSchema,
  PermissionModeSettingsSchema,
  TOOL_MODES,
  hasTools,
  isModeShipped,
  modelFor,
  modelProviderFor,
  withModelForMode,
} from "./settings/schema.js";
export {
  SettingsStore,
  validateSettings,
  type SettingsListener,
} from "./settings/store.js";
export { authorizedRoots, hasAllowedFolders, withFolder } from "./settings/roots.js";

// ---- secrets -------------------------------------------------------------
export {
  MemorySecretStore,
  SecretKeys,
  LEGACY_PROVIDER_IDS,
  maskSecret,
  secretSlotsFor,
  withProvider,
  type ApiKeySource,
  type SecretStore,
} from "./secrets/secret-store.js";

// ---- storage -------------------------------------------------------------
export type {
  Bindable,
  Database,
  QueryResult,
  SqlValue,
} from "./storage/database.js";
export { toSqlValue } from "./storage/database.js";
export {
  configuredProviders,
  filterModels,
  filterSection,
  isKeylessProvider,
  catalogKey,
  isSectionFilteredOut,
  isUnconfigured,
  mergeModels,
  missingSelections,
  parseCatalogKey,
  resolveSelection,
  selectionKey,
  toCatalogModel,
  type CatalogModel,
  type MissingSelection,
  type ModelFilters,
  type ProviderModels,
  type ProviderStatus,
  type SectionFilters,
  type SelectionHealth,
  type SelectionState,
} from "./models/catalog-service.js";
export {
  OLLAMA_DEFAULT_ROOT,
  formatBytes,
  OllamaUrlError,
  ollamaRootFrom,
  OLLAMA_PROVIDER_ID,
  parsePullLine,
  parseShow,
  parseTags,
  toModelInfo,
  OllamaParseError,
  type OllamaModelDetail,
  type OllamaModelSummary,
  type OllamaPullProgress,
} from "./providers/ollama/catalog.js";
export { OllamaProvider } from "./providers/ollama/provider.js";
export {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  MigrationError,
  migrationChecksum,
  runMigrations,
  type Migration,
} from "./storage/migrations.js";
export {
  ConversationRepository,
  RunRepository,
  toModelMessages,
  type Conversation,
  type ConversationSummary,
  type StoredMessage,
} from "./storage/repositories.js";

// ---- models & providers --------------------------------------------------
export {
  EMPTY_USAGE,
  RoleSchema,
  ReasoningEffortSchema,
  addUsage,
  type ContentPart,
  type FinishReason,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type MessagePart,
  type ReasoningEffort,
  type Role,
  type StreamEvent,
  type ToolCall,
  type ToolSpec,
  type Usage,
} from "./models/types.js";
export {
  WIRE_FORMATS,
  type ModelCapabilities,
  type ModelCatalog,
  type ModelInfo,
  type Provider,
  type ProviderCredentials,
  type ProviderFactory,
  type ProviderRequestOptions,
  type WireFormat,
} from "./models/provider.js";
export {
  ProviderError,
  ProviderErrorKind,
  isAbort,
  isProviderError,
  toProviderError,
} from "./providers/errors.js";
export {
  detectProviderFromKey,
  isConfident,
  isDetectableProvider,
  type KeyConfidence,
  type KeyDetection,
} from "./providers/detect-key.js";
export {
  PROVIDERS,
  DEFAULT_PROVIDER,
  providerById,
  type ProviderDefinition,
  type ProviderDialect,
} from "./providers/registry.js";
export {
  HttpClient,
  redactUrl,
  type FetchLike,
  type HttpRequestInit,
} from "./providers/http.js";
export {
  parseSse,
  parseJsonLines,
  safeJsonParse,
  type SseEvent,
} from "./providers/sse.js";
export { ZenProvider, type ZenProviderDeps } from "./providers/zen/provider.js";
export {
  isEmptyConversation,
  pickConversationForMode,
  pruneEmptyConversations,
  type PickConversationResult,
} from "./host/empty-chat.js";
export {
  SUGGESTED_MODELS,
  ZEN_BASE_URL,
  ZEN_DOCS_URL,
  ZEN_MODELS_URL,
  ZEN_PROVIDER_ID,
  heuristicWireFormat,
  isNonChatModel,
  resolveWireFormat,
} from "./providers/zen/catalog.js";
export {
  MODELS_DEV_URL,
  readModelMetadata,
} from "./providers/zen/models-dev.js";
export { providerCacheKey } from "./providers/zen/provider.js";

// ---- tools & permissions -------------------------------------------------
export {
  ToolRegistry,
  fail,
  ok,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tools/registry.js";
export {
  DECISIONS,
  PermissionGate,
  isReadOnlyTool,
  type Decision,
  type PermissionOutcome,
  type PermissionRequest,
} from "./permissions/gate.js";
export {
  globForPlatform,
  globToRegExp,
  matchesAnyGlob,
} from "./permissions/glob.js";

// ---- agent ---------------------------------------------------------------
export {
  AgentEventBus,
  type AgentEvent,
  type AgentEventListener,
  type AgentEventType,
} from "./agent/events.js";
export {
  AgentLoop,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunDeps,
} from "./agent/loop.js";
export {
  ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
  type PendingApproval,
} from "./agent/approval.js";
export {
  compactMessages,
  estimateMessagesTokens,
  estimateTokens,
  planCompaction,
  totalUsage,
  type CompactionOptions,
  type CompactionPlan,
  type CompactionResult,
} from "./agent/compaction.js";
export {
  buildSystemPrompt,
  deriveTitle,
  type SystemPromptInput,
} from "./agent/system-prompt.js";

// ---- audit ---------------------------------------------------------------
export {
  AUDIT_KINDS,
  AuditLog,
  redact,
  redactText,
  type AuditEntry,
  type AuditKind,
  type AuditRow,
} from "./audit/audit-log.js";

// ---- host ----------------------------------------------------------------
export type {
  Attachment,
  ConversationExport,
  DeepPartial,
  HostApi,
  HostTransport,
  RunHandle,
  SendMessageInput,
  SendMessageResult,
  TestConnectionResult,
} from "./host/api.js";
export {
  LocalHost,
  defaultId,
  type HostServices,
  type LocalHostOptions,
} from "./host/local.js";
export { buildExport, toMarkdown } from "./host/export.js";

export {
  FREENESS,
  FREENESS_LABELS,
  freenessFor,
  isFreeEnough,
  knownCost,
  type Freeness,
  type FreenessDetail,
} from "./models/freeness.js";
export {
  WEIGHTS,
  rankModels,
  scoreModel,
  selectAutoModel,
  ineligibility,
  formatTokens,
  type AutoSelection,
  type RankedCatalog,
  type RankOptions,
  type ScoredModel,
  type Weights,
} from "./models/model-ranking.js";
export {
  FreePolicyError,
  checkModelPolicy,
  reviewTurnCost,
  turnCost,
  type FreePolicy,
  type PolicyDecision,
} from "./models/free-policy.js";
export {
  EMPTY_AVAILABILITY,
  REFUSALS_TO_CONFIRM,
  isAtomicGated,
  isSuspectedInAtomic,
  normalizeAvailability,
  wouldBlock,
  type AtomicAvailability,
  type AtomicAvailabilityMark,
  type MarkOptions,
} from "./providers/zen/atomic-availability.js";
export {
  AUTO_MODEL,
  AUTO_MODEL_LABEL,
  isAutoModel,
  resolveModelForMode,
  explainSelection,
  type ResolveInput,
  type ResolvedModel,
} from "./models/auto-model.js";
export {
  UNAVAILABLE_FILE_SYSTEM,
  UNAVAILABLE_PROCESS,
  UNAVAILABLE_CHECKPOINTS,
  type FileSystemPort,
  type ProcessPort,
  type CheckpointPort,
  type FolderAccessPort,
  type CheckpointRunInfo,
  type CheckpointFileInfo,
  type FileEntry,
  type ReadFileResult,
  type GrepMatch,
  type GrepResult,
  type RunResult,
} from "./host/ports.js";
export {
  createCodeTools,
  createFolderTools,
  createReadTools,
  createWriteTools,
  createShellTool,
  createGitTool,
  createTodoTool,
  contextDiff,
  type CodeToolDeps,
  type TodoItem,
  type TodoStore,
} from "./tools/index.js";

// Slash commands. Parsed in core so the composer's menu and the help text come
// from one list.
export {
  SLASH_COMMANDS,
  commandsFor,
  helpText,
  matchCommands,
  parseSlash,
  resolveCommandLine,
  type ParsedInput,
  type SlashCommand,
} from "./commands/slash.js";
