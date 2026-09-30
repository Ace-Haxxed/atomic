/**
 * Migration safety.
 *
 * The bug these exist for: `messages.display`, `superseded` and `run_id` were
 * added by editing migration 4 (`todos`) in place. Every database that had
 * already recorded migration 4 skipped it forever, so the columns were never
 * created and the app died on startup with
 * `table messages has no column named display`. The schema itself was fine;
 * the only broken part was the history.
 *
 * So these tests are about *history*: an old database must reach the same schema
 * as a fresh one, rows written before the upgrade must still read, and a
 * migration that has been applied must not be allowed to change afterwards.
 */

import { describe, expect, it } from "vitest";

import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  MigrationError,
  migrationChecksum,
  runMigrations,
  type Migration,
} from "./migrations.js";
import { migratedTestDatabase, openTestDatabase } from "./sqlite.test-support.js";
import { ConversationRepository } from "./repositories.js";
import type { Database } from "./database.js";

/**
 * Build a database that has only the named migrations applied, exactly as an
 * older build would have left it.
 *
 * This deliberately does not run `runMigrations`: the point is to hand the
 * runner a pre-existing history, including a `schema_migrations` row for a
 * migration whose SQL is not what the current code contains.
 */
async function databaseAt(ids: readonly number[]): Promise<Database> {
  const db = openTestDatabase();
  // The pre-checksum shape, so the backfill path is exercised by every case
  // here rather than only by the test that names it.
  await db.execute(
    `CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  );
  for (const id of ids) {
    const migration = MIGRATIONS.find((candidate) => candidate.id === id);
    if (!migration) throw new Error(`no such migration: ${id}`);
    for (const column of migration.addColumns ?? []) {
      await db.execute(`ALTER TABLE ${column.table} ADD COLUMN ${column.column} ${column.definition}`);
    }
    for (const statement of migration.up) await db.execute(statement);
    await db.execute("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", [
      migration.id,
      migration.name,
      Date.now(),
    ]);
  }
  return db;
}

/**
 * The effective schema: every table's columns, and every explicit index.
 *
 * Compared through `PRAGMA` rather than the raw `sqlite_master` text on
 * purpose. `ALTER TABLE ... ADD COLUMN` appends to the live table but never
 * rewrites the stored `CREATE TABLE` statement, so an upgraded database keeps
 * its original text forever. Text comparison would report a difference that
 * does not exist, and would hide one that does.
 */
async function schemaOf(db: Database): Promise<string[]> {
  const tables = await db.select<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const shape: string[] = [];
  for (const table of tables) {
    const columns = await db.select<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>(`PRAGMA table_info(${table.name})`);
    for (const column of columns) {
      shape.push(
        `column ${table.name}.${column.name} ${column.type} ` +
          `notnull=${column.notnull} default=${column.dflt_value ?? "-"} pk=${column.pk}`,
      );
    }
  }
  const indexes = await db.select<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
  );
  for (const index of indexes) {
    shape.push(`index ${index.name} ${(index.sql ?? "").replace(/\s+/g, " ").trim()}`);
  }
  return shape.sort();
}

function columnsOf(db: Database, table: string): Promise<{ name: string }[]> {
  return db.select<{ name: string }>(`PRAGMA table_info(${table})`);
}

describe("an old database is upgraded", () => {
  it("adds display, superseded and run_id to a database that only had initial", async () => {
    // The reported bug, in its simplest form: a machine from before the tool
    // cards existed.
    const db = await databaseAt([1]);
    const before = (await columnsOf(db, "messages")).map((column) => column.name);
    expect(before).not.toContain("display");

    await runMigrations(db);

    const after = (await columnsOf(db, "messages")).map((column) => column.name);
    expect(after).toContain("display");
    expect(after).toContain("superseded");
    expect(after).toContain("run_id");
  });

  it("upgrades a database that already recorded the todos migration", async () => {
    // This is the exact state the reported failure came from: `initial` and
    // `todos` applied, columns never created.
    const db = await databaseAt([1, 4]);
    expect((await columnsOf(db, "messages")).map((c) => c.name)).not.toContain("display");

    await runMigrations(db);

    const names = (await columnsOf(db, "messages")).map((c) => c.name);
    expect(names).toContain("display");
    expect(names).toContain("run_id");
  });

  it("keeps rows written before the upgrade readable", async () => {
    const db = await databaseAt([1, 4]);
    const conversations = new ConversationRepository(db);
    await conversations.create({ id: "c1", mode: "code", title: "Old work" });
    // Written the way the old build wrote it: no display, no run_id, no
    // superseded. The columns do not exist yet, so this cannot go through the
    // current repository, and pretending otherwise would test the wrong thing.
    await db.execute(
      `INSERT INTO messages
         (id, conversation_id, role, content, created_at, seq)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "m1",
        "c1",
        "user",
        JSON.stringify([{ type: "text", text: "from before the upgrade" }]),
        Date.now(),
        1,
      ],
    );

    await runMigrations(db);

    // A migration that rewrote or dropped a column would lose these.
    const stored = await conversations.get("c1");
    expect(stored?.title).toBe("Old work");
    const messages = await conversations.messages("c1");
    expect(messages[0]?.content[0]?.text).toBe("from before the upgrade");
    // New columns read as their defaults rather than as null, so the transcript
    // does not have to special-case rows that predate them.
    expect(messages[0]?.superseded).toBe(false);
    expect(messages[0]?.display).toBeNull();
  });

  it("still lets a new message be written after the upgrade", async () => {
    const db = await databaseAt([1, 4]);
    await runMigrations(db);
    const conversations = new ConversationRepository(db);
    await conversations.create({ id: "c1", mode: "code" });
    await conversations.addMessage({
      id: "m2",
      conversationId: "c1",
      role: "tool",
      toolName: "write_file",
      runId: "r1",
      display: { kind: "file-write", path: "a.ts" },
    });

    // The write and the read that `/diff` depends on.
    const changes = await conversations.changesInRun("c1", "r1");
    expect(changes).toHaveLength(1);
    expect((changes[0]?.display as { path: string }).path).toBe("a.ts");
  });

  it("is safe to run twice, which is what every app start does", async () => {
    const db = await databaseAt([1, 4]);
    await runMigrations(db);
    const after = await schemaOf(db);
    await runMigrations(db);
    expect(await schemaOf(db)).toEqual(after);
  });
});

describe("fresh and upgraded databases agree", () => {
  it("reaches the same schema from every starting point", async () => {
    // If these ever diverge, a bug will only appear for users who have been
    // running the app for a while, which is the hardest version to report.
    const fresh = await migratedTestDatabase();
    const fromInitial = await databaseAt([1]);
    const fromTodos = await databaseAt([1, 4]);

    await runMigrations(fromInitial);
    await runMigrations(fromTodos);

    const expected = await schemaOf(fresh);
    expect(await schemaOf(fromInitial)).toEqual(expected);
    expect(await schemaOf(fromTodos)).toEqual(expected);
  });

  it("reports the latest version for a brand new database", async () => {
    const db = openTestDatabase();
    expect(await runMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  });

  it("records a checksum for every migration it applies", async () => {
    const db = openTestDatabase();
    await runMigrations(db);
    const rows = await db.select<{ id: number; checksum: string | null }>(
      "SELECT id, checksum FROM schema_migrations",
    );
    // A NULL here means the immutability check silently does nothing on the
    // next start, which is the failure this whole mechanism exists to prevent.
    expect(rows.every((row) => typeof row.checksum === "string" && row.checksum.length > 0)).toBe(true);
  });
});

describe("an applied migration may not change", () => {
  it("refuses to start when an applied migration's SQL differs", async () => {
    // Simulated by rewriting the recorded checksum, which is exactly the state
    // an edited migration leaves behind: the database says "applied", the code
    // says something else.
    const db = await databaseAt([1, 4]);
    await runMigrations(db);
    await db.execute("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE id = 4");

    const error = await runMigrations(db).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).migrationId).toBe(4);
    // The message has to name the migration, or the user cannot act on it.
    expect((error as Error).message).toContain("todos");
    expect((error as Error).message).toContain("already applied");
  });

  it("says which migration and does not modify the database", async () => {
    const db = await databaseAt([1, 4]);
    await runMigrations(db);
    await db.execute("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE id = 4");
    const before = await schemaOf(db);

    await runMigrations(db).catch(() => undefined);

    // A repair attempt that "helpfully" rewrites the user's database is worse
    // than refusing to start.
    expect(await schemaOf(db)).toEqual(before);
  });

  it("backfills a checksum for a row that predates checksumming", async () => {
    // Every install that started before this change has a `schema_migrations`
    // table with no checksum column at all, and `databaseAt` builds exactly
    // that. Treating the missing checksums as a mismatch would lock every
    // existing user out of the app on the next start.
    const db = await databaseAt([1, 4]);

    await expect(runMigrations(db)).resolves.toBe(LATEST_SCHEMA_VERSION);
    const rows = await db.select<{ id: number; checksum: string | null }>(
      "SELECT id, checksum FROM schema_migrations",
    );
    expect(rows.every((row) => typeof row.checksum === "string")).toBe(true);
    expect(rows.find((row) => row.id === 4)?.checksum).toBe(migrationChecksum(MIGRATIONS[1]!));
  });

  it("changes when a migration's SQL changes", async () => {
    const original = MIGRATIONS[1]!;
    const edited: Migration = { ...original, up: ["CREATE TABLE todos (a TEXT)"] };
    expect(migrationChecksum(edited)).not.toBe(migrationChecksum(original));
  });

  it("changes when a migration is renamed", async () => {
    const original = MIGRATIONS[1]!;
    expect(migrationChecksum({ ...original, name: "todo" })).not.toBe(
      migrationChecksum(original),
    );
  });
});

/**
 * The immutability lock.
 *
 * A checksum table in a test cannot detect a change to the very migrations it
 * hashes, because the table would change with them. These expected values were
 * taken from the code as it shipped, so editing `initial` or `todos` to fix
 * some future problem fails here instead of failing on a user's machine.
 */
describe("shipped migrations are immutable", () => {
  const SHIPPED: Readonly<Record<number, string>> = {
    1: "a5750348",
    4: "1072dda5",
  };

  for (const [id, checksum] of Object.entries(SHIPPED)) {
    it(`migration ${id} still has the SQL it shipped with`, () => {
      const migration = MIGRATIONS.find((candidate) => candidate.id === Number(id));
      expect(migration).toBeDefined();
      expect(migrationChecksum(migration!)).toBe(checksum);
    });
  }

  it("migration 4 creates only the todos table, so it is not the place for new columns", () => {
    // The exact mistake: appending to a migration that had already shipped.
    const todos = MIGRATIONS.find((migration) => migration.id === 4)!;
    expect(todos.up.filter((statement) => /ALTER TABLE/i.test(statement))).toEqual([]);
  });

  it("only ever appends new ids", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the ensure step is additive", () => {
  it("does not fail when the columns are already present", async () => {
    // A machine that ran a build with these columns inside migration 4, or one
    // where they were added by hand. Plain ALTER TABLE would refuse to start.
    const db = await databaseAt([1, 4]);
    await db.execute("ALTER TABLE messages ADD COLUMN display TEXT");
    await db.execute("ALTER TABLE messages ADD COLUMN run_id TEXT");

    await expect(runMigrations(db)).resolves.toBe(LATEST_SCHEMA_VERSION);
  });
});
