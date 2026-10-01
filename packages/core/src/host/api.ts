/**
 * The Host API.
 *
 * This is the only surface the UI is allowed to touch. Today it is implemented
 * in-process by `LocalHost`; tomorrow the same interface can be served over a
 * websocket (`atomic serve`) or driven from a phone, with no UI rewrite.
 *
 * Design rules:
 *  - every method is JSON-serialisable in and out
 *  - streaming is exposed as an async iterable, not a callback soup
 *  - nothing here leaks provider credentials
 */

import type { ApprovalDecision, PendingApproval } from "../agent/approval.js";
import type { AgentEvent, AgentEventBus } from "../agent/events.js";
import type { Mode, Settings } from "../settings/schema.js";
import type { CheckpointRunInfo } from "./ports.js";
import type { ModelInfo } from "../models/provider.js";
import type {
  MissingSelection,
  ProviderModels,
} from "../models/catalog-service.js";
import type { OllamaPullProgress } from "../providers/ollama/catalog.js";
import type { ApiKeySource } from "../secrets/secret-store.js";
import type { ContentPart, Usage } from "../models/types.js";
import type { AppDirs, HostEnvironment } from "../platform/dirs.js";
import type { PlatformInfo } from "../platform/platform.js";
import type { ShellProfile } from "../platform/shell.js";
import type {
  StoredMessage,
  ConversationSummary,
  Conversation,
} from "../storage/repositories.js";
import type { AuditRow } from "../audit/audit-log.js";
// The registry's own summary, not a second one shaped for the panel. A parallel
// type is a list to keep in step by hand, and this one has been wrong before in a
// way that read as "always allow" working.
import type { ExtensionSummary } from "../extensions/registry.js";

export interface SendMessageInput {
  readonly conversationId: string;
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  /** Overrides the per-mode model for this turn. */
  readonly model?: string;
  /**
   * Names the provider to send this turn to, alongside `model`.
   *
   * Only ever set from a user action -- accepting a provider-switch offer, or
   * picking a model in a provider's own row. A model id is not enough on its
   * own: `providerForModel` guesses from the catalog, and a guess that picks the
   * wrong account is the exact mistake this exists to prevent.
   */
  readonly providerId?: string;
  /** Regenerating an earlier message. */
  readonly parentId?: string | null;
  /** Per-chat system prompt override. */
  readonly systemPrompt?: string | null;
  /**
   * Consent to spend money on this one turn.
   *
   * Scoped to a single send rather than a global switch, because the decision
   * being made is about this model for this message. A global flag would make
   * one "yes" a standing answer to every future question, including ones about
   * models the user has never heard of.
   */
  readonly allowPaidModel?: boolean;
}

export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  /** base64 payload, or a `file://` URL the host can read. */
  readonly data: string;
  readonly size: number;
  /** Set when the file lives on disk rather than inlined. */
  readonly path?: string;
}

export interface SendMessageResult {
  readonly userMessage: StoredMessage;
  readonly runId: string;
}

export interface RunHandle {
  readonly runId: string;
  readonly conversationId: string;
  cancel(): void;
}

export interface ConversationExport {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: string;
}

export interface TestConnectionResult {
  readonly ok: boolean;
  /**
   * Which check decided this. `ok` alone cannot express the difference between
   * "your key is wrong" and "this model is switched off for you", and those need
   * different fixes.
   */
  readonly outcome:
    | "valid"
    | "rejected"
    | "model-unavailable"
    | "rate-limited"
    | "network"
    | "no-key"
    | "not-verifiable";
  readonly message: string;
  readonly modelsFound?: number;
  readonly latencyMs?: number;
  /** The provider's own words, for the details expander. Never a credential. */
  readonly detail?: string;
}

export interface HostApi {
  // ---- lifecycle -------------------------------------------------------
  getEnvironment(): Promise<{
    platform: PlatformInfo;
    shell: ShellProfile;
    dirs: AppDirs;
    version: string;
    /** `tauri`, `web`, or `node`, so the UI can hide native-only affordances. */
    readonly host: string;
  }>;

  // ---- settings --------------------------------------------------------
  getSettings(): Promise<Settings>;
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  setPermission(
    mode: Mode,
    patch: DeepPartial<Settings["permissions"][Mode]>,
  ): Promise<Settings>;
  /**
   * Save a provider's key into the OS credential store.
   *
   * Scoped to `providerId` and to nothing else: it does not change which
   * provider the app is pointed at, and it does not change the selected model.
   * `null` clears the key. The write is read back, presence only, so a
   * credential store that accepts a write and cannot return it is reported
   * instead of shown as "saved".
   */
  setApiKey(providerId: string, apiKey: string | null): Promise<Settings>;
  hasApiKey(providerId: string): Promise<boolean>;
  /**
   * Where each provider's credential comes from, for a per-provider key list.
   *
   * Presence only -- never a value. The UI needs to say "in your keychain",
   * "reached by GEMINI_API_KEY" and "no key yet" as three different facts.
   */
  apiKeySources(): Promise<Readonly<Record<string, ApiKeySource>>>;
  testConnection(providerId: string): Promise<TestConnectionResult>;

  // ---- models ----------------------------------------------------------
  listModels(forceRefresh?: boolean): Promise<readonly ModelInfo[]>;
  /**
   * Every model every configured provider can reach, one section per provider.
   *
   * Never rejects: a provider that is unreachable or has no key is reported as a
   * section with a `status` and an `error`, because a rejection here would make
   * one broken key look like "this app has no models".
   */
  listProviderModels(
    forceRefresh?: boolean,
    /** Called as each provider settles, so sections can render independently. */
    onSection?: (section: ProviderModels) => void,
  ): Promise<readonly ProviderModels[]>;
  /** Whether a provider holds a saved key, for the "Add key" prompts. */
  providerKeyStatus(): Promise<Readonly<Record<string, boolean>>>;
  /**
   * Download a model, reporting progress lines as they arrive.
   *
   * Resolves rather than rejects on a failed download, because "Ollama said no"
   * is a message to show next to the button that started it, not an exception
   * for the caller to catch. Cancel it with `cancelOllamaPull`.
   */
  ollamaPull(
    model: string,
    onProgress: (progress: OllamaPullProgress) => void,
  ): Promise<{ ok: boolean; message?: string }>;
  /**
   * Abandon the pull in flight.
   *
   * Separate from the pull because the UI needs it from a second click, and
   * because the partial download has to be released rather than left hanging.
   */
  cancelOllamaPull(): void;
  /** Remove an installed Ollama model. */
  ollamaDelete(model: string): Promise<{ ok: boolean; message?: string }>;
  /** The concrete model each mode currently resolves to, honouring `auto`. */
  resolveModels(): Promise<Record<Mode, string>>;
  /**
   * Modes whose pinned model is no longer in any provider's catalog.
   *
   * The send path still works, using the first available model, so this exists to
   * explain that rather than let a swap happen silently.
   */
  selectionNotices(): Promise<readonly MissingSelection[]>;

  /**
   * Compact a conversation on request. Older turns are marked superseded, not
   * deleted, so the transcript stays scrollable and the operation is reversible.
   */
  compactConversation(
    conversationId: string,
  ): Promise<{ removed: number; freedTokens: number }>;

  /**
   * File changes from the most recent run, or null when no run has happened.
   * Backs `/diff` with the same card the transcript shows.
   */
  latestRunChanges(conversationId: string): Promise<{
    runId: string;
    changes: readonly { toolName: string; display: unknown; text: string }[];
  } | null>;

  /** Runs that changed files in this conversation, newest first. */
  listCheckpoints(
    conversationId: string,
  ): Promise<readonly CheckpointRunInfo[]>;
  /**
   * Put a run's files back. The workspace comes from the conversation, so a
   * restore can only ever write into the project the run already touched.
   */
  restoreCheckpoint(input: {
    conversationId: string;
    runId: string;
    path?: string;
  }): Promise<readonly string[]>;
  /**
   * Set a mode's default model, and the provider that serves it.
   *
   * `providerId` is required rather than optional because a model id alone
   * cannot be routed: several vendors publish the same id.
   */
  setModelForMode(
    mode: Mode,
    model: string,
    providerId: string,
  ): Promise<Settings>;
  /**
   * Which configured provider serves a model id.
   *
   * For callers holding a bare id, such as `/model <id>`. Falls back to the
   * active provider so an unknown id still routes somewhere rather than
   * failing; the send path reports the real problem if it does not exist.
   */
  providerForModel(model: string): Promise<string>;

  // ---- conversations ---------------------------------------------------
  listConversations(options?: {
    mode?: Mode;
    search?: string;
  }): Promise<ConversationSummary[]>;
  createConversation(input: {
    mode: Mode;
    title?: string;
    workspace?: string | null;
  }): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  getMessages(
    conversationId: string,
    branchFrom?: string,
  ): Promise<StoredMessage[]>;
  renameConversation(id: string, title: string): Promise<void>;
  pinConversation(id: string, pinned: boolean): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  exportConversation(
    id: string,
    format: "md" | "json",
  ): Promise<ConversationExport>;

  // ---- turns -----------------------------------------------------------
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  /**
   * Re-run on the same transcript after a turn hit the output-token limit.
   *
   * Separate from `sendMessage` because it must not add a user turn: the
   * question was never asked and inventing one would put text in the user's
   * voice into their own transcript.
   */
  continueMessage(input: {
    readonly conversationId: string;
  }): Promise<{ readonly runId: string }>;
  /**
   * Answer a question that was already asked, on a provider the user picked.
   *
   * Separate from `sendMessage` for the same reason `continueMessage` is, and
   * it is the same reason twice here. The turn that triggered the provider
   * switch *was* persisted before the run, so accepting an offer and re-sending
   * the text appends the user's own message a second time -- the transcript
   * ends up holding the same question twice with one answer under it, and the
   * model reads the duplicate as emphasis at best.
   *
   * No fallbacks are attached: the user chose this provider, so if it also fails
   * the run ends and offers again rather than quietly going somewhere else.
   */
  retryOnProvider(input: {
    readonly conversationId: string;
    readonly model: string;
    readonly providerId: string;
  }): Promise<{ readonly runId: string }>;
  /** Stream of agent events. Ends when the run finishes or errors. */
  streamEvents(): AsyncIterable<AgentEvent>;
  cancelRun(runId: string): void;
  cancelAll(): void;

  // ---- approvals -------------------------------------------------------
  listPendingApprovals(): Promise<PendingApproval[]>;
  resolveApproval(callId: string, decision: ApprovalDecision): Promise<boolean>;

  // ---- tools & audit ---------------------------------------------------
  listTools(
    mode: Mode,
  ): Promise<{ name: string; description: string; categories: string[] }[]>;

  /**
   * Capabilities the user can switch on and off.
   *
   * A summary rather than the manifest, because the panel needs a row and not a
   * schema. `available` is separate from `enabled` on purpose and they are not
   * interchangeable: a capability can be available on this machine and switched
   * off by the user, or unavailable and enabled -- the latter is what an
   * extension needing a credential the user has not entered looks like, and
   * showing it as one or the other on its own would be a lie in both directions.
   */
  listExtensions(): Promise<ExtensionSummary[]>;
  /**
   * Switch one on or off. False when this build cannot run it at all.
   *
   * A `Promise` because it writes the decision. Reporting success before the
   * write lands would let a settings panel show the new state, then quietly lose
   * it on quit.
   */
  setExtensionEnabled(id: string, enabled: boolean): Promise<boolean>;
  readAudit(filter: {
    conversationId?: string;
    runId?: string;
    limit?: number;
  }): Promise<AuditRow[]>;

  // ---- workspace -------------------------------------------------------
  pickFolder(title?: string): Promise<string | null>;
  pickFiles(options?: {
    multiple?: boolean;
    directory?: boolean;
  }): Promise<Attachment[]>;
  attachFromClipboard(): Promise<Attachment[]>;
  revealPath(path: string): Promise<void>;
}

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Marker for hosts that can serve the API over a transport. */
export interface HostTransport {
  readonly name: "in-process" | "websocket" | "ipc";
  close(): Promise<void>;
}

export type { AgentEvent, AgentEventBus, ContentPart, Usage };
