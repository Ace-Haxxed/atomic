/**
 * Composition root.
 *
 * `LocalHost` is host-agnostic; this function supplies the four things it cannot
 * know on its own — the platform, the keychain, SQLite and the app directories —
 * and returns the single `HostApi` instance the UI talks to. There is no second
 * way to reach the model, the database or the keychain from the UI: everything
 * goes through this object.
 */

import {
  AuditLog,
  LocalHost,
  SettingsStore,
  ToolRegistry,
  createFolderTools,
  withFolder,
  setProviderDiagnostics,
  databasePath,
  deriveAppDirs,
  fallbackShell,
  isBypassActive,
  runMigrations,
  type AppDirs,
  type Database,
  type CheckpointRunInfo,
  type FolderAccessPort,
  type HostApi,
  type HostServices,
  type PlatformInfo,
  type SecretStore,
  type Settings,
  type ShellProfile,
} from "@atomic/core";

import {
  appDirs,
  appVersion,
  attachments,
  call,
  database,
  keychain,
  platformInfo,
  memoryDatabase,
  envProviderKey,
  envProviderKeyPresence,
  readClipboardImage,
} from "./host.js";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { Attachment } from "@atomic/core";

/** The keychain behind the `SecretStore` port. Values never reach SQLite. */
class KeychainSecretStore implements SecretStore {
  async get(key: string): Promise<string | null> {
    return keychain.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await keychain.set(key, value);
  }

  async delete(key: string): Promise<void> {
    await keychain.delete(key);
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await call<boolean>("secret_available");
    } catch {
      return false;
    }
  }

  /**
   * Environment credentials, read one at a time.
   *
   * These two exist so the whole environment does not have to be handed over
   * once at startup. Presence answers the "is this provider configured" question
   * with a boolean; the value is fetched only while constructing the one
   * provider that needs it, and is not cached anywhere.
   */
  async hasEnv(name: string): Promise<boolean> {
    const presence = await envProviderKeyPresence().catch(() => ({}) as Record<string, boolean>);
    return presence[name] === true;
  }

  async readEnv(name: string): Promise<string | null> {
    return envProviderKey(name).catch(() => null);
  }
}

let instance: Promise<Bootstrap> | null = null;

export interface Bootstrap {
  readonly api: HostApi;
  readonly dirs: AppDirs;
  readonly platform: PlatformInfo;
  /**
   * Set when the on-disk database could not be opened and an in-memory one is in
   * use instead. The app is fully usable — onboarding, settings and chat all
   * work — but nothing is written to disk, so the UI must say so loudly.
   */
  readonly degraded: { readonly reason: string } | null;
}

/** A readable reason, from either a Tauri `Error` or a plain `Error`. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}

/** Build the app. Safe to call repeatedly: the work happens once. */
export function bootstrap(): Promise<Bootstrap> {
  if (!instance) {
    instance = start().catch((error) => {
      // A failed bootstrap must be retryable, not permanently poisoned.
      instance = null;
      throw error;
    });
  }
  return instance;
}

async function start(): Promise<Bootstrap> {
  const [platform, resolved, version] = await Promise.all([
    platformInfo(),
    appDirs(),
    appVersion(),
  ]);
  // Throws if a path repeats the app directory, which is the mistake that made
  // the app fail to start with SQLITE_CANTOPEN.
  const dirs = deriveAppDirs(platform, resolved);
  const shell: ShellProfile = fallbackShell(platform);

  const dbFile = databasePath(dirs, platform);
  if (import.meta.env.DEV) {
    console.info(`[atomic] data dir: ${dirs.dataDir}`);
    console.info(`[atomic] database: ${dbFile}`);
  }

  // Resolve the transport before anything can issue a request. Inside Tauri the
  // webview's own `fetch` is subject to CORS and model endpoints send no
  // `Access-Control-Allow-Origin`, so every call silently failed and the picker
  // looked empty. The plugin's `fetch` keeps the exact same signature, including
  // streaming bodies, so the provider code does not care which one it is given.
  //
  // `appDirs()` above only resolves if a Rust command answered, so it is the
  // evidence that decides this -- not a sniff for a global. The sniff was wrong:
  // it read as absent on a cold start and present moments later on the same
  // page, which sent the app to the CORS-blocked browser `fetch` and made a
  // working key look invalid.
  const hostFetch = tauriFetch;

  // Development builds only. Core is compiled with plain `tsc`, so the flag has
  // to be set from the app, which is where `import.meta.env` actually exists.
  // In a release this is a constant false and the branch is compiled away.
  setProviderDiagnostics(import.meta.env.DEV);

  // A database that cannot be opened normally is not fatal: settings, the
  // keychain and the model calls all work against an in-memory database, so the
  // user can finish onboarding instead of staring at an error page. The cost is
  // that nothing survives a restart, which is why `degraded` is surfaced and the
  // reason is kept — a silent fallback here would look like data loss.
  const { db, degraded } = await openDatabaseWithFallback(dbFile);
  await runMigrations(db);

  const secrets: SecretStore = new KeychainSecretStore();
  const settings = await SettingsStore.load(db);
  const audit = new AuditLog(db);
  const registry = new ToolRegistry();

  /**
   * The `add_folder` implementation, and the only code path where a folder the
   * agent named becomes one the app will read.
   *
   * Two steps in a fixed order, and the order is the safety property: Rust
   * decides whether the path is a real, permitted folder, and only then is
   * anything written. A failed check leaves settings exactly as they were, so a
   * refused request cannot leave a root behind for the next run to find.
   *
   * The permission decision is not made here. By the time this runs the gate has
   * already ruled -- the user approved the prompt, or autonomy is on -- and this
   * function has no way to be asked to make that call.
   */
  const folders: FolderAccessPort = {
    authorize: async (path: string) => {
      // Verified in Rust, not here: the check needs the real filesystem, and a
      // TypeScript version would be a second implementation of a rule that has
      // to be right. It canonicalizes, so a symlink is judged by where it points.
      const check = await call<{ ok: boolean; path?: string; reason?: string }>("check_folder", {
        path,
      });
      if (!check.ok || !check.path) {
        return { ok: false, reason: check.reason ?? `"${path}" could not be used.` };
      }

      const current = settings.get().files.allowedFolders;
      const next = withFolder(current, check.path, platform);
      // Already authorized. Success, not failure: the agent asking twice should
      // not read as something having gone wrong.
      if (!next) return { ok: true, path: check.path };

      // Written through the store, so listeners fire and the value survives a
      // restart. A write that fails here throws, and the folder is *not* added --
      // better a clear failure than a tool result claiming access that the next
      // run will not find.
      await settings.patch({ files: { allowedFolders: next } });
      return { ok: true, path: check.path };
    },
  };

  const services: HostServices = {
    platform,
    shell,
    dirs,
    // Deliberately empty. Environment credentials are reached through
    // `KeychainSecretStore.hasEnv`/`readEnv`, one provider at a time, so no
    // long-lived map of credentials exists in the webview.
    env: {},
    version,
    hostName: "tauri",
    pickFolder: (title) => call<string | null>("pick_folder", { title }),
    pickFiles: (options) => call("pick_files", { options: options ?? {} }),
    attachFromClipboard: async () => {
      const image = await readClipboardImage();
      if (!image) return [];
      return attachments.fromBase64(image.name, image.base64) as Promise<Attachment[]>;
    },
    revealPath: (path) => call("reveal_path", { path }),
    readProjectMemory: (workspace) => call<string | null>("read_project_memory", { workspace }),
    // Code-mode ports. Every path here is re-checked against the canonicalized
    // roots on the Rust side; nothing in TypeScript gets to decide whether a
    // path is safe. The whole list travels rather than a single workspace
    // because a path is authorized by landing inside *any* of them -- the open
    // workspace first, then the folders the user added under Settings.
    fs: {
      readFile: (roots, path, options) =>
        call("fs_read", { workspaceRoots: [...roots], path, ...(options ?? {}) }),
      writeFile: (roots, path, content) =>
        call("fs_write", { workspaceRoots: [...roots], path, content }),
      listDirectory: (roots, path) => call("fs_list", { workspaceRoots: [...roots], path }),
      glob: (roots, pattern) => call("fs_glob", { workspaceRoots: [...roots], pattern }),
      grep: (roots, pattern, options) =>
        call("fs_grep", { workspaceRoots: [...roots], pattern, ...(options ?? {}) }),
    },
    process: {
      run: (root, command, options) =>
        call("process_run", { workspaceRoot: root, command, ...(options ?? {}) }),
      git: (root, args) => call("git_run", { workspaceRoot: root, args }),
      isGitRepository: (root) => call<boolean>("git_is_repository", { workspaceRoot: root }),
      defaultBranch: (root) => call<string | null>("git_default_branch", { workspaceRoot: root }),
    },
    // Checkpoints live in the app data directory, not the workspace: a backup
    // the agent can see is a backup it can edit or delete.
    checkpoints: {
      save: (input) =>
        call("checkpoint_save", {
          backupsDir: dirs.backups,
          conversationId: input.conversationId,
          runId: input.runId,
          path: input.path,
          existed: input.existed,
          before: input.before,
        }),
      list: (conversationId) =>
        call<readonly CheckpointRunInfo[]>("checkpoint_list", { backupsDir: dirs.backups, conversationId }),
      restore: (input) =>
        call<readonly string[]>("checkpoint_restore", {
          workspaceRoot: input.workspaceRoot,
          backupsDir: dirs.backups,
          conversationId: input.conversationId,
          runId: input.runId,
          ...(input.path === undefined ? {} : { path: input.path }),
        }),
      discard: (conversationId, runId) =>
        call("checkpoint_discard", { backupsDir: dirs.backups, conversationId, runId }),
    },
    ...(hostFetch ? { fetch: hostFetch } : {}),
  };

  const api = new LocalHost({ db, secrets, settings, services, registry, audit });

  /*
   * Keep `add_folder` in step with the setting that governs it.
   *
   * After the host, deliberately. `LocalHost` registers the Code tools only when
   * the registry is still empty, so registering anything first would suppress
   * every other tool rather than just adding one.
   *
   * The tool is added and removed rather than always present and always refused:
   * a model that can see a capability is a model that keeps calling it, and one
   * that has been told the agent may not do this should not be left to discover
   * that from refusals.
   */
  const addFolderTools = createFolderTools({ folders });
  const syncFolderTool = () => {
    const allowed = settings.get().files.agentCanRequestFolders;
    if (allowed && !registry.has("add_folder")) {
      for (const tool of addFolderTools) registry.register(tool);
      return;
    }
    if (!allowed) registry.unregister("add_folder");
  };
  syncFolderTool();
  settings.subscribe(syncFolderTool);

  // Bypass is dangerous enough to deserve one audit line and a visible banner.
  if (isBypassActive(settings.get() as Settings)) {
    audit.write({ kind: "permission-decision", summary: "Bypass permissions are active", mode: "code" });
  }

  await syncShortcuts(settings.get() as Settings, shell);
  return { api, dirs, platform, degraded };
}

/**
 * Open the database on disk, falling back to memory.
 *
 * Returns the reason in the degraded case rather than throwing, because the whole
 * point is that the user still gets a working app. If even the in-memory database
 * fails there is nothing left to fall back to, so that error propagates.
 */
async function openDatabaseWithFallback(file: string): Promise<{
  db: Database;
  degraded: { reason: string } | null;
}> {
  try {
    return { db: await database(file), degraded: null };
  } catch (error) {
    const reason =
      `Atomic could not open its database at ${file}: ${describe(error)}`;
    console.error(`[atomic] ${reason} — continuing without saving`);
    try {
      return { db: await memoryDatabase(), degraded: { reason } };
    } catch (memoryError) {
      throw new Error(
        `${reason} Falling back to an in-memory database also failed: ${describe(memoryError)}`,
        { cause: memoryError },
      );
    }
  }
}

async function syncShortcuts(settings: Settings, shell: ShellProfile): Promise<void> {
  try {
    const accelerator = settings.app.globalHotkey;
    if (accelerator) await call("shortcut_register", { accelerator });
  } catch {
    // A hotkey that the OS already owns is not a fatal condition.
  }
  void shell;
}
