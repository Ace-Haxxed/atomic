/**
 * The Tauri side of Atomic.
 *
 * `@atomic/core` is host-agnostic: it declares `SecretStore` and `Database` as
 * interfaces and never imports an OS API. This module is the only place where
 * those interfaces meet a real implementation, so every capability the app
 * depends on is visible in one file.
 *
 * Nothing here may throw during module load: a crash in this file means a
 * blank window with no error, which is the worst failure mode a desktop app has.
 */

import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { platform as tauriPlatform, arch as tauriArch, version as osVersion } from "@tauri-apps/plugin-os";
import { getVersion } from "@tauri-apps/api/app";
import { appCacheDir, appConfigDir, appLogDir, join } from "@tauri-apps/api/path";

import type { Database as DatabasePort } from "@atomic/core";
import {
  APP_ID,
  describePlatform,
  type PlatformInfo,
  type ResolvedDirs,
} from "@atomic/core";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Invokes a Rust command. Every capability lives behind one of these. */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

/**
 * The final application data directory, created by Rust if missing.
 *
 * Always ends in the bundle identifier. Use it verbatim — see `appDirs`.
 */
const dataDirCommand = (): Promise<string> => call<string>("data_dir");

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

let cachedPlatform: PlatformInfo | null = null;

export async function platformInfo(): Promise<PlatformInfo> {
  if (cachedPlatform) return cachedPlatform;
  let rawOs = "unknown";
  let rawArch = "unknown";
  let description = "Unknown";
  try {
    const [os, arch, version] = await Promise.all([
      tauriPlatform(),
      tauriArch(),
      osVersion(),
    ]);
    rawOs = os;
    rawArch = arch;
    description = version;
  } catch {
    // Outside a Tauri window (vitest, browser dev) fall back to the UA strings.
    rawOs = typeof navigator === "undefined" ? "unknown" : navigator.userAgent;
    rawArch = typeof navigator === "undefined" ? "unknown" : navigator.hardwareConcurrency.toString();
  }
  cachedPlatform = describePlatform(rawOs, rawArch, description);
  return cachedPlatform;
}

/**
 * The final application directories, straight from the OS.
 *
 * The Rust `data_dir` command returns `app_data_dir()` and creates it, because
 * SQLite will not create a missing parent and fails with an opaque
 * `SQLITE_CANTOPEN` instead. The rest come from Tauri's path API, which also
 * returns app-specific paths.
 *
 * All four are used verbatim. This function deliberately does not produce a
 * `HostEnvironment` for `resolveAppDirs`: that helper appends `APP_DIR_NAME`
 * itself, so feeding it a path that already ends in the bundle identifier
 * produced `.../dev.atomic.app/dev.atomic.app` and the app would not start.
 */
export async function appDirs(): Promise<ResolvedDirs> {
  const [dataDir, config, cache, logs] = await Promise.all([
    dataDirCommand(),
    safe(appConfigDir),
    safe(appCacheDir),
    safe(appLogDir),
  ]);
  // Falling back to the data directory keeps the app usable on a platform where
  // the OS withholds one of these, rather than failing on a missing path.
  return {
    dataDir,
    config: config ?? dataDir,
    cache: cache ?? dataDir,
    logs: logs ?? dataDir,
  };
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Absolute on POSIX (`/…`) and Windows (`C:\…` or `\\server\share`). */
function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/]{1,2})/.test(path);
}

/**
 * Which provider keys exist in the environment, as booleans.
 *
 * Presence only. This used to return a `Record<string, string>` of every
 * provider key's *value* into the webview at startup, which meant any renderer
 * bug, any error-logging stack, and any future devtools session held eleven live
 * credentials at once -- contradicting the rule in `secrets.rs` that a key never
 * crosses into the webview except to become an `Authorization` header.
 *
 * `envProviderKey` below is the replacement for the one case that genuinely
 * needs a value: building a single provider, at the moment it is needed.
 */
export const envProviderKeyPresence = (): Promise<Record<string, boolean>> =>
  call<Record<string, boolean>>("env_provider_key_presence");

/**
 * One provider key, fetched on demand.
 *
 * Rust refuses any name outside its own allowlist, so this cannot be used to
 * read an arbitrary variable even though `apiKeyEnvVar` is user-editable.
 */
export const envProviderKey = async (name: string): Promise<string | null> =>
  (await call<string | null>("env_provider_key_read", { name })) ?? null;

/** Wrap pasted clipboard bytes for the Rust attachment reader. */
export const attachments = {
  fromBase64: (name: string, data: string): Promise<unknown[]> =>
    call<unknown[]>("attach_from_base64", { name, data }),
};

/**
 * Read an image off the system clipboard.
 *
 * The webview owns this rather than Rust: the async Clipboard API already runs in
 * a permission-gated user-gesture context, and it returns the same bytes a paste
 * would. Returns null when there is no image, or when the platform refuses —
 * a missing clipboard image is normal, not an error.
 */
export async function readClipboardImage(): Promise<{ name: string; base64: string } | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.read) return null;
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (!type.startsWith("image/")) continue;
        const blob = await item.getType(type);
        if (blob.size > 20 * 1024 * 1024) continue;
        return { name: `pasted.${extensionFor(type)}`, base64: await blobToBase64(blob) };
      }
    }
    return null;
  } catch {
    // Denied permission or no clipboard: the user simply pastes a file instead.
    return null;
  }
}

function extensionFor(mimeType: string): string {
  return mimeType.split("/")[1]?.replace("+xml", "").replace("jpeg", "jpg") ?? "png";
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  // Chunked so a large image does not blow the argument limit on `String.fromCharCode`.
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < buffer.length; offset += step) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + step));
  }
  return btoa(binary);
}

export async function appVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// Secrets -> OS keychain
// ---------------------------------------------------------------------------

/**
 * The keychain is reached through a Rust command rather than a JS plugin so the
 * value never crosses into the webview as a string it could log or leak.
 * `set` returns void; reads are explicit and always masked by the UI.
 */
export const keychain = {
  async set(key: string, value: string): Promise<void> {
    await call("secret_set", { key, value });
  },
  async get(key: string): Promise<string | null> {
    return call<string | null>("secret_get", { key });
  },
  async delete(key: string): Promise<void> {
    await call("secret_delete", { key });
  },
  async has(key: string): Promise<boolean> {
    return call<boolean>("secret_has", { key });
  },
};

// ---------------------------------------------------------------------------
// Database -> SQLite
// ---------------------------------------------------------------------------

let dbPromise: Promise<DatabasePort> | null = null;

/** The `Database` port implemented over `tauri-plugin-sql`. */
export async function database(file: string): Promise<DatabasePort> {
  if (!dbPromise) {
    dbPromise = openDatabase(file);
  }
  return dbPromise;
}

/**
 * Forget the cached connection.
 *
 * A failed open is cached as a rejected promise, so without this a retry — or
 * the in-memory fallback — would hand back the same failure forever. That made
 * the degraded path unreachable exactly when it was needed.
 */
export function resetDatabase(): void {
  dbPromise = null;
}

/**
 * A private in-memory database.
 *
 * Used when the on-disk file cannot be opened so the user can still finish
 * onboarding. `sqlite::memory:` is a connection string, not a path, so it
 * deliberately bypasses the absolute-path check in `openDatabase`.
 */
export async function memoryDatabase(): Promise<DatabasePort> {
  resetDatabase();
  const db = await Database.load("sqlite::memory:");
  if (import.meta.env.DEV) {
    console.info("[atomic] sqlite database: in-memory (degraded)");
  }
  return wrapDatabase(db);
}

/**
 * Open the SQLite file.
 *
 * The path must be absolute. `tauri-plugin-sql` resolves a relative path against
 * the process working directory — the `src-tauri` folder in a dev run — so a
 * relative path both creates a stray database and fails to find the real one.
 * This check is here because the failure it prevents is silent: the app starts
 * with an empty database and the user's conversations are simply gone.
 */
async function openDatabase(file: string): Promise<DatabasePort> {
  if (!isAbsolute(file)) {
    throw new Error(
      `database path must be absolute, got ${JSON.stringify(file)}. ` +
        "Use appDirs().dataDir from the OS rather than a relative path.",
    );
  }
  if (import.meta.env.DEV) {
    // Path only. Never the connection string's credentials, never a key.
    console.info(`[atomic] sqlite database: ${file}`);
  }
  // `sqlite:` tells sqlx this is a file, and the payload after `//` is a path.
  return wrapDatabase(await Database.load(`sqlite://${file}`));
}

/** The one place the plugin's driver is adapted to the `Database` port. */
function wrapDatabase(db: Database): DatabasePort {
  return {
    async execute(sql: string, params: readonly unknown[] = []) {
      const result = await db.execute(sql, params as never[]);
      return { rows: [], rowsAffected: result.rowsAffected ?? 0 };
    },
    async select<Row>(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
      return (await db.select<Row[]>(sql, params as never[])) ?? [];
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      // One connection, so an explicit transaction cannot interleave with a
      // concurrent statement. Everything in core that uses this is sequential.
      await db.execute("BEGIN");
      try {
        const result = await fn();
        await db.execute("COMMIT");
        return result;
      } catch (error) {
        await db.execute("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
    async close(): Promise<void> {
      await db.close();
      resetDatabase();
    },
  };
}

// ---------------------------------------------------------------------------
// Settings file
// ---------------------------------------------------------------------------

/** Settings live in a JSON file the Rust side reads and writes atomically. */
export const settingsFile = {
  read: (): Promise<string | null> => call<string | null>("settings_read"),
  write: (json: string): Promise<void> => call("settings_write", { json }),
};

export const auditLog = {
  append: (line: string): Promise<void> => call("audit_append", { line }),
};

// ---------------------------------------------------------------------------
// Window, tray and shortcuts
// ---------------------------------------------------------------------------

/**
 * Mirror a diagnostic into the terminal where the webview's console cannot
 * reach. No-op outside Tauri. Callers must never pass a key or a token.
 */
export const window = {
  show: (): Promise<void> => call("window_show"),
  hide: (): Promise<void> => call("window_hide"),
  minimizeToTray: (): Promise<void> => call("window_minimize_to_tray"),
  setCloseToTray: (enabled: boolean): Promise<void> =>
    call("window_set_close_to_tray", { enabled }),
  isVisible: (): Promise<boolean> => call<boolean>("window_is_visible"),
};

export const shortcuts = {
  register: (accelerator: string): Promise<boolean> =>
    call<boolean>("shortcut_register", { accelerator }),
  unregisterAll: (): Promise<void> => call("shortcut_unregister_all"),
};

export const app = {
  relaunch: (): Promise<void> => call("app_relaunch"),
  openSettings: (): Promise<void> => call("window_show"),
};

/** Join a path using the OS separator. Never string-concatenate separators. */
export async function joinPath(...segments: string[]): Promise<string> {
  return join(...segments);
}

export { APP_ID };
