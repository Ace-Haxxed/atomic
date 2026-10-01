/**
 * In-process host.
 *
 * Wires the pieces together: settings -> provider -> agent loop -> storage.
 * This is what the Tauri desktop app instantiates. Keeping it here (rather than
 * in the React app) is what makes a future `atomic serve` a transport change
 * instead of a rewrite.
 */

import { AgentLoop } from "../agent/loop.js";
import { freenessFor } from "../models/freeness.js";
import {
  FreePolicyError,
  checkModelPolicy,
  reviewTurnCost,
  type ObservedCost,
  type TurnCostReview,
} from "../models/free-policy.js";
import {
  ApprovalBroker,
  type ApprovalDecision,
  type PendingApproval,
} from "../agent/approval.js";
import { AgentEventBus, type AgentEvent } from "../agent/events.js";
import { buildSystemPrompt, deriveTitle } from "../agent/system-prompt.js";
import { AuditLog, type AuditRow } from "../audit/audit-log.js";
import { PermissionGate, type AllowList } from "../permissions/gate.js";
import { ZenProvider } from "../providers/zen/provider.js";
import {
  OllamaProvider,
  OLLAMA_PROVIDER_ID,
} from "../providers/ollama/provider.js";
import type { OllamaPullProgress } from "../providers/ollama/catalog.js";
import {
  configuredProviders,
  isKeylessProvider,
  mergeModels,
  missingSelections,
  type MissingSelection,
  type ProviderModels,
  type ProviderStatus,
} from "../models/catalog-service.js";
import {
  ProviderError,
  ProviderErrorKind,
  isAbort,
  toProviderError,
} from "../providers/errors.js";
import {
  PROVIDERS,
  providerById,
  type ProviderDefinition,
} from "../providers/registry.js";
import { ZEN_PROVIDER_ID } from "../providers/zen/catalog.js";
import { planCompaction } from "../agent/compaction.js";
import {
  ConversationRepository,
  RunRepository,
  TodoRepository,
  survivingMessages,
  toModelMessages,
  type Conversation,
  type ConversationSummary,
  type StoredMessage,
} from "../storage/repositories.js";
import {
  SettingsStore,
  type DeepPartial as SettingsPatch,
} from "../settings/store.js";
import {
  SettingsSchema,
  type Mode,
  type Settings,
} from "../settings/schema.js";
import {
  SecretKeys,
  secretSlotsFor,
  withProvider,
  type ApiKeySource,
  type SecretStore,
} from "../secrets/secret-store.js";
import { ToolRegistry, type Tool } from "../tools/registry.js";
import { createCodeTools } from "../tools/index.js";
import {
  ExtensionRegistry,
  type HostCapabilities,
  type ExtensionSummary,
} from "../extensions/registry.js";
import type { ExtensionManifest } from "../extensions/manifest.js";
import {
  contributeTools,
  type ImplementationResolver,
} from "../extensions/contributions.js";
import { builtinCapabilities, manifestForBuiltins } from "../extensions/builtin.js";
import type { ModelInfo, Provider } from "../models/provider.js";
import {
  isAutoModel,
  resolveModelForMode,
  AUTO_MODEL,
} from "../models/auto-model.js";
import { modelFor, modelProviderFor } from "../settings/schema.js";
import type { ContentPart, ModelMessage, Usage } from "../models/types.js";
import { EMPTY_USAGE, addUsage } from "../models/types.js";
import type { Database } from "../storage/database.js";
import type { AppDirs, HostEnvironment } from "../platform/dirs.js";
import type { PlatformInfo } from "../platform/platform.js";
import type { ShellProfile } from "../platform/shell.js";
import { buildExport } from "./export.js";
import type {
  Attachment,
  ConversationExport,
  HostApi,
  SendMessageInput,
  SendMessageResult,
  TestConnectionResult,
} from "./api.js";
import { basename } from "../platform/paths.js";
import {
  UNAVAILABLE_FILE_SYSTEM,
  UNAVAILABLE_PROCESS,
  type CheckpointPort,
  type FolderAccessPort,
  type FileSystemPort,
  type ProcessPort,
} from "./ports.js";

/** Host capabilities the core needs but does not implement. */
export interface HostServices {
  readonly platform: PlatformInfo;
  readonly shell: ShellProfile;
  readonly dirs: AppDirs;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly version: string;
  readonly hostName: string;
  /** Native folder picker. */
  pickFolder(title?: string): Promise<string | null>;
  pickFiles(options?: {
    multiple?: boolean;
    directory?: boolean;
  }): Promise<Attachment[]>;
  attachFromClipboard(): Promise<Attachment[]>;
  revealPath(path: string): Promise<void>;
  /** Read a project memory file from the workspace root, if present. */
  readProjectMemory(workspace: string): Promise<string | null>;
  /**
   * Filesystem access for the Code-mode tools.
   *
   * Optional because a host without Code support should still load and chat.
   * When absent, the tools report that file access is unavailable rather than
   * pretending to work -- see `UNAVAILABLE_FILE_SYSTEM`.
   */
  readonly fs?: FileSystemPort;
  /** Command execution for the Code-mode tools. Optional, same reasoning. */
  readonly process?: ProcessPort;
  /** Absent in a host with no Code support; the write tools then have no undo. */
  readonly checkpoints?: CheckpointPort;
  /**
   * Authorizing a folder the agent asked for.
   *
   * Absent when the user has switched agent-requested folders off, which is also
   * what keeps `add_folder` out of the model's tool list -- a capability the
   * user turned off should be invisible to the model rather than present and
   * always refused.
   */
  readonly folders?: FolderAccessPort;
  /** Model ids the user's own keys can reach, keyed by model id. */
  ownKeys?: Readonly<Record<string, string>>;
  /**
   * The host's HTTP transport.
   *
   * A browser `fetch` is subject to CORS, and model endpoints do not send
   * `Access-Control-Allow-Origin`, so a webview-hosted app has to route requests
   * through the host. Optional: omitted, providers fall back to the global
   * `fetch`, which is correct in tests and in a plain web host.
   */
  fetch?: typeof fetch;
}

/**
 * Which host service satisfies which declared requirement.
 *
 * Named in one place because a manifest's `requiresService` is a claim about the
 * app, and the app is the only thing that can answer it. A capability whose name
 * is missing here is reported unavailable rather than assumed present.
 */
const SERVICE_CAPABILITIES = {
  fs: "filesystem",
  process: "process",
  checkpoints: "checkpoints",
  folders: "folders",
  ownKeys: "ownKeys",
} as const;

export interface LocalHostOptions {
  readonly db: Database;
  readonly secrets: SecretStore;
  readonly settings: SettingsStore;
  readonly services: HostServices;
  readonly registry?: ToolRegistry;
  /**
   * Manifests to publish besides the built-ins.
   *
   * Taken rather than discovered from disk here, so the host has no opinion about
   * where extensions live and a test can hand it a manifest directly. Connections
   * and the settings panel are the callers that know.
   */
  readonly extensions?: readonly ExtensionManifest[];
  readonly audit?: AuditLog;
  readonly now?: () => number;
  readonly newId?: () => string;
}

/**
 * The two provider implementations the host can build.
 *
 * A union rather than a common base class: the shared surface is genuinely small
 * (`listModels`, `complete`, `stream`, `supportsModel`, `invalidateCatalog`) and
 * inventing an abstract class to hold five methods would add an indirection
 * without adding a guarantee.
 */
type ModelProvider = ZenProvider | OllamaProvider;

interface ActiveRun {
  readonly runId: string;
  readonly conversationId: string;
  readonly controller: AbortController;
}

export class LocalHost implements HostApi {
  #db: Database;
  #secrets: SecretStore;
  #settings: SettingsStore;
  #services: HostServices;
  #registry: ToolRegistry;
  /**
   * Capabilities, as described things.
   *
   * Built-ins are published here before they are registered, so what the user can
   * switch off, what the settings panel lists and what the prompt offers all come
   * from one description. A second list, written by hand and kept in step by
   * memory, is a list that drifts.
   */
  #extensions: ExtensionRegistry;
  /** Tool names this host contributed, so a rebuild can take them back out. */
  #contributed: Set<string> = new Set();
  /**
   * Manifests whose tools have nothing behind them.
   *
   * Held rather than reported once at startup, because "this build cannot run
   * that" is a fact about the manifest and not about this moment. Kept so a host
   * that gains an implementation later can say so instead of leaving the user
   * with a capability the app appears to have and does not.
   */
  #unimplemented: Map<string, string[]> = new Map();
  /** Where an implementation for a declared tool name comes from, if there is one. */
  #implementations: ImplementationResolver = () => undefined;
  /** Manifests handed in before there was anything to attach them to. */
  #pendingManifests: ExtensionManifest[] = [];
  #audit: AuditLog;
  #conversations: ConversationRepository;
  #runs: RunRepository;
  #events: AgentEventBus;
  #approval: ApprovalBroker;
  #active = new Map<string, ActiveRun>();
  /** In-flight Ollama pull, so a second one cannot interleave with the first. */
  #pullAbort: AbortController | undefined;
  #now: () => number;
  #newId: () => string;

  constructor(options: LocalHostOptions) {
    this.#db = options.db;
    this.#secrets = options.secrets;
    this.#settings = options.settings;
    this.#services = options.services;
    this.#registry = options.registry ?? new ToolRegistry();
    this.#extensions = new ExtensionRegistry({
      platform: options.services.platform,
      // A service is present or absent, not configured: `requiresService` asks
      // whether this build can do the thing at all. A host that supplied the port
      // and then failed to reach the network can be found by the call failing,
      // which produces a truthful message; pretending otherwise here would make a
      // broken extension report itself as working.
      services: Object.keys(SERVICE_CAPABILITIES).filter(
        (name) => this.#services[name as keyof typeof SERVICE_CAPABILITIES] !== undefined,
      ),
      hasCredentialStore: true,
    });
    this.#audit = options.audit ?? new AuditLog(options.db);
    this.#conversations = new ConversationRepository(options.db);
    this.#runs = new RunRepository(options.db);
    this.#events = new AgentEventBus();
    this.#approval = new ApprovalBroker();
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? defaultId;
    this.#pendingManifests = [...(options.extensions ?? [])];

    /*
     * Listen first, then apply what the user has already decided.
     *
     * The order is the whole thing. Applying the stored switches before
     * subscribing means the registry changes and nothing rebuilds the tool list,
     * so the tools a user switched off stay registered -- reachable by the model,
     * absent from the settings panel that says they are off. Each of those two
     * facts alone would look right in a test of one of them.
     */
    this.#extensions.subscribe(() => this.#syncExtensionTools());
    this.#registerCodeTools();

    for (const id of this.#settings.get().disabledExtensions) {
      this.#extensions.setEnabled(id, false);
    }
  }

  /**
   * Add the Code-mode tools, if this host can do the work.
   *
   * Registration is skipped rather than stubbed when a port is missing, so a
   * host without a filesystem gets a model that is honestly told it cannot read
   * files, instead of one handed tools that fail at call time.
   *
   * The folder tool is registered whenever the host *can* authorize folders and
   * left out otherwise, rather than registered always and gated per call. A model
   * whose tool list names a capability that always refuses will keep calling it;
   * one that never heard of it moves on. The setting that decides whether a
   * request needs a prompt is read per call instead, by the gate, so flipping it
   * takes effect without re-registering anything.
   */
  #registerCodeTools(): void {
    const fs = this.#services.fs;
    const process = this.#services.process;
    if (!fs || !process) return;
    if (this.#registry.names("code").length > 0) return;

    const todos = new TodoRepository(this.#db);
    const folders = this.#services.folders;
    const tools = createCodeTools({
      fs,
      process,
      todos: {
        read: (conversationId) => todos.list(conversationId),
        write: (conversationId, items) => todos.replace(conversationId, items),
      },
      checkpoint: this.#services.checkpoints
        ? {
            checkpoints: this.#services.checkpoints,
            settings: () => this.#settings.get(),
          }
        : undefined,
      ...(folders ? { folders } : {}),
    });

    /*
     * Through the extension registry, like everything else that can contribute a
     * tool.
     *
     * The obvious version of this -- register the built-ins directly and treat
     * extensions as a second path -- is what this call exists to avoid. It would
     * give extensions their own enable/disable story, their own settings UI and
     * eventually their own permission handling, and each of those would be a
     * place where an assumption holds for built-ins and not for the rest. The
     * implementation resolver hands back the very tool objects just built, so the
     * manifest describes them without a second copy and the registry hands them
     * back unchanged.
     */
    this.#registerExtensions(tools);
  }

  /**
   * Publish a manifest, and register whatever it can actually run.
   *
   * Called for the built-ins here and, once connections exist, for every MCP
   * server the user has configured. Both go through one path on purpose: a
   * capability the user can switch off should be switchable because it is an
   * extension, not because someone remembered to add it to the extension list.
   */
  #registerExtensions(builtinTools: readonly Tool[] = []): void {
    const byName = new Map(builtinTools.map((tool) => [tool.name, tool]));
    this.#implementations = (name: string) => {
      const tool = byName.get(name);
      return tool
        ? { execute: tool.execute, ...(tool.parse ? { parse: tool.parse } : {}) }
        : undefined;
    };

    for (const manifest of this.#pendingManifests) {
      this.#extensions.discover({ label: "configured", manifest });
    }
    this.#pendingManifests = [];

    for (const capability of builtinCapabilities(builtinTools)) {
      this.#extensions.discover({
        label: "builtin",
        manifest: manifestForBuiltins(capability),
      });
    }
    this.#syncExtensionTools();
  }

  /**
   * Bring the tool registry in line with the extensions that are on.
   *
   * Re-run after every change, because enabling an extension has to add its tools
   * and disabling one has to remove them: a tool left registered after its
   * extension is off is a capability the user turned off that the model can still
   * reach.
   */
  #syncExtensionTools(): void {
    for (const name of this.#contributed) this.#registry.unregister(name);
    this.#contributed.clear();
    this.#unimplemented.clear();

    // Availability, not activation: a capability that is switched off still has
    // tools this build cannot run, and the settings panel has to be able to say
    // so before the user switches it on. An extension this machine cannot run at
    // all is excluded -- "missing tools" beside "wrong platform" is noise.
    for (const record of this.#extensions.all()) {
      if (record.unavailable) continue;
      const missing = contributeTools(record.manifest, this.#implementations).unimplemented;
      if (missing.length > 0) this.#unimplemented.set(record.manifest.id, [...missing]);
    }

    for (const record of this.#extensions.active()) {
      // No stand-in when a tool is missing. A registered tool that returns nothing
      // is a model reporting having done something it did not.
      const result = contributeTools(record.manifest, this.#implementations);
      // Existing registrations are left alone rather than replaced. Two
      // extensions can declare the same name, and the registry already refuses to
      // hold both; overwriting here would make which one won depend on which
      // manifest was discovered last instead of on the report the registry makes.
      const fresh = result.tools.filter((tool) => !this.#registry.has(tool.name));
      if (fresh.length > 0) this.#registry.registerAll(fresh);
      for (const tool of result.tools) this.#contributed.add(tool.name);
    }
  }

  /** Runs that changed files this conversation, newest first, for the undo UI. */
  /**
   * Compact a conversation on request.
   *
   * Non-destructive: the folded turns are marked superseded, so the model stops
   * sending them while the user can still scroll back through them. Nothing is
   * deleted, which means a compaction the user did not want is one flag away
   * from being ignored -- and it does not silently rewrite what the transcript
   * shows.
   */
  async compactConversation(
    conversationId: string,
  ): Promise<{ removed: number; freedTokens: number }> {
    const conversation = await this.#conversations.get(conversationId);
    if (!conversation) throw new Error("That conversation no longer exists.");
    const settings = this.#settings.get();
    const provider = await this.#provider(settings.providerId);
    if (!provider) throw new Error("Add a provider API key before compacting.");

    const history = await this.#conversations.messages(conversationId);
    // One filtered list feeds both the model messages and the boundary, so an
    // index into one is an index into the other by construction.
    const surviving = survivingMessages(history);
    const modelMessages = toModelMessages(surviving);
    const model = modelFor(settings, conversation.mode);
    const plan = planCompaction(modelMessages, {
      contextWindow: await this.#contextWindow(model),
      keepRecent: 4,
      // Ask for compaction regardless of size: the user asked for it, and a
      // threshold that says "not needed" would make the command feel broken.
      triggerRatio: 0,
    });
    if (!plan.needsCompaction) {
      return { removed: 0, freedTokens: 0 };
    }

    const older = modelMessages.slice(0, plan.keepFrom);
    const transcript = older
      .map((message) => {
        const text = message.content
          .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
          .join("");
        return `${message.role}: ${text}`;
      })
      .join("\n\n");

    const response = await provider.complete(
      {
        providerId: settings.providerId,
        model,
        system:
          "Summarise the conversation so far. Keep decisions, file paths, identifiers, errors, and anything the assistant must remember to continue. Be terse and factual. Output plain text.",
        messages: [
          { role: "user", content: [{ type: "text", text: transcript }] },
        ],
        maxOutputTokens: 2048,
      },
      {},
    );
    const summary = response.message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();

    // The boundary is a seq, not an index into the filtered list, so the turns
    // that stay verbatim are exactly the ones counted in the plan.
    const keepFromSeq = compactionBoundary(surviving, plan.keepFrom);
    await this.#conversations.addMessage({
      id: this.#newId(),
      conversationId,
      role: "user",
      content: [
        {
          type: "text",
          text: `Earlier in this conversation (compacted summary):\n${summary}`,
        },
      ],
    });
    const removed = await this.#conversations.supersedeBefore(
      conversationId,
      keepFromSeq,
    );
    return { removed, freedTokens: plan.totalTokens - plan.threshold };
  }

  /**
   * The context window to plan compaction against.
   *
   * The override wins because a user who has measured their own limit knows
   * more than a catalog does. Otherwise the live catalog is consulted, and a
   * conservative default is used when the catalog is unavailable -- planning
   * against a window that is too large is what causes a provider to reject the
   * request outright, which is a far worse failure than compacting early.
   */
  async #contextWindow(model: string): Promise<number> {
    const override = this.#settings.get().generation.contextWindowOverride;
    if (override > 0) return override;
    const settings = this.#settings.get();
    const provider = await this.#provider(settings.providerId);
    if (provider) {
      try {
        const catalog = await provider.listModels();
        const entry = catalog.models.find(
          (candidate) => candidate.id === model,
        );
        const window = entry?.capabilities.contextWindow;
        if (window && window > 0) return window;
      } catch {
        // Fall through to the default rather than failing a send.
      }
    }
    return 32_000;
  }

  /**
   * File changes from the most recent run, for `/diff`.
   *
   * `null` when there is no run yet, which the UI turns into an explanation
   * rather than an empty diff box that looks like a broken feature.
   */
  async latestRunChanges(conversationId: string): Promise<{
    runId: string;
    changes: readonly { toolName: string; display: unknown; text: string }[];
  } | null> {
    const runs = await this.#runs.list(conversationId, 1);
    const run = runs[0];
    if (!run) return null;
    return {
      runId: run.id,
      changes: await this.#conversations.changesInRun(conversationId, run.id),
    };
  }

  async listCheckpoints(conversationId: string) {
    return (await this.#services.checkpoints?.list(conversationId)) ?? [];
  }

  /** Put a run's files back. `path` limits it to one file. */
  async restoreCheckpoint(input: {
    conversationId: string;
    runId: string;
    path?: string;
  }): Promise<readonly string[]> {
    const checkpoints = this.#services.checkpoints;
    if (!checkpoints)
      throw new Error("Checkpoints are not available in this host.");
    // The workspace is resolved from the conversation, never from the caller:
    // the restore writes into the user's project, and the conversation is the
    // only thing that knows which project that is.
    const conversation = await this.#conversations.get(input.conversationId);
    const workspace = conversation?.workspace;
    if (!workspace)
      throw new Error(
        "This conversation has no folder open, so there is nothing to restore into.",
      );
    const restored = await checkpoints.restore({
      workspaceRoot: workspace,
      conversationId: input.conversationId,
      runId: input.runId,
      ...(input.path === undefined ? {} : { path: input.path }),
    });
    return restored;
  }

  get events(): AgentEventBus {
    return this.#events;
  }

  get approval(): ApprovalBroker {
    return this.#approval;
  }

  get tools(): ToolRegistry {
    return this.#registry;
  }

  // ---- lifecycle -------------------------------------------------------

  async getEnvironment() {
    return {
      platform: this.#services.platform,
      shell: this.#services.shell,
      dirs: this.#services.dirs,
      version: this.#services.version,
      host: this.#services.hostName,
    };
  }

  // ---- settings --------------------------------------------------------

  getSettings(): Promise<Readonly<Settings>> {
    return Promise.resolve(this.#settings.get());
  }

  updateSettings(patch: SettingsPatch<Settings>): Promise<Settings> {
    return this.#settings.patch(patch as never);
  }

  setPermission(
    mode: Mode,
    patch: SettingsPatch<Settings["permissions"][Mode]>,
  ): Promise<Settings> {
    return this.#settings.setPermission(mode, patch as never);
  }

  /** Writes to the OS keychain. Never touches SQLite, never logged. */
  /**
   * Read a provider's key, adopting a legacy slot if that is where it is.
   *
   * Adoption is one-way and happens once: the value is written to the canonical
   * slot and the old one is deleted, so the key is never left in two places and a
   * second read does not depend on the migration having run.
   */
  async #readKey(providerId: string): Promise<string | null> {
    const slots = secretSlotsFor(providerId);
    const [canonical, ...legacy] = slots;
    const current = await this.#secrets.get(canonical);
    if (current) return current;
    for (const slot of legacy) {
      const stranded = await this.#secrets.get(slot);
      if (!stranded) continue;
      await this.#secrets.set(canonical, stranded);
      await this.#secrets.delete(slot);
      return stranded;
    }
    return null;
  }

  /**
   * Whether an environment variable holds a credential.
   *
   * The host's own `env` is consulted only when the store cannot answer, which
   * is the shape of every test and of the node/web hosts.
   */
  async #envPresent(name: string): Promise<boolean> {
    if (this.#secrets.hasEnv) return this.#secrets.hasEnv(name);
    return Boolean(this.#services.env[name]);
  }

  /** One environment variable's value, fetched at the moment it is needed. */
  async #envRead(name: string): Promise<string | null> {
    if (this.#secrets.readEnv) return this.#secrets.readEnv(name);
    return this.#services.env[name] ?? null;
  }

  /**
   * Save an API key for one provider.
   *
   * Scoped to `providerId` on purpose. This used to be reachable from a form
   * bound to the app's *current* provider, so storing a second key meant
   * re-pointing the whole app at that provider first -- which is why the app
   * looked like it could only ever hold one or two keys. Nothing here reads or
   * writes `settings.providerId`; a key is a property of a provider, not of the
   * currently selected one.
   *
   * The value is normalised before it is stored, not when it is read, so a key
   * that is wrong here is wrong in the keychain rather than only on one request
   * path. A key copied out of a terminal or a browser arrives with a trailing
   * newline; one pasted with a soft wrap arrives with a newline in the middle.
   * Both are invisible on screen, both produce an opaque 401, and neither is
   * something the user can see to fix -- so they are rejected here, where the
   * message can say what actually happened.
   *
   * The write is then read back, presence only. A credential store that accepts
   * a write and cannot return it is a real state on Linux without a Secret
   * Service, and reporting "saved" there is worse than reporting the failure.
   */
  async setApiKey(
    providerId: string,
    apiKey: string | null,
  ): Promise<Settings> {
    // A key written for a provider this build does not have is a credential
    // parked in a slot nothing will ever read, and the field that could have
    // written it is gone by the time anyone notices. Refuse it here.
    if (providerById(providerId) === null) {
      throw new ProviderError(
        ProviderErrorKind.config,
        "unknown_provider",
        `Atomic has no provider called "${providerId}", so the key was not saved.`,
      );
    }
    const key = secretKeyFor(providerId);
    const normalized = normalizeApiKey(apiKey);
    if (normalized === null) {
      await this.#secrets.delete(key);
      if (await this.#secrets.get(key)) {
        throw new ProviderError(
          ProviderErrorKind.config,
          "api_key_delete_failed",
          `The saved ${providerLabel(providerId)} key did not clear. Remove it from your OS credential store and try again.`,
        );
      }
    } else {
      if (!(await this.#secrets.isAvailable())) {
        throw new ProviderError(
          ProviderErrorKind.config,
          "secret_store_unavailable",
          `Your system credential store is not available, so the ${providerLabel(providerId)} key was not saved. Check that your keychain or credential manager is unlocked, then try again.`,
        );
      }
      await this.#secrets.set(key, normalized);
      if (!(await this.#secrets.get(key))) {
        throw new ProviderError(
          ProviderErrorKind.config,
          "api_key_write_unverified",
          `The ${providerLabel(providerId)} key was not saved. Your system credential store accepted the write but did not return it, so Atomic cannot confirm it is usable. Nothing was changed.`,
        );
      }
    }

    const settings = this.#settings.get();
    const current = settings.providers[providerId];
    return this.#settings.setProvider(providerId, {
      apiKeySource: normalized ? "keychain" : "unset",
      ...(current ? {} : { baseUrl: "", apiKeyEnvVar: "" }),
    });
  }

  async hasApiKey(providerId: string): Promise<boolean> {
    return Boolean(await this.#readKey(providerId));
  }

  /**
   * Where each provider's credential comes from, for the keys list.
   *
   * Presence only. The UI needs "saved in your keychain" versus "reached by
   * GEMINI_API_KEY" versus "no key", and none of those distinctions require a
   * value to cross into the webview.
   */
  async apiKeySources(): Promise<Readonly<Record<string, ApiKeySource>>> {
    const out: Record<string, ApiKeySource> = {};
    for (const definition of PROVIDERS) {
      if (isKeylessProvider(definition.id)) {
        out[definition.id] = "none";
        continue;
      }
      if (await this.#readKey(definition.id)) {
        out[definition.id] = "keychain";
        continue;
      }
      const envVar = this.#envVarFor(definition.id);
      out[definition.id] = (envVar && (await this.#envPresent(envVar))) ? "env" : "none";
    }
    return out;
  }

  /**
   * Check a provider's key by using it.
   *
   * Deliberately *not* a catalog fetch. Zen's `/models` is public and returns
   * 200 to an anonymous caller, so the old version of this reported "Connected"
   * for a key the API rejects -- which is exactly how a dead key looked healthy
   * until the user pressed Send. This sends one minimal authenticated request
   * and reports why it failed, because the causes need different actions.
   */
  async testConnection(providerId: string): Promise<TestConnectionResult> {
    const started = this.#now();
    const provider = await this.#provider(providerId);
    if (!provider) {
      return {
        ok: false,
        outcome: "not-verifiable",
        message: `Unknown provider "${providerId}".`,
        latencyMs: 0,
      };
    }

    // `verifyCredentials` is optional on the `Provider` port, and this host works
    // with a union of the concrete providers, so it has to be narrowed first.
    if (!hasCredentialCheck(provider)) {
      // A provider with no credential to prove (a local Ollama) is reachable or
      // it is not, and the catalog is the honest check for that.
      const catalog = await provider.listModels();
      const reachable = catalog.source !== "fallback";
      return {
        ok: reachable,
        outcome: reachable ? "valid" : "network",
        message: reachable
          ? `Reachable. ${catalog.models.length} models available.`
          : "Reached the server but could not read its model list. Is it running?",
        modelsFound: catalog.models.length,
        latencyMs: this.#now() - started,
      };
    }

    try {
      const check = await provider.verifyCredentials();
      const latencyMs = this.#now() - started;
      const ok = check.status === "valid";
      const detail = check.detail;
      switch (check.status) {
        case "valid":
          return {
            ok: true,
            outcome: "valid",
            message: detail,
            modelsFound: 1,
            latencyMs,
            detail,
          };
        case "rejected":
          return {
            ok: false,
            outcome: "rejected",
            message:
              "Your API key was rejected. Re-paste it in Settings → Models, copying it as a single line.",
            latencyMs,
            detail,
          };
        case "model-unavailable":
          return {
            ok: false,
            outcome: "model-unavailable",
            message: `The key was accepted, but no model on ${provider.name} is available to it.`,
            latencyMs,
            detail,
          };
        case "rate-limited":
          return {
            ok: false,
            outcome: "rate-limited",
            message:
              "The key is being rate limited. Wait a moment, then test again.",
            latencyMs,
            detail,
          };
        case "no-key":
          return {
            ok: false,
            outcome: "no-key",
            message: "No API key saved for this provider yet.",
            latencyMs,
            detail,
          };
        default:
          return {
            ok: false,
            outcome: "network",
            message:
              "Could not reach the provider. Check your connection or proxy settings.",
            latencyMs,
            detail,
          };
      }
    } catch (error) {
      const providerError = toProviderError(error);
      return {
        ok: false,
        outcome: providerError.kind === "auth" ? "rejected" : "network",
        message: providerError.userMessage,
        latencyMs: this.#now() - started,
        detail: providerError.message,
      };
    }
  }

  // ---- models ----------------------------------------------------------

  async listModels(forceRefresh = false): Promise<readonly ModelInfo[]> {
    const settings = this.#settings.get();
    const provider = await this.#provider(settings.providerId);
    if (!provider) {
      throw new Error(`Unknown provider "${settings.providerId}".`);
    }
    if (forceRefresh) provider.invalidateCatalog();
    const catalog = await provider.listModels();
    // A "fallback" catalog means the fetch failed. Returning it silently left the
    // picker showing two guessed models with no way to tell they were guesses, and
    // the dropdown simply looked broken — so the reason is surfaced instead.
    if (catalog.source === "fallback") {
      throw new Error(
        catalog.error ??
          "Could not reach the provider to list models. Check your connection and API key, then retry.",
      );
    }
    return catalog.models;
  }

  setModelForMode(
    mode: Mode,
    model: string,
    providerId: string,
  ): Promise<Settings> {
    return this.#settings.setModelForMode(mode, model, providerId);
  }

  /**
   * The provider objects behind every currently configured provider.
   *
   * Best effort by design. A provider that cannot be constructed -- no key, or a
   * key that fails to read -- is left out, and a fallback that names it is
   * skipped at the point of use. Failing the whole run instead would make one
   * unreadable provider take out Auto's ability to fall back at all.
   */
  async #configuredProviderObjects(): Promise<readonly Provider[]> {
    const out: Provider[] = [];
    const settings = this.#settings.get();
    const keys = await this.providerKeyStatus();
    for (const definition of configuredProviders(settings, keys)) {
      const provider = await this.#provider(definition.id).catch(() => undefined);
      if (provider) out.push(provider);
    }
    return out;
  }

  async providerForModel(model: string): Promise<string> {
    const settings = this.#settings.get();
    if (isAutoModel(model) || !model) return settings.providerId;
    const sections = await this.listProviderModels();
    const match = mergeModels(sections).find((entry) => entry.id === model);
    return match?.providerId ?? settings.providerId;
  }

  // ---- conversations ---------------------------------------------------

  listConversations(
    options: { mode?: Mode; search?: string } = {},
  ): Promise<ConversationSummary[]> {
    return this.#conversations.list(options);
  }

  createConversation(input: {
    mode: Mode;
    title?: string;
    workspace?: string | null;
  }): Promise<Conversation> {
    const settings = this.#settings.get();
    return this.#conversations.create({
      id: this.#newId(),
      mode: input.mode,
      title: input.title ?? null,
      model: settings.models[input.mode] || null,
      // The mode can be pinned to a model from a provider other than the global
      // one. Recording `settings.providerId` here would pin the conversation to
      // the wrong provider for its whole life, because sends prefer the
      // conversation's provider over the mode default.
      providerId: modelProviderFor(settings, input.mode),
      workspace: input.workspace ?? settings.lastWorkspace ?? null,
    });
  }

  getConversation(id: string): Promise<Conversation | null> {
    return this.#conversations.get(id);
  }

  getMessages(
    conversationId: string,
    branchFrom?: string,
  ): Promise<StoredMessage[]> {
    return this.#conversations.messages(conversationId, branchFrom);
  }

  async renameConversation(id: string, title: string): Promise<void> {
    await this.#conversations.update(id, { title });
  }

  async pinConversation(id: string, pinned: boolean): Promise<void> {
    await this.#conversations.update(id, { pinned });
  }

  async deleteConversation(id: string): Promise<void> {
    await this.#conversations.remove(id);
  }

  async exportConversation(
    id: string,
    format: "md" | "json",
  ): Promise<ConversationExport> {
    const conversation = await this.#conversations.get(id);
    if (!conversation) throw new Error(`Conversation ${id} not found`);
    const messages = await this.#conversations.messages(id);
    return buildExport(conversation, messages, format, this.#services.platform);
  }

  /**
   * Work out which model a mode should use.
   *
   * A pinned model is returned untouched. The `auto` sentinel is resolved
   * against the provider's catalog, and when the free-only policy leaves nothing
   * eligible this throws rather than quietly reaching for a paid one: spending
   * the user's money is a decision, not a default.
   */
  async #resolveModel(
    mode: Mode,
    settings: Settings,
  ): Promise<{
    model: string;
    providerId: string;
    pinned: boolean;
    /**
     * Alternatives to try, each with the provider that serves it.
     *
     * Provider-qualified because the point of a fallback after a 429 is usually
     * to change provider; a bare id cannot be routed.
     */
    fallbacks: readonly { readonly model: string; readonly providerId: string }[];
    /** Set when a pinned model is gone and something else is being used. */
    notice: string | null;
  }> {
    const configured = modelFor(settings, mode);
    const modeProvider = modelProviderFor(settings, mode);
    if (!isAutoModel(configured)) {
      return {
        model: configured,
        providerId: modeProvider,
        pinned: true,
        fallbacks: [],
        // A pinned model is returned as configured without consulting the
        // catalog, on purpose: the alternative is silently sending something
        // other than what was chosen, and a user who pinned a model means it.
        // Whether it still exists is `selectionNotices`' job, which is the one
        // place that has already fetched every provider's catalog anyway.
        notice: null,
      };
    }

    const provider = await this.#provider(modeProvider);
    if (!provider) throw new Error(`Unknown provider "${modeProvider}".`);

    // Every configured provider, not just this mode's. Auto is meant to pick the
    // best model the user actually has access to, and the free model is often on
    // a different provider than the one they left active -- a local Ollama model
    // while Zen is the active provider, say.
    //
    // A provider that fails here is skipped rather than fatal: one unreachable
    // endpoint must not stop Auto choosing from the rest, and the same failure
    // is already reported in that provider's own section of the Models tab.
    const sections = await this.listProviderModels();
    const candidates = sections
      .filter((section) => section.status === "connected" && section.models.length > 0)
      .flatMap((section) =>
        section.models.map((model) => ({ provider: section.provider, model })),
      );
    if (candidates.length === 0) {
      // Nothing to rank. An unreachable catalog leaves the picker empty; say so
      // instead of guessing a model id that may not exist.
      throw new Error(
        "Could not load any provider's model list, so there is nothing to pick automatically. Try Refresh, or choose a model yourself.",
      );
    }

    const resolved = resolveModelForMode({
      configured,
      mode,
      provider: providerById(modeProvider) ?? providerById(ZEN_PROVIDER_ID)!,
      candidates,
      onlyFree: settings.autoSelectFreeModelsOnly,
      now: this.#now(),
      // The mode's provider is the one Auto starts from, so its alternatives are
      // ordered to move away from it first. Without this the fallback list leads
      // with another model on the provider that is currently refusing.
      avoidProviderId: modeProvider,
    });

    if (!resolved.model) {
      const cheapest = resolved.selection?.cheapestPaid;
      throw new Error(
        cheapest
          ? `No free model is available from any configured provider. The cheapest capable option is ${cheapest.candidate.model.name} on ${cheapest.candidate.provider.label}. Turn off "Only auto-select free models" in Settings → API & Models to allow it.`
          : (resolved.selection?.emptyReason ??
            "No usable model was found. Refresh the model list, or choose a model yourself."),
      );
    }

    return {
      model: resolved.model,
      // From the resolution, not from the mode: Auto may have chosen a model on
      // another provider, and a mode switched from a pinned cross-provider model
      // has to route correctly once it goes Auto.
      providerId: resolved.providerId,
      pinned: false,
      // Provider-qualified, because a fallback is very often served by a
      // different provider than the model that just failed.
      fallbacks: (resolved.selection?.fallbacks ?? []).map((entry) => ({
        model: entry.candidate.model.id,
        providerId: entry.candidate.provider.id,
      })),
      notice: null,
    };
  }

  /**
   * Every configured provider's models, for the Settings → Models tab.
   *
   * One slow or hanging endpoint must not hold the whole page: the user would
   * watch a single spinner while three sections that already have data stay
   * hidden. Each provider therefore reports itself through `onSection` as soon
   * as it settles, and the returned promise is only for callers that genuinely
   * need every provider before they can do anything.
   *
   * Keys are read here, from the keychain, and handed straight to the provider
   * object. They are never returned, never included in a section, and never
   * logged -- the section carries models and a reason, nothing else.
   */
  async listProviderModels(
    forceRefresh = false,
    onSection?: (section: ProviderModels) => void,
  ): Promise<readonly ProviderModels[]> {
    const settings = this.#settings.get();
    const keys = await this.providerKeyStatus();
    const providers = configuredProviders(settings, keys);

    // Still `Promise.all`, because the returned array has to be complete for
    // callers that only want the whole thing. `onSection` is what makes the
    // listing feel independent: each section is handed over the moment it
    // settles, so a provider that takes 30s cannot hold back the three that
    // already answered.
    const sections = await Promise.all(
      providers.map(async (definition): Promise<ProviderModels> => {
        const section = await this.#providerSection(
          definition,
          keys,
          forceRefresh,
        );
        onSection?.(section);
        return section;
      }),
    );

    return sections;
  }

  /** One provider's section, settled independently of the others. */
  async #providerSection(
    definition: ProviderDefinition,
    keys: Readonly<Record<string, boolean>>,
    forceRefresh: boolean,
  ): Promise<ProviderModels> {
    const hasKey =
      keys[definition.id] === true || isKeylessProvider(definition.id);

    // No credential: say so, and do not spend a request proving it.
    if (!hasKey) {
      return {
        provider: definition,
        models: [],
        source: "fallback",
        status: "unconfigured",
        error: null,
        fetchedAt: null,
        stale: false,
      };
    }

    try {
      const provider = await this.#provider(definition.id);
      if (!provider) throw new Error(`Unknown provider "${definition.id}".`);
      if (forceRefresh) provider.invalidateCatalog();

      // Ollama is the one provider whose listing is not an OpenAI /models
      // response, and whose management calls have no Zen equivalent.
      if (definition.id === OLLAMA_PROVIDER_ID) {
        return await this.#ollamaSection(definition, forceRefresh);
      }

      const catalog = await provider.listModels();
      // `listModels` reports failure in the catalog rather than by throwing,
      // so the kind is read off the catalog. A rejected key is `error`
      // (paste a different one) and everything else is `unreachable` (retry).
      return {
        provider: definition,
        models: catalog.models,
        source: catalog.source,
        status:
          catalog.source === "fallback"
            ? catalog.errorKind === "auth" || catalog.errorKind === "rate-limit"
              ? "error"
              : "unreachable"
            : "connected",
        // Carried even for a cached catalog: the models on screen may be out
        // of date, and the user is told why rather than left guessing.
        error: catalog.error ?? null,
        fetchedAt: catalog.fetchedAt,
        stale: catalog.stale === true,
      };
    } catch (error) {
      return {
        provider: definition,
        models: [],
        source: "fallback",
        // A rejected key and a dead network are different problems and get
        // different words: one needs a new key, the other needs a retry.
        status:
          toProviderError(error).kind === "auth" ? "error" : "unreachable",
        error: toProviderError(error).userMessage,
        fetchedAt: null,
        stale: false,
      };
    }
  }

  async #ollamaSection(
    definition: ProviderDefinition,
    forceRefresh: boolean,
  ): Promise<ProviderModels> {
    const ollama = this.#ollamaProvider();
    // Invalidate the in-memory copy and ignore the tags TTL once, so Refresh
    // really re-requests. The SQLite row is deliberately kept: it is what the
    // section falls back to if this refresh fails, and deleting it here would
    // throw away the list the user is currently looking at.
    if (forceRefresh) ollama.invalidateCatalog();

    // Probed, not short-circuited on. A stopped server is the case where the
    // cached list matters most, so the listing is attempted anyway and allowed
    // to resolve to the cache; the probe only sharpens the message.
    const probe = await ollama.probe();
    const catalog = await ollama.listModels();

    // Reachable and reporting nothing is a real, common state -- a fresh Ollama
    // install -- and it is exactly what the pull prompt exists for.
    const status: ProviderStatus = probe.reachable
      ? "connected"
      : "unreachable";
    return {
      provider: definition,
      models: catalog.models,
      source: catalog.source,
      status,
      // Prefer the listing's own reason; fall back to the probe's, which knows
      // how to say "Ollama isn't running" instead of "connection refused".
      error: catalog.error ?? probe.message ?? null,
      fetchedAt: catalog.fetchedAt,
      stale: catalog.stale === true || !probe.reachable,
    };
  }

  async providerKeyStatus(): Promise<Readonly<Record<string, boolean>>> {
    const sources = await this.apiKeySources();
    const out: Record<string, boolean> = {};
    for (const [providerId, source] of Object.entries(sources)) {
      // Keyless providers count as reachable with nothing saved, which is what
      // the "Add key" prompts and the provider sections are asking.
      out[providerId] =
        source === "keychain" || source === "env" || isKeylessProvider(providerId);
    }
    return out;
  }

  /**
   * The Ollama provider, built the same way the request path builds it: the URL
   * comes from settings, so editing it in Settings changes the Models tab and the
   * completions together.
   */
  #ollamaProvider(
    onPullProgress?: (progress: OllamaPullProgress) => void,
  ): OllamaProvider {
    const settings = this.#settings.get();
    const definition = providerById(OLLAMA_PROVIDER_ID);
    return new OllamaProvider(
      {
        apiKey: null,
        baseUrl:
          settings.providers[OLLAMA_PROVIDER_ID]?.baseUrl ||
          definition?.baseUrl ||
          null,
      },
      {
        db: this.#db,
        now: this.#now,
        ...(this.#services.fetch ? { fetch: this.#services.fetch } : {}),
        ...(onPullProgress ? { onPullProgress } : {}),
      },
    );
  }

  /**
   * Download an Ollama model.
   *
   * The progress callback is the host's own function, so the caller sees lines as
   * they arrive rather than polling. The controller is kept so a second pull
   * cannot interleave with the first and leave the two progress bars fighting
   * over one number.
   */
  async ollamaPull(
    model: string,
    onProgress: (progress: OllamaPullProgress) => void,
  ): Promise<{ ok: boolean; message?: string }> {
    this.#pullAbort?.abort();
    const controller = new AbortController();
    this.#pullAbort = controller;
    const result = await this.#ollamaProvider(onProgress).pull(model, {
      signal: controller.signal,
    });
    if (this.#pullAbort === controller) this.#pullAbort = undefined;
    return result;
  }

  /** Cancel an in-flight pull. Safe to call when nothing is running. */
  cancelOllamaPull(): void {
    this.#pullAbort?.abort();
    this.#pullAbort = undefined;
  }

  async ollamaDelete(
    model: string,
  ): Promise<{ ok: boolean; message?: string }> {
    return this.#ollamaProvider().delete(model);
  }

  /** The model each mode currently resolves to, for the header and settings. */
  async resolveModels(): Promise<Record<Mode, string>> {
    const settings = this.#settings.get();
    const modes: readonly Mode[] = ["chat", "cowork", "code"];
    const out = {} as Record<Mode, string>;
    for (const mode of modes) {
      try {
        out[mode] = (await this.#resolveModel(mode, settings)).model;
      } catch {
        // Report what is configured rather than an empty string: an unresolvable
        // Auto is a real state, and the send path is where it is explained.
        out[mode] = modelFor(settings, mode);
      }
    }
    return out;
  }

  /**
   * Modes whose pinned model has disappeared, with the fallback that will be used.
   *
   * Returns only what needs saying, so the UI can show one banner instead of
   * silently sending something the user did not choose.
   */
  async selectionNotices(): Promise<readonly MissingSelection[]> {
    const settings = this.#settings.get();
    const sections = await this.listProviderModels();
    const catalog = mergeModels(sections);
    // The sections matter as much as the flat list: without them an empty or
    // failed provider is indistinguishable from one that genuinely dropped the
    // model, and the user is told to pick a replacement that was never needed.
    return missingSelections(settings, catalog, sections);
  }

  // ---- turns -----------------------------------------------------------

  /**
   * The free-only policy, applied to whatever model this turn would use.
   *
   * Runs on every send rather than at selection time, because the two are not
   * the same moment: a model pinned last week can have been repriced since, and
   * a per-message model never passed through selection at all. The catalog is
   * only consulted when one is already loaded, so an unreachable provider
   * cannot turn into a refusal to send -- the alternative is an app that
   * cannot talk to anything while a catalog is down.
   */
  async #enforceFreePolicy(input: {
    model: string;
    providerId: string;
    settings: Settings;
    allowPaidModel: boolean;
  }): Promise<void> {
    if (!input.settings.autoSelectFreeModelsOnly) return;
    const provider = await this.#provider(input.providerId);
    if (!provider) return;

    let entry: ModelInfo | undefined;
    try {
      entry = (await provider.listModels()).models.find(
        (candidate) => candidate.id === input.model,
      );
    } catch {
      // No catalog, no verdict. Refusing to send because a price list could not
      // be fetched would be a worse failure than the one being prevented.
      return;
    }
    if (!entry) return;

    // A cost measured earlier in this session outranks the catalog's claim.
    // `null` is a real observation too -- "we could not tell what this cost" --
    // and it removes the price rather than zeroing it, so the model reads as
    // unknown and has to be agreed to again.
    // The observation travels as itself. It used to be written over the model's
    // price as if a per-turn total were a per-million-token rate, which produced
    // a number that was right by accident and off by orders of magnitude.
    const decision = checkModelPolicy(
      entry,
      providerById(input.providerId) ?? providerById(ZEN_PROVIDER_ID)!,
      { onlyFree: true, observed: this.#observedCost.get(input.model) },
    );

    if (decision.kind === "blocked") {
      throw new FreePolicyError(
        `${entry.name} cannot be used from Atomic: ${decision.reason}`,
        { model: entry.id, kind: "blocked", reason: decision.reason },
      );
    }
    if (decision.kind === "confirm" && !input.allowPaidModel) {
      throw new FreePolicyError(decision.reason, {
        model: entry.id,
        kind: "confirm",
        reason: decision.reason,
      });
    }
  }

  /**
   * The half of the free-only policy that runs after the fact.
   *
   * The catalog can be wrong, and a model whose published price was zero last
   * week is not free this week. This is where the number the provider actually
   * billed is checked, so the failure surfaces on the turn that caused it
   * rather than on an invoice.
   */
  async #reviewTurnCost(input: {
    model: string;
    providerId: string;
    usage: Pick<Usage, "inputTokens" | "outputTokens" | "reportedCost">;
    settings: Settings;
  }): Promise<TurnCostReview | null> {
    const provider = await this.#provider(input.providerId);
    if (!provider) return null;

    let entry: ModelInfo | undefined;
    try {
      entry = (await provider.listModels()).models.find(
        (candidate) => candidate.id === input.model,
      );
    } catch {
      return null;
    }
    if (!entry) return null;

    // How the catalog and this provider's own pricing classify the model, so the
    // post-turn guard can tell "unpriced" from "unpriced and known free". Those
    // are different facts and the old guard could not see the difference.
    const definition = providerById(input.providerId);
    const verdict = reviewTurnCost({
      model: entry,
      usage: input.usage,
      policy: { onlyFree: input.settings.autoSelectFreeModelsOnly },
      // Carried through only when the provider actually sent one. Passing the
      // field unconditionally would turn "did not report" into a reported zero,
      // which is the one value the guard cannot distinguish from a real free
      // turn -- so the absence has to stay an absence.
      ...(input.usage.reportedCost !== undefined
        ? { providerReportedCost: input.usage.reportedCost }
        : {}),
      ...(definition
        ? { freeness: freenessFor(definition, entry).freeness }
        : {}),
    });
    if (verdict.ok) {
      /*
       * Only a price that came out as zero counts as evidence. Recording every
       * allowed turn as free meant the common unpriced case -- a model nobody
       * publishes a rate for -- was treated as known free from its first reply,
       * and the pre-send gate stopped asking about it. So Atomic stopped
       * checking, on the strength of having not learned anything.
       */
      if (verdict.observed !== undefined) this.#observedCost.set(input.model, verdict.observed);
      return verdict;
    }

    // Worth remembering: the model that produced it is no longer free, so the
    // next turn gets asked about it instead of discovering it again.
    this.#observedCost.set(
      input.model,
      verdict.cost === null ? "unknown" : verdict.cost > 0 ? "paid" : "free",
    );
    return verdict;
  }

  /**
   * Continue a turn that stopped at the provider's output-token limit.
   *
   * Re-runs on the existing transcript rather than adding a user turn: a
   * "continue" prompt would be a fabricated question in the user's own voice, and
   * it would be counted against the free-model policy as if they had asked it.
   * The run record is still created, so the continued answer is an ordinary
   * message in the history.
   */
  async continueMessage(input: {
    readonly conversationId: string;
  }): Promise<{ readonly runId: string }> {
    const conversation = await this.#conversations.get(input.conversationId);
    if (!conversation)
      throw new Error(`Conversation ${input.conversationId} not found`);

    const settings = this.#settings.get();
    const mode = conversation.mode;
    let model: string;
    let providerId: string;
    let pinned: boolean;
    let fallbacks: readonly { readonly model: string; readonly providerId: string }[] = [];
    if (conversation.model) {
      // Reuse exactly what the truncated turn used. Resolving again could pick a
      // different model mid-answer, which reads as the assistant changing its
      // mind rather than finishing a thought.
      model = conversation.model;
      providerId = conversation.providerId || modelProviderFor(settings, mode);
      pinned = true;
    } else {
      const resolved = await this.#resolveModel(mode, settings);
      model = resolved.model;
      providerId = resolved.providerId;
      pinned = resolved.pinned;
      fallbacks = resolved.fallbacks;
    }
    if (!model) throw new Error("No model selected. Pick one in Settings → API & Models.");

    const runId = this.#newId();
    const controller = new AbortController();
    this.#active.set(runId, {
      runId,
      conversationId: conversation.id,
      controller,
    });
    await this.#runs.start({
      id: runId,
      conversationId: conversation.id,
      mode,
      task: "continue truncated answer",
      workspace: conversation.workspace,
    });
    this.#audit.write({
      kind: "run-start",
      conversationId: conversation.id,
      runId,
      mode,
      summary: "Continue truncated answer",
    });
    void this.#runLoop({
      providerId,
      conversation,
      runId,
      controller,
      model,
      pinned,
      fallbacks,
      mode,
      systemOverride: null,
    });
    return { runId };
  }

  /**
   * Answer the pending question on a provider the user explicitly chose.
   *
   * The failing turn's user message is already in the transcript, so this
   * re-runs the loop on the existing conversation and adds nothing to it. It
   * used to go back through `sendMessage` with the same text, which appended a
   * second copy of the user's message: the same question twice, one answer, and
   * a transcript that no longer matched what the user typed.
   *
   * Pinned, with no fallbacks. The user named this provider, so a second silent
   * switch would be the thing they just declined -- if this one fails too, the
   * run ends and offers again rather than deciding for them.
   */
  async retryOnProvider(input: {
    readonly conversationId: string;
    readonly model: string;
    readonly providerId: string;
  }): Promise<{ readonly runId: string }> {
    const conversation = await this.#conversations.get(input.conversationId);
    if (!conversation)
      throw new Error(`Conversation ${input.conversationId} not found`);

    const mode = conversation.mode;
    const runId = this.#newId();
    const controller = new AbortController();
    this.#active.set(runId, {
      runId,
      conversationId: conversation.id,
      controller,
    });
    await this.#runs.start({
      id: runId,
      conversationId: conversation.id,
      mode,
      task: "retry on another provider",
      workspace: conversation.workspace,
    });
    this.#audit.write({
      kind: "run-start",
      conversationId: conversation.id,
      runId,
      mode,
      summary: `Retry on ${input.providerId}`,
    });
    void this.#runLoop({
      providerId: input.providerId,
      conversation,
      runId,
      controller,
      model: input.model,
      pinned: true,
      fallbacks: [],
      mode,
      systemOverride: null,
    });
    return { runId };
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const conversation = await this.#conversations.get(input.conversationId);
    if (!conversation)
      throw new Error(`Conversation ${input.conversationId} not found`);

    const settings = this.#settings.get();
    const mode = conversation.mode;
    // An explicit per-message model wins, then the conversation's own, then the
    // mode default -- which may be the `auto` sentinel and need resolving.
    let model: string;
    let providerId: string;
    let pinned: boolean;
    let fallbacks: readonly { readonly model: string; readonly providerId: string }[] = [];
    if (input.model) {
      model = input.model;
      // An explicit provider is a user decision and is used as given. Without
      // it the catalog is consulted, which is a guess -- and a wrong guess
      // sends the conversation to an account the user never chose.
      providerId =
        input.providerId ?? (await this.providerForModel(input.model));
      pinned = true;
    } else if (conversation.model) {
      model = conversation.model;
      // The conversation recorded the provider this model was chosen from, which
      // is not necessarily today's active provider.
      providerId = conversation.providerId || modelProviderFor(settings, mode);
      pinned = true;
    } else {
      const resolved = await this.#resolveModel(mode, settings);
      model = resolved.model;
      providerId = resolved.providerId;
      pinned = resolved.pinned;
      fallbacks = resolved.fallbacks;
    }
    if (!model)
      throw new Error(
        "No model selected. Pick one in Settings → API & Models.",
      );

    await this.#enforceFreePolicy({
      model,
      providerId,
      settings,
      // A per-message model is the one place the user can pick something the
      // policy has not already vetted, so it is the one that may carry consent.
      allowPaidModel: input.allowPaidModel === true,
    });

    const attachments = input.attachments ?? [];
    const content: ContentPart[] = [];
    if (input.text.trim()) content.push({ type: "text", text: input.text });
    for (const attachment of attachments) {
      if (attachment.mimeType.startsWith("image/")) {
        content.push({
          type: "image",
          data: attachment.data,
          mimeType: attachment.mimeType,
        });
      } else {
        content.push({
          type: "file",
          data: attachment.data,
          mimeType: attachment.mimeType,
          name: attachment.name,
        });
      }
    }

    const userMessage = await this.#conversations.addMessage({
      id: this.#newId(),
      conversationId: conversation.id,
      role: "user",
      content,
      parentId: input.parentId ?? null,
      attachments: attachments.map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        size: a.size,
      })),
    });

    if (!conversation.title) {
      await this.#conversations.update(conversation.id, {
        title: deriveTitle(input.text),
      });
    }

    const runId = this.#newId();
    const controller = new AbortController();
    this.#active.set(runId, {
      runId,
      conversationId: conversation.id,
      controller,
    });

    await this.#runs.start({
      id: runId,
      conversationId: conversation.id,
      mode,
      task: input.text.slice(0, 500),
      workspace: conversation.workspace,
    });
    this.#audit.write({
      kind: "run-start",
      conversationId: conversation.id,
      runId,
      mode,
      summary: `${mode} run: ${deriveTitle(input.text, 80)}`,
    });

    // Kick off the loop; the UI follows `streamEvents()`.
    void this.#runLoop({
      providerId,
      conversation,
      runId,
      controller,
      model,
      pinned,
      fallbacks,
      mode,
      systemOverride: input.systemPrompt ?? null,
    });

    return { userMessage, runId };
  }

  async #runLoop(args: {
    conversation: Conversation;
    runId: string;
    controller: AbortController;
    model: string;
    /** The provider that serves `model`. Not the global active one. */
    providerId: string;
    /** True when the user pinned the model; disables the runtime fallback. */
    pinned: boolean;
    /** Alternatives to try when the chosen model is unavailable. */
    fallbacks: readonly { readonly model: string; readonly providerId: string }[];
    mode: Mode;
    systemOverride: string | null;
  }): Promise<void> {
    const { conversation, runId, controller, model, mode, pinned, fallbacks } =
      args;
    const settings = this.#settings.get();
    const provider = await this.#provider(args.providerId);
    if (!provider) {
      this.#events.emit({
        type: "run-error",
        runId,
        message: "No provider configured",
        userMessage: `No credentials for ${providerById(args.providerId)?.label ?? args.providerId}. Add its API key in Settings → Models.`,
        kind: "config",
      });
      this.#active.delete(runId);
      return;
    }

    const history = await this.#conversations.messages(conversation.id);
    const modelMessages: ModelMessage[] = toModelMessages(history);

    const projectMemory =
      mode === "code" && settings.loadProjectMemory && conversation.workspace
        ? await this.#services.readProjectMemory(conversation.workspace)
        : null;

    const system = buildSystemPrompt({
      mode,
      platform: this.#services.platform,
      shell: this.#services.shell,
      workspace: conversation.workspace,
      customSystemPrompt: args.systemOverride ?? conversation.systemPrompt,
      customInstructions: settings.customInstructions,
      projectMemory,
      today: new Date(this.#now()),
      tools: this.#registry.names(mode),
      // Read from the same registry that will serve the run, so the prompt can
      // only describe a browser if one is actually reachable. Hard-coding this
      // as `true` is what had Cowork telling the model to screenshot pages it
      // had no way to open.
      browserTools: this.#registry
        .list(mode)
        .filter((tool) => tool.categories.includes("browser"))
        .map((tool) => tool.name),
      planMode: settings.permissions[mode].level === "plan",
      // A switch that read its own label out of a schema nobody consulted. It is
      // enforced in the prompt rather than in the gate on purpose: a clarifying
      // question is something the model *chooses to say*, so only the prompt can
      // stop it. Permissions are the gate's business and this setting must never
      // reach them -- a run that cannot ask a question is not a run allowed to
      // skip an approval.
      noQuestionsMode: settings.permissions[mode].noQuestionsMode,
    });

    const gate = new PermissionGate(() => this.#settings.get(), {
      platform: this.#services.platform,
    });

    const loop = new AgentLoop({
      provider,
      // Every configured provider, so a fallback after a rate limit can be sent
      // to a provider that is *not* the one refusing. Resolved lazily and
      // tolerantly: a provider without credentials is simply absent from the
      // list, and a fallback naming it is skipped rather than failing.
      providers: await this.#configuredProviderObjects(),
      registry: this.#registry,
      gate,
      events: this.#events,
      approval: this.#approval,
      // Automatic compaction. This is what keeps a long Code session from
      // eventually failing with a provider context error: the loop folds older
      // turns into a summary before the window fills, rather than after.
      compaction: {
        contextWindow: await this.#contextWindow(model),
        keepRecent: 6,
      },
      reviewUsage: async ({ model: usedModel, usage }) => {
        return this.#reviewTurnCost({
          model: usedModel,
          providerId: provider.id,
          usage,
          settings,
        });
      },
      // Asked per fallback, not once per run, so a model the run has just
      // discovered is unusable is not next in line for a request.
      isModelUsable: (candidate) =>
        hasModelBlockList(provider) ? !provider.isModelBlocked(candidate) : true,
      onAssistantMessage: async ({ messageId, message }) => {
        await this.#conversations.addMessage({
          id: messageId,
          conversationId: conversation.id,
          role: "assistant",
          content: message.content,
          runId,
          model,
          providerId: provider.id,
          toolCalls: message.toolCalls ?? null,
          ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        });
      },
      onToolResult: async ({ call, result, outcome }) => {
        this.#audit.write({
          kind: "tool-result",
          conversationId: conversation.id,
          runId,
          tool: call.name,
          mode,
          decision: outcome.decision,
          summary: result.isError ? "error" : "ok",
          detail: {
            args: call.args,
            outcome: outcome.rule,
            content: result.content.slice(0, 2_000),
          },
        });
        await this.#conversations.addMessage({
          id: this.#newId(),
          conversationId: conversation.id,
          role: "tool",
          content: [{ type: "text", text: result.content }],
          runId,
          toolCallId: call.id,
          toolName: call.name,
          // Persisted so a diff or a terminal transcript is still reviewable
          // after a reload, not just during the run that produced it.
          ...(result.display === undefined ? {} : { display: result.display }),
        });
      },
    });

    try {
      const result = await loop.run({
        conversationId: conversation.id,
        runId,
        mode,
        model,
        system,
        messages: modelMessages,
        workspace: conversation.workspace,
        // A function, not a snapshot. The agent can ask for a folder partway
        // through this very run and the user can approve it, and the next tool
        // call has to see the result -- otherwise the approval appears to do
        // nothing until the next message, which is worse than not having it.
        //
        // Read through the store rather than through the `settings` captured
        // above, for the same reason.
        extraRoots: () => this.#settings.get().files.allowedFolders,
        signal: controller.signal,
        // Only an auto-selected model may be substituted. A model the user picked
        // answers with itself or not at all.
        allowModelFallback: !pinned,
        ...(pinned
          ? {}
          : {
              fallbackModels: fallbacks.map((entry) => ({
                model: entry.model,
                providerId: entry.providerId,
                // Named so the switch notice can say who is answering, which is
                // the point of preferring another provider after a 429.
                providerLabel: providerById(entry.providerId)?.label,
              })),
            }),
        maxSteps: settings.permissions[mode].maxSteps || undefined,
        // The block `maxSteps` came out of, so the runtime and spend limits
        // reach the loop too, instead of sitting in settings being displayed as
        // though they were in force. Only the permissions are handed over: the
        // loop has no business reading generation or notification settings.
        settings: { permissions: settings.permissions },
        ...(settings.generation.temperature !== undefined
          ? { temperature: settings.generation.temperature }
          : {}),
        ...(settings.generation.maxOutputTokens
          ? { maxOutputTokens: settings.generation.maxOutputTokens }
          : {}),
        ...(settings.generation.reasoningEffort
          ? { reasoningEffort: settings.generation.reasoningEffort }
          : {}),
      });
      await this.#runs.finish(
        runId,
        result.reason === "cancelled"
          ? "cancelled"
          : result.reason === "error"
            ? "error"
            : "done",
        result.steps,
      );
    } catch (error) {
      const providerError = toProviderError(error);
      await this.#runs.finish(
        runId,
        isAbort(error) ? "cancelled" : "error",
        0,
        providerError.message,
      );
    } finally {
      this.#active.delete(runId);
      await this.#audit.flush();
    }
  }

  streamEvents(): AsyncIterable<AgentEvent> {
    const bus = this.#events;
    return {
      async *[Symbol.asyncIterator]() {
        const queue: AgentEvent[] = [];
        let notify: (() => void) | undefined;
        const unsubscribe = bus.subscribe((event) => {
          queue.push(event);
          notify?.();
        });
        try {
          while (true) {
            while (queue.length) yield queue.shift()!;
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = undefined;
          }
        } finally {
          unsubscribe();
        }
      },
    };
  }

  cancelRun(runId: string): void {
    const run = this.#active.get(runId);
    if (!run) return;
    run.controller.abort();
    this.#approval.denyAll();
    this.#active.delete(runId);
  }

  cancelAll(): void {
    for (const run of this.#active.values()) run.controller.abort();
    this.#active.clear();
    this.#approval.denyAll();
  }

  // ---- approvals -------------------------------------------------------

  listPendingApprovals(): Promise<PendingApproval[]> {
    return Promise.resolve(this.#approval.list());
  }

  /**
   * Record the standing grant behind "allow always", then resolve the request.
   *
   * The order matters. `resolve` drops the pending entry, so the suggestion has
   * to be read first -- asking the broker afterwards always comes back empty, and
   * the write would have to be skipped exactly when the user asked for one.
   *
   * A suggestion with no list is not written. The three lists are matched
   * differently and a value in the wrong one is a grant that never applies,
   * which is the failure this whole path exists to remove.
   */
  async resolveApproval(
    callId: string,
    decision: ApprovalDecision,
  ): Promise<boolean> {
    if (decision === "allow-always") {
      const pending = this.#approval.list().find((entry) => entry.callId === callId);
      if (pending?.suggestion && pending.suggestionList) {
        await this.#rememberAllowed(pending.suggestionList, pending.suggestion, pending.mode);
      }
    }
    return this.#approval.resolve(callId, decision);
  }

  /**
   * Append one entry to a per-mode allow-list, without duplicating it.
   *
   * Skipped when the value is already allowed, so approving the same command
   * twice does not grow the list -- a list that only ever grows is how a
   * once-narrow grant turns into a broad one nobody re-reads.
   *
   * The deny lists are deliberately not consulted. They are checked ahead of the
   * allow lists on every call, so an entry the user just added cannot grant
   * anything they have denied, and refusing to write it would make the button
   * appear broken rather than saying the rule that overrode it.
   */
  async #rememberAllowed(list: AllowList, value: string, mode: Mode): Promise<void> {
    const settings = this.#settings.get();
    const existing = settings.permissions[mode][list];
    if (!existing.includes(value)) {
      await this.#settings.setPermission(mode, { [list]: [...existing, value] });
    }
  }

  // ---- tools & audit ---------------------------------------------------

  listTools(mode: Mode) {
    return Promise.resolve(
      this.#registry.list(mode).map((tool) => ({
        name: tool.name,
        description: tool.description,
        categories: [...tool.categories],
      })),
    );
  }

  listExtensions(): Promise<ExtensionSummary[]> {
    // `missing` rides along with the registry's own summary rather than being
    // looked up here: a declared tool with no implementation is a fact about the
    // manifest and the build, and recomputing it would give the panel a second
    // answer to the same question.
    return Promise.resolve(
      this.#extensions.summaries().map((summary) => ({
        ...summary,
        missing: this.#unimplemented.get(summary.id) ?? [],
      })),
    );
  }

  /**
   * Switch a capability on or off, and remember it.
   *
   * Persisted as a refusal rather than an approval, so the list cannot grow into a
   * quota the user has to re-approve on every new version. An id this build
   * cannot run at all is refused without being written: recording "off" for
   * something that was never on would make the next install of it silently
   * inherit the switch.
   */
  async setExtensionEnabled(id: string, enabled: boolean): Promise<boolean> {
    if (!this.#extensions.setEnabled(id, enabled)) return false;

    const disabled = new Set(this.#settings.get().disabledExtensions);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    await this.#settings.patch({ disabledExtensions: [...disabled].sort() });
    return true;
  }

  readAudit(
    filter: { conversationId?: string; runId?: string; limit?: number } = {},
  ): Promise<AuditRow[]> {
    return this.#audit.list(filter);
  }

  // ---- workspace -------------------------------------------------------

  pickFolder(title?: string): Promise<string | null> {
    return this.#services.pickFolder(title);
  }

  pickFiles(options?: {
    multiple?: boolean;
    directory?: boolean;
  }): Promise<Attachment[]> {
    return this.#services.pickFiles(options);
  }

  attachFromClipboard(): Promise<Attachment[]> {
    return this.#services.attachFromClipboard();
  }

  revealPath(path: string): Promise<void> {
    return this.#services.revealPath(path);
  }

  // ---- internals -------------------------------------------------------

  /**
   * Build the provider for `providerId`.
   *
   * Any entry in the registry works, not just OpenCode: that is what lets a
   * pasted key pick its own destination. A user-supplied base URL always wins,
   * because a self-hosted or proxied endpoint has no place in the registry.
   */
  /**
   * Costs this session has actually observed, keyed by model.
   *
   * Overrides the catalog. A published price is a claim made before the call;
   * this is the number that came back afterwards, so when the two disagree the
   * second one is the one worth believing. In-memory only: it is a correction to
   * this session's catalog, not a fact about the provider, and a wrong guess
   * here should not outlive a restart.
   */
  readonly #observedCost = new Map<string, ObservedCost>();

  async #provider(providerId: string): Promise<ModelProvider | null> {
    const settings = this.#settings.get();
    const known = providerById(providerId);
    if (!known) return null;

    // Ollama is not a hosted provider with a key: its listing is the native
    // /api/tags rather than an OpenAI /models response, so it gets its own class
    // on the request path too. Routing it through ZenProvider would report zero
    // models while completions worked, which is the most confusing possible
    // combination.
    if (providerId === OLLAMA_PROVIDER_ID) return this.#ollamaProvider();
    const providerSettings = settings.providers[providerId] ?? {
      baseUrl: "",
      apiKeySource: "unset" as const,
      apiKeyEnvVar: "",
    };
    // Keychain first, then the environment variable the provider documents. The
    // variable's value is read now, for this provider, rather than from a map of
    // every key in the environment that was fetched at startup and held for the
    // life of the process.
    const envVar = this.#envVarFor(providerId);
    const apiKey =
      (await this.#readKey(providerId)) ??
      (envVar ? await this.#envRead(envVar) : null) ??
      null;
    return new ZenProvider(
      {
        apiKey,
        baseUrl: providerSettings.baseUrl || known.baseUrl,
        ownKeys: this.#services.ownKeys,
      },
      {
        db: this.#db,
        // `apiKey` above already resolved keychain-then-environment, so handing
        // the whole environment over as a fallback would only re-introduce the
        // standing map this method used to pass.
        env: {},
        now: this.#now,
        // The identity and the label of the provider this instance answers for.
        // Without these it claimed to be Zen, so a Gemini run was recorded,
        // priced and offered as a fallback as OpenCode Zen.
        providerId: known.id,
        label: known.label,
        ...(known.catalogSource
          ? { catalogSource: known.catalogSource }
          : {}),
        // Only Zen publishes the routing table the id heuristics are built on.
        hasRoutingTable: known.id === ZEN_PROVIDER_ID,
        defaultWireFormat: known.defaultWireFormat,
        ...(this.#services.fetch ? { fetch: this.#services.fetch } : {}),
      },
    );
  }

  /**
   * The environment variable a provider's key is read from.
   *
   * The per-provider setting wins over the registry default, so a provider whose
   * key is not in the conventional variable can still be reached.
   */
  #envVarFor(providerId: string): string {
    const known = providerById(providerId);
    return this.#settings.get().providers[providerId]?.apiKeyEnvVar || known?.envVar || "";
  }
}

/**
 * The seq at which the messages kept verbatim begin.
 *
 * Indexed into the *filtered* surviving messages, never into the raw history.
 * Once a conversation has been compacted, those two lists have different
 * lengths -- the history still holds every superseded row plus the summary that
 * replaced them -- so using one index against both quietly picked the wrong
 * boundary. The second compaction would then drop turns the user still expected
 * to see.
 *
 * The out-of-range fallback is `0`, not `Infinity`. `supersedeBefore` marks
 * everything below the boundary, so a large fallback would hide an
 * out-of-range index by superseding the *entire* conversation: the model would
 * see only the new summary and the user's scrollback would be gone. Zero marks
 * nothing, so an unreachable case fails safe. `planCompaction` keeps `keepFrom`
 * inside the list, so this is only a backstop.
 */
export function compactionBoundary(
  surviving: readonly { readonly seq: number }[],
  keepFrom: number,
): number {
  return surviving[keepFrom]?.seq ?? 0;
}

/**
 * Normalise a pasted key, or throw with something the user can act on.
 *
 * Surrounding whitespace and newlines are stripped -- they are never part of a
 * key. Interior whitespace is refused rather than removed: a newline or space
 * *inside* a credential means the paste was mangled (a soft-wrapped line, two
 * keys pasted together, a stray comma), and quietly deleting the whitespace
 * would produce a plausible-looking key that can only ever 401.
 */
/** True when this provider can prove a credential, as opposed to being local. */
function hasCredentialCheck(
  provider: ModelProvider,
): provider is ModelProvider & {
  verifyCredentials: NonNullable<Provider["verifyCredentials"]>;
} {
  return (
    typeof (provider as Partial<Provider>).verifyCredentials === "function"
  );
}

/** True when a provider keeps learned per-model facts, as Zen does. */
function hasModelBlockList(
  provider: ModelProvider,
): provider is ModelProvider & {
  isModelBlocked: NonNullable<Provider["isModelBlocked"]>;
} {
  return typeof (provider as Partial<Provider>).isModelBlocked === "function";
}

function normalizeApiKey(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, "");
  if (trimmed === "") return null;
  if (/\s/.test(trimmed)) {
    throw new ProviderError(
      ProviderErrorKind.config,
      "api_key_interior_whitespace",
      "That API key contains a space or a line break in the middle. Copy it again as a single line, with nothing before or after it.",
    );
  }
  return trimmed;
}

/**
 * The canonical keychain slot for a provider's key.
 *
 * `SecretKeys` is the only place these strings are written down, and the previous
 * version carried its own copy of the mapping *and* an independent template, so a
 * provider added to one list and not the other read from a different slot than it
 * wrote to -- a key that saved fine and then read as absent. The mapping and the
 * derived form now come from the same place, and the check below fails loudly if
 * the documented constant ever drifts from the derived name, which is the only way
 * this bug can come back.
 */
function secretKeyFor(providerId: string): string {
  const known: Record<string, string> = {
    "opencode-zen": SecretKeys.zen,
    anthropic: SecretKeys.anthropic,
    openrouter: SecretKeys.openrouter,
    ollama: SecretKeys.ollama,
  };
  const documented = known[providerId];
  if (documented !== undefined && documented !== withProvider(providerId)) {
    throw new Error(
      `SecretKeys.${providerId} ("${documented}") does not match withProvider("${providerId}") ("${withProvider(providerId)}"). A key written to one slot would be read from the other.`,
    );
  }
  return secretSlotsFor(providerId)[0];
}

/** The registry's label for a provider, or its id when this build has no entry. */
function providerLabel(providerId: string): string {
  return providerById(providerId)?.label ?? providerId;
}

export function defaultId(): string {
  const crypto = globalThis.crypto;
  if (crypto && "randomUUID" in crypto) return crypto.randomUUID();
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export { basename, SettingsSchema, addUsage, EMPTY_USAGE };
export type { HostEnvironment, Usage };
