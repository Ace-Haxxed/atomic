/**
 * Contract tests for the test database itself.
 *
 * Every storage test in this package is only as trustworthy as this double, so
 * it is checked against the behaviours the repositories actually depend on
 * rather than assumed. If one of these fails, the storage tests are not telling
 * the truth and should not be read.
 */

import { describe, expect, it } from "vitest";

import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { migratedTestDatabase, openTestDatabase } from "./sqlite.test-support.js";
import { ConversationRepository, RunRepository } from "./repositories.js";

describe("the test database", () => {
  it("applies every migration and records the version", async () => {
    const db = await migratedTestDatabase();
    const rows = await db.select<{ id: number }>("SELECT id FROM schema_migrations ORDER BY id");
    expect(rows.map((row) => row.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.id);
  });

  it("is idempotent, because a second app start re-runs the migrator", async () => {
    const db = await migratedTestDatabase();
    // Re-running against an already-migrated database must not throw on
    // `ALTER TABLE messages ADD COLUMN` a second time.
    const { runMigrations } = await import("./migrations.js");
    await expect(runMigrations(db)).resolves.toBe(LATEST_SCHEMA_VERSION);
    const rows = await db.select<{ count: number }>("SELECT COUNT(*) AS count FROM schema_migrations");
    expect(rows[0]?.count).toBe(MIGRATIONS.length);
  });

  it("binds parameters in order rather than concatenating them", async () => {
    const db = await migratedTestDatabase();
    // Injection-shaped content has to come back verbatim. If this adapter ever
    // started building SQL by interpolation, this is the test that catches it.
    const conversations = new ConversationRepository(db);
    await conversations.create({ id: "c1", mode: "code" });
    const nasty = "Robert'); DROP TABLE conversations;--";
    await conversations.update("c1", { title: nasty });
    const stored = await conversations.get("c1");
    expect(stored?.title).toBe(nasty);
    expect(await db.select("SELECT id FROM conversations")).toHaveLength(1);
  });

  it("returns rows as objects, since the repositories read them by column name", async () => {
    const db = await migratedTestDatabase();
    // The run table has a foreign key, so the conversation has to exist first.
    await new ConversationRepository(db).create({ id: "c1", mode: "code" });
    const runs = new RunRepository(db);
    await runs.start({ id: "r1", conversationId: "c1", mode: "code" });
    // `AS startedAt` has to survive as a camelCase key, or `list` returns
    // undefined times and every ordering test would silently pass.
    const [row] = await runs.list("c1");
    expect(row?.startedAt).toBeTypeOf("number");
  });

  it("reports how many rows a write changed, which supersedeBefore returns", async () => {
    const db = await migratedTestDatabase();
    await db.execute("CREATE TABLE t (a INTEGER)");
    await db.execute("INSERT INTO t (a) VALUES (1), (2), (3)");
    const result = await db.execute("UPDATE t SET a = 0 WHERE a > 0");
    expect(result.rowsAffected).toBe(3);
  });

  it("rolls back a failed transaction instead of leaving a half-applied one", async () => {
    const db = await migratedTestDatabase();
    await db.execute("CREATE TABLE t (a INTEGER)");
    await expect(
      db.transaction(async () => {
        await db.execute("INSERT INTO t (a) VALUES (1)");
        throw new Error("deliberate");
      }),
    ).rejects.toThrow("deliberate");
    // A migration that failed halfway would otherwise leave a schema that the
    // next start believes is complete.
    expect(await db.select("SELECT a FROM t")).toEqual([]);
  });

  it("commits a transaction that succeeds", async () => {
    const db = await migratedTestDatabase();
    await db.execute("CREATE TABLE t (a INTEGER)");
    await db.transaction(async () => {
      await db.execute("INSERT INTO t (a) VALUES (7)");
    });
    expect(await db.select("SELECT a FROM t")).toEqual([{ a: 7 }]);
  });

  it("enforces the foreign key from messages to conversations", async () => {
    const db = await migratedTestDatabase();
    // The schema declares the constraint; the point is that this adapter really
    // is SQLite and not a permissive stub that lets orphans in.
    await expect(
      db.execute(
        `INSERT INTO messages (id, conversation_id, role, content, created_at, seq)
         VALUES ('m1', 'missing', 'user', '[]', 1, 1)`,
      ),
    ).rejects.toThrow();
  });

  it("supports the ALTER TABLE the display and run_id columns need", async () => {
    const db = await migratedTestDatabase();
    const columns = await db.select<{ name: string }>("PRAGMA table_info(messages)");
    const names = columns.map((column) => column.name);
    // `/diff` reads display and run_id, and compaction reads superseded. If a
    // future migration is written against a renamed column, this fails here
    // rather than in a repository test with a confusing message.
    expect(names).toContain("display");
    expect(names).toContain("run_id");
    expect(names).toContain("superseded");
  });

  it("opens a database with no schema at all when asked to", async () => {
    const db = openTestDatabase();
    await expect(db.select("SELECT * FROM messages")).rejects.toThrow();
  });
});
