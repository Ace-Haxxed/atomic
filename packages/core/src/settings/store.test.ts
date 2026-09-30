/**
 * The settings store's one job that is easy to get wrong: a change is either
 * written down or it did not happen.
 */

import { describe, expect, it } from "vitest";

import { SettingsStore } from "./store.js";
import { AUTO_MODEL } from "../models/auto-model.js";
import type { Database } from "../storage/database.js";

/** A database that records writes, and can be told to start failing. */
function fakeDb(input: { readonly failWrites?: boolean } = {}) {
  const rows = new Map<string, { value: string; updated_at: number }>();
  let failWrites = input.failWrites ?? false;
  const db = {
    async select(_sql: string, params: readonly unknown[] = []) {
      const row = rows.get(String(params[0]));
      return row ? [{ value: row.value }] : [];
    },
    async execute(_sql: string, params: readonly unknown[] = []) {
      if (failWrites) throw new Error("disk is full");
      // `execute` is called as (key, json, updatedAt) for the settings upsert.
      rows.set(String(params[0]), {
        value: String(params[1]),
        updated_at: Number(params[2]),
      });
      return { rows: [], rowsAffected: 1 };
    },
  } as unknown as Database;
  return {
    db,
    stored: () => {
      const row = rows.get("app.settings");
      return row ? (JSON.parse(row.value) as { models?: Record<string, string> }) : null;
    },
    breakWrites() {
      failWrites = true;
    },
    fixWrites() {
      failWrites = false;
    },
  };
}

describe("SettingsStore persistence", () => {
  it("writes a mode's model and its provider", async () => {
    const { db, stored } = fakeDb();
    const store = await SettingsStore.load(db);

    await store.setModelForMode("code", "qwen3-coder", "ollama");

    expect(stored()?.models?.code).toBe("qwen3-coder");
  });

  it("keeps the mode's choice across a relaunch", async () => {
    const { db, stored } = fakeDb();
    const first = await SettingsStore.load(db);
    await first.setModelForMode("code", "qwen3-coder", "ollama");
    await first.setModelForMode("chat", "kimi-k2", "opencode-zen");

    // A relaunch reads the row back, so this is the assertion that matters: the
    // picker's choice has to survive, not just be in memory when it was made.
    const second = await SettingsStore.load(db);
    expect(second.get().models.code).toBe("qwen3-coder");
    expect(second.get().models.chat).toBe("kimi-k2");
    expect(stored()?.models?.code).toBe("qwen3-coder");
  });

  it("remembers Auto as Auto", async () => {
    const { db } = fakeDb();
    const store = await SettingsStore.load(db);
    await store.setModelForMode("chat", AUTO_MODEL, "opencode-zen");
    const relaunched = await SettingsStore.load(db);
    expect(relaunched.get().models.chat).toBe(AUTO_MODEL);
  });

  /**
   * The bug this replaces. `#current` was assigned before the write, so a failed
   * write left the app reporting a setting that existed nowhere: the picker
   * showed it, the next message used it, and relaunching discarded it.
   */
  it("does not report a change it could not write", async () => {
    const writes = fakeDb();
    const store = await SettingsStore.load(writes.db);
    writes.breakWrites();

    await expect(
      store.setModelForMode("code", "qwen3-coder", "ollama"),
    ).rejects.toThrow("disk is full");

    expect(store.get().models.code).not.toBe("qwen3-coder");
  });

  it("rolls back to the value that was actually stored", async () => {
    const writes = fakeDb();
    const store = await SettingsStore.load(writes.db);
    await store.setModelForMode("chat", "kimi-k2", "opencode-zen");
    writes.breakWrites();
    await expect(
      store.setModelForMode("chat", "gpt-5.6", "opencode-zen"),
    ).rejects.toThrow();
    writes.fixWrites();

    // The failed write must not have corrupted the good one.
    expect(store.get().models.chat).toBe("kimi-k2");
    expect((await SettingsStore.load(writes.db)).get().models.chat).toBe("kimi-k2");
  });

  it("does not notify listeners about a change that failed", async () => {
    const writes = fakeDb();
    const store = await SettingsStore.load(writes.db);
    const seen: string[] = [];
    store.subscribe((next) => seen.push(String(next.models.code)));

    writes.breakWrites();
    await expect(
      store.setModelForMode("code", "qwen3-coder", "ollama"),
    ).rejects.toThrow();
    // A listener that re-rendered from this would have shown the user a model
    // the host is not using.
    expect(seen).toEqual([]);
  });
});
