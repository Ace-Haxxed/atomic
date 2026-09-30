/**
 * Settings store.
 *
 * Persists to the `settings` key/value table as a single JSON document so that
 * adding a field is a pure schema change, and re-validates on every read so a
 * corrupt or hand-edited row can never crash the app.
 */

import { z } from "zod";
import type { Database } from "../storage/database.js";
import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  withModelForMode,
  type Mode,
  type Settings,
} from "./schema.js";

const SETTINGS_KEY = "app.settings";

export type SettingsListener = (settings: Settings, previous: Settings) => void;

export class SettingsStore {
  #db: Database;
  #current: Settings;
  #listeners = new Set<SettingsListener>();

  constructor(db: Database, initial?: Partial<Settings>) {
    this.#db = db;
    this.#current = SettingsSchema.parse(initial ?? {});
  }

  static async load(db: Database): Promise<SettingsStore> {
    const rows = await db.select<{ value: string }>(
      "SELECT value FROM settings WHERE key = ?",
      [SETTINGS_KEY],
    );
    const row = rows[0];
    if (!row) return new SettingsStore(db);
    try {
      const parsed = SettingsSchema.partial().parse(JSON.parse(row.value));
      return new SettingsStore(db, parsed);
    } catch {
      // A settings blob we cannot understand is not worth crashing over.
      return new SettingsStore(db);
    }
  }

  get(): Readonly<Settings> {
    return this.#current;
  }

  /** Replace the whole document. Unknown/invalid fields are dropped. */
  async replace(next: unknown): Promise<Settings> {
    return this.#patch((current) => {
      const merged = mergeDeep(current, next);
      return SettingsSchema.parse(merged);
    });
  }

  /** Shallow-merge a partial document, then validate. */
  async patch(partial: DeepPartial<Settings>): Promise<Settings> {
    return this.#patch((current) => SettingsSchema.parse(mergeDeep(current, partial)));
  }

  /** Set one value inside a permission block for one mode. */
  async setPermission(
    mode: Mode,
    partial: DeepPartial<Settings["permissions"][Mode]>,
  ): Promise<Settings> {
    return this.#patch((current) =>
      SettingsSchema.parse({
        ...current,
        permissions: {
          ...current.permissions,
          [mode]: { ...current.permissions[mode], ...(partial as object) },
        },
      }),
    );
  }

  async setGeneration(partial: DeepPartial<Settings["generation"]>): Promise<Settings> {
    return this.#patch((current) =>
      SettingsSchema.parse({ ...current, generation: { ...current.generation, ...(partial as object) } }),
    );
  }

  async setProvider(
    providerId: string,
    partial: DeepPartial<Settings["providers"][string]>,
  ): Promise<Settings> {
    return this.#patch((current) =>
      SettingsSchema.parse({
        ...current,
        providers: {
          ...current.providers,
          [providerId]: { ...(current.providers[providerId] ?? {}), ...(partial as object) },
        },
      }),
    );
  }

  /**
   * Record a mode's model and the provider serving it.
   *
   * One call for both, deliberately: a model stored without its provider is
   * routed by the top-level `providerId`, which is usually wrong.
   */
  async setModelForMode(mode: Mode, model: string, providerId: string): Promise<Settings> {
    return this.#patch((current) => withModelForMode(current, mode, model, providerId));
  }

  /** @deprecated Retained for callers that only change the model id. */
  async setModelId(mode: Mode, model: string): Promise<Settings> {
    return this.#patch((current) =>
      SettingsSchema.parse({ ...current, models: { ...current.models, [mode]: model } }),
    );
  }

  /**
   * Apply a change, and only keep it if it was written down.
   *
   * The in-memory value is rolled back when the write fails. It used to be
   * assigned first and persisted second, so a failed write left the app
   * confidently reporting a setting that had not been stored anywhere: the
   * picker showed the model the user had just chosen, the next message went to
   * it, and on relaunch the choice was simply gone. Failing the write is
   * visible; silently holding state nobody persisted is not.
   */
  async #patch(produce: (current: Settings) => Settings): Promise<Settings> {
    const previous = this.#current;
    const next = produce(previous);
    this.#current = next;
    if (previous === next) return next;
    try {
      await this.#persist(next);
    } catch (error) {
      this.#current = previous;
      throw error;
    }
    for (const listener of this.#listeners) {
      try {
        listener(next, previous);
      } catch (error) {
        console.error("[settings] listener failed", error);
      }
    }
    return next;
  }

  async #persist(settings: Settings): Promise<void> {
    await this.#db.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [SETTINGS_KEY, JSON.stringify(settings), Date.now()],
    );
  }

  subscribe(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function mergeDeep(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (patch === null) return null;
  if (Array.isArray(patch)) return patch;
  if (typeof patch !== "object") return patch;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key] = mergeDeep(out[key], value);
  }
  return out;
}

/** One-shot validation helper used by the settings UI before writing. */
export function validateSettings(candidate: unknown): z.ZodSafeParseResult<Settings> {
  return SettingsSchema.safeParse(candidate);
}

export { DEFAULT_SETTINGS };
