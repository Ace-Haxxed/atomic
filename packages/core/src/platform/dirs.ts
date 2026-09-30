/**
 * Where Atomic keeps its data, per OS.
 *
 * The host supplies the environment variables so this module never reads
 * `process.env` directly. Hosts that cannot answer should pass `null` and the
 * resolution falls back to documented defaults.
 *
 * ## Two ways to get an `AppDirs` — do not mix them
 *
 * - {@link resolveAppDirs} — for a host that knows only the *roots*
 *   (`$XDG_DATA_HOME`, `%APPDATA%`, `~/Library`). It appends {@link APP_DIR_NAME}
 *   itself, so every value you pass in must **not** already contain it.
 * - {@link deriveAppDirs} — for a host that already knows its final directories
 *   from the OS (Tauri's `app_data_dir()` and friends return paths that already
 *   end in the bundle identifier). It uses them verbatim.
 *
 * Passing an already-app-specific path to {@link resolveAppDirs} is the bug that
 * made the app fail to start with `SQLITE_CANTOPEN`: it produced
 * `~/.local/share/dev.atomic.app/dev.atomic.app/atomic.db`. {@link deriveAppDirs}
 * rejects that shape rather than repeating it, and {@link assertResolvedDirs}
 * checks an `AppDirs` that came from anywhere.
 */

import { joinPath } from "./paths.js";
import type { PlatformInfo } from "./platform.js";

/** App/bundle identifier. Matches the Tauri bundle id and the deep-link scheme owner. */
export const APP_ID = "dev.atomic.app";
export const APP_NAME = "Atomic";
/** Reverse-DNS folder used inside AppData / Application Support. */
export const APP_DIR_NAME = "dev.atomic.app";

/** File name of the SQLite database inside the data directory. */
export const DATABASE_FILE = "atomic.db";
/** File name of the log inside the log directory. Never receives a secret. */
export const LOG_FILE = "atomic.log";

export interface AppDirs {
  /** `~/Library/Application Support/dev.atomic.app` on macOS, `%APPDATA%\dev.atomic.app` on Windows, `$XDG_DATA_HOME/dev.atomic.app` on Linux. */
  readonly data: string;
  /** Where the SQLite file and large blobs live. */
  readonly dataDir: string;
  /** Small user-editable config. Defaults to `data` when the OS has no separate location. */
  readonly config: string;
  /** Cache that is safe to delete (model catalog, icons). */
  readonly cache: string;
  /** Logs. Never contains secrets. */
  readonly logs: string;
  /** Backups written by the checkpoint system. */
  readonly backups: string;
  /** Screenshots and other attachments, if the host stores them on disk. */
  readonly attachments: string;
}

export interface HostEnvironment {
  readonly home: string | null;
  /** Windows: `%APPDATA%`, `%LOCALAPPDATA%`, `%TEMP%`. */
  readonly appData: string | null;
  readonly localAppData: string | null;
  readonly tempDir: string | null;
  /** Linux/BSD: `$XDG_DATA_HOME`, `$XDG_CONFIG_HOME`, `$XDG_CACHE_HOME`, `$XDG_STATE_HOME`. */
  readonly xdgDataHome: string | null;
  readonly xdgConfigHome: string | null;
  readonly xdgCacheHome: string | null;
  readonly xdgStateHome: string | null;
  /** macOS: `~/Library/...` root. */
  readonly libraryDir: string | null;
  /** Overrides for tests / portable installs. */
  readonly dataDirOverride?: string | null;
  readonly configDirOverride?: string | null;
  readonly cacheDirOverride?: string | null;
  readonly logsDirOverride?: string | null;
}

/**
 * For a host that knows only the roots. See the module docs: every value in
 * `env` must be a *root* that does not already contain {@link APP_DIR_NAME}.
 */
export function resolveAppDirs(platform: PlatformInfo, env: HostEnvironment): AppDirs {
  const j = (...segments: string[]) => joinPath(platform, ...segments);
  const tmp = env.tempDir;

  const pick = (override: string | null | undefined, ...fallback: string[]): string => {
    if (override) return override;
    for (const candidate of fallback) if (candidate) return candidate;
    return ".";
  };

  if (platform.os === "windows") {
    const roaming = env.appData ?? j(env.home ?? ".", "AppData", "Roaming");
    const local = env.localAppData ?? j(env.home ?? ".", "AppData", "Local");
    const dataDir = pick(env.dataDirOverride, j(roaming, APP_DIR_NAME));
    return {
      data: dataDir,
      dataDir,
      config: pick(env.configDirOverride, j(roaming, APP_DIR_NAME)),
      cache: pick(env.cacheDirOverride, j(local, APP_DIR_NAME, "Cache")),
      logs: pick(env.logsDirOverride, j(local, APP_DIR_NAME, "Logs")),
      backups: j(dataDir, "checkpoints"),
      attachments: j(dataDir, "attachments"),
    };
  }

  if (platform.os === "macos") {
    const support = env.libraryDir
      ? j(env.libraryDir, "Application Support")
      : j(env.home ?? ".", "Library", "Application Support");
    const caches = env.libraryDir ? j(env.libraryDir, "Caches") : j(env.home ?? ".", "Library", "Caches");
    const logs = env.libraryDir ? j(env.libraryDir, "Logs") : j(env.home ?? ".", "Library", "Logs");
    const dataDir = pick(env.dataDirOverride, j(support, APP_DIR_NAME));
    return {
      data: dataDir,
      dataDir,
      config: pick(env.configDirOverride, j(support, APP_DIR_NAME)),
      cache: pick(env.cacheDirOverride, j(caches, APP_DIR_NAME)),
      logs: pick(env.logsDirOverride, j(logs, APP_DIR_NAME)),
      backups: j(dataDir, "checkpoints"),
      attachments: j(dataDir, "attachments"),
    };
  }

  // Linux / BSD (XDG Base Directory Specification)
  const xdgData = env.xdgDataHome ?? j(env.home ?? ".", ".local", "share");
  const xdgConfig = env.xdgConfigHome ?? j(env.home ?? ".", ".config");
  const xdgCache = env.xdgCacheHome ?? j(env.home ?? ".", ".cache");
  const xdgState = env.xdgStateHome ?? j(env.home ?? ".", ".local", "state");
  const dataDir = pick(env.dataDirOverride, j(xdgData, APP_DIR_NAME));
  return {
    data: dataDir,
    dataDir,
    config: pick(env.configDirOverride, j(xdgConfig, APP_DIR_NAME)),
    cache: pick(env.cacheDirOverride, j(xdgCache, APP_DIR_NAME)),
    logs: pick(env.logsDirOverride, j(xdgState, APP_DIR_NAME, "logs")),
    backups: j(dataDir, "checkpoints"),
    attachments: j(dataDir, "attachments"),
  };
}

/** The four directories a host must supply itself. All are final, not roots. */
export interface ResolvedDirs {
  /** Holds the SQLite file, checkpoints and attachments. */
  readonly dataDir: string;
  /** Small user-editable config. */
  readonly config: string;
  /** Safe to delete. */
  readonly cache: string;
  /** Never contains secrets. */
  readonly logs: string;
}

/**
 * Build `AppDirs` from directories the OS already resolved for us.
 *
 * Tauri's `app_data_dir()`, `app_config_dir()`, `app_cache_dir()` and
 * `app_log_dir()` all end in the bundle identifier, so they are used verbatim.
 * Throws if any of them repeats {@link APP_DIR_NAME}, which is the mistake this
 * function exists to make loud instead of silent.
 */
export function deriveAppDirs(platform: PlatformInfo, resolved: ResolvedDirs): AppDirs {
  assertSingleAppDir(resolved.dataDir, "dataDir");
  assertSingleAppDir(resolved.config, "config");
  assertSingleAppDir(resolved.cache, "cache");
  assertSingleAppDir(resolved.logs, "logs");

  const j = (...segments: string[]) => joinPath(platform, ...segments);
  return {
    data: resolved.dataDir,
    dataDir: resolved.dataDir,
    config: resolved.config,
    cache: resolved.cache,
    logs: resolved.logs,
    backups: j(resolved.dataDir, "checkpoints"),
    attachments: j(resolved.dataDir, "attachments"),
  };
}

/** How many times a path segment contains `needle`, as whole segments only. */
function appDirCount(path: string): number {
  return path
    .split(/[\\/]/)
    .filter((segment) => segment === APP_DIR_NAME).length;
}

/**
 * Reject a path that repeats the app directory.
 *
 * Whole-segment matching only, so `/home/a/dev.atomic.app.d/` or a file called
 * `dev.atomic.app` alongside a differently-named one is not a false positive.
 */
export function assertSingleAppDir(path: string, label: string): void {
  if (appDirCount(path) > 1) {
    throw new Error(
      `${label} repeats "${APP_DIR_NAME}": ${path}. ` +
        "Pass the OS root to resolveAppDirs, or an already-resolved path to deriveAppDirs — not both.",
    );
  }
}

/** Check a whole `AppDirs`, from whatever produced it. */
export function assertResolvedDirs(dirs: AppDirs): void {
  assertSingleAppDir(dirs.dataDir, "dataDir");
  assertSingleAppDir(dirs.config, "config");
  assertSingleAppDir(dirs.cache, "cache");
  assertSingleAppDir(dirs.logs, "logs");
}

/** Location of the SQLite database. Absolute on every supported host. */
export function databasePath(dirs: AppDirs, platform: PlatformInfo): string {
  return joinPath(platform, dirs.dataDir, DATABASE_FILE);
}

/** Log file path. Must never receive API keys — see `redact`. */
export function logFilePath(dirs: AppDirs, platform: PlatformInfo): string {
  return joinPath(platform, dirs.logs, LOG_FILE);
}
