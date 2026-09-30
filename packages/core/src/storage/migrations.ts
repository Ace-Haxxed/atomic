/**
 * Schema migrations.
 *
 * Each entry runs once, inside a transaction, in array order.
 *
 * **Applied migrations are immutable.** Once an entry has run on a user's
 * machine it must never change: not its SQL, not its name, not its position.
 * The runner records a checksum of every migration it applies and refuses to
 * start when one of them no longer matches, because the alternative is silent,
 * much worse corruption -- a database that records a migration as applied
 * while the machine is running different SQL never applies the difference, and
 * the failure shows up later as a missing column rather than as a migration
 * error.
 *
 * To change the schema, append a new migration. Never edit an existing one, and
 * never renumber. That rule exists because editing migration 4 in place to add
 * `messages.display` left every database that had already recorded migration 4
 * without the column: the runner skipped it as done, and the app then failed on
 * startup with `table messages has no column named display`.
 */

import type { Database } from "./database.js";

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly up: readonly string[];
  /**
   * Columns this migration adds, applied before `up` and only when missing.
   *
   * They are declared here rather than written as `ALTER TABLE` statements in
   * `up` because SQLite has no `ADD COLUMN IF NOT EXISTS`: a statement form
   * fails outright on a database that already has the column, and this app has
   * to start on machines where a column may have arrived by an earlier build or
   * by hand. Keeping them declarative also means every statement in `up` is
   * plain checksummed SQL, so the immutability check covers the whole schema
   * change and not just the idempotent part.
   *
   * Additive by construction, so this cannot make an already-migrated database
   * inconsistent. Its behaviour is covered by tests.
   */
  readonly addColumns?: readonly { table: string; column: string; definition: string }[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "initial",
    up: [
      `CREATE TABLE IF NOT EXISTS conversations (
         id            TEXT PRIMARY KEY,
         mode          TEXT NOT NULL,
         title         TEXT,
         model         TEXT,
         provider_id   TEXT,
         workspace     TEXT,
         system_prompt TEXT,
         pinned        INTEGER NOT NULL DEFAULT 0,
         archived      INTEGER NOT NULL DEFAULT 0,
         created_at    INTEGER NOT NULL,
         updated_at    INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_mode ON conversations (mode, updated_at DESC)`,

      `CREATE TABLE IF NOT EXISTS messages (
         id              TEXT PRIMARY KEY,
         conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
         parent_id       TEXT REFERENCES messages (id) ON DELETE SET NULL,
         role            TEXT NOT NULL,
         content         TEXT NOT NULL,
         reasoning       TEXT,
         model           TEXT,
         provider_id     TEXT,
         tool_calls      TEXT,
         tool_call_id    TEXT,
         tool_name       TEXT,
         attachments     TEXT,
         usage           TEXT,
         finish_reason   TEXT,
         error           TEXT,
         created_at      INTEGER NOT NULL,
         seq             INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, seq)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages (parent_id)`,

      `CREATE TABLE IF NOT EXISTS settings (
         key        TEXT PRIMARY KEY,
         value      TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,

      /* Append-only record of every tool action and permission decision. */
      `CREATE TABLE IF NOT EXISTS audit_log (
         id              INTEGER PRIMARY KEY AUTOINCREMENT,
         ts              INTEGER NOT NULL,
         conversation_id TEXT,
         message_id      TEXT,
         run_id          TEXT,
         kind            TEXT NOT NULL,
         tool            TEXT,
         mode            TEXT,
         decision        TEXT,
         summary         TEXT,
         detail          TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_conv ON audit_log (conversation_id, ts DESC)`,

      /* Cached provider catalog so the model picker works offline. */
      `CREATE TABLE IF NOT EXISTS model_cache (
         provider_id TEXT PRIMARY KEY,
         payload     TEXT NOT NULL,
         fetched_at  INTEGER NOT NULL
       )`,

      /* Task history for Cowork and Code runs. */
      `CREATE TABLE IF NOT EXISTS runs (
         id              TEXT PRIMARY KEY,
         conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
         mode            TEXT NOT NULL,
         status          TEXT NOT NULL,
         task            TEXT,
         workspace       TEXT,
         steps           INTEGER NOT NULL DEFAULT 0,
         started_at      INTEGER NOT NULL,
         finished_at     INTEGER,
         error           TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_runs_conv ON runs (conversation_id, started_at DESC)`,
    ],
  },
  {
    id: 4,
    name: "todos",
    up: [
      /*
        The plan lives outside the message stream on purpose. Compaction drops
        old messages, and a task list that vanished mid-run is worse than
        useless -- the user loses the only record of what the agent intended.
        One row per conversation: the whole list is replaced on each write, which
        is what `todo_write` sends anyway.
      */
      `CREATE TABLE IF NOT EXISTS todos (
         conversation_id TEXT PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
         payload         TEXT NOT NULL,
         updated_at      INTEGER NOT NULL
       )`,
    ],
  },
  {
    id: 5,
    name: "tool-display",
    up: [
      /*
        The structured payload a tool produced -- a diff, terminal output, the
        plan. Persisted so a card the user approved is still there after a
        reload; a diff that only ever lived in a live event is a diff the user
        cannot go back and check.
      */
      /*
        Manual compaction marks old turns superseded rather than deleting them.
        The model stops seeing them; the user can still scroll back, and an
        accidental compaction is undone by clearing one flag. Deleting the rows
        would have made /compact irreversible for no benefit.
      */
      /*
        Which run produced each message. Without this a diff cannot be
        attributed to the run that made it, so `/diff` would have to guess
        between the last few tool calls and risk showing changes the user did
        not ask about.
      */
      `CREATE INDEX IF NOT EXISTS idx_messages_run ON messages (conversation_id, run_id)`,
    ],
    /*
      The columns are nullable, or default to false, so adding them to a
      populated table rewrites no existing rows.
    */
    addColumns: [
      { table: "messages", column: "display", definition: "TEXT" },
      { table: "messages", column: "superseded", definition: "INTEGER NOT NULL DEFAULT 0" },
      { table: "messages", column: "run_id", definition: "TEXT" },
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.id ?? 0;

/** Thrown when the applied history cannot be trusted. Never swallowed. */
export class MigrationError extends Error {
  readonly migrationId: number;
  readonly migrationName: string;

  constructor(id: number, name: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
    this.migrationId = id;
    this.migrationName = name;
  }
}

/**
 * A fingerprint of a migration's SQL.
 *
 * FNV-1a, not a cryptographic hash: this is change detection, not security, and
 * it has to produce the same value on every host the app runs on, which rules
 * out pulling in a crypto implementation. Collisions are irrelevant here -- a
 * collision would mean a migration's SQL changed and the checksum failed to
 * notice, and the next difference would be caught.
 */
export function migrationChecksum(migration: Migration): string {
  const text = `${migration.id} ${migration.name} ${migration.up.join(" ")}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // 16777619, written out because the multiply has to stay in 32 bits.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** `PRAGMA table_info` does not take bound parameters, hence the interpolation. */
async function columnExists(db: Database, table: string, column: string): Promise<boolean> {
  const rows = await db.select<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((row) => row.name === column);
}

async function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  if (await columnExists(db, table, column)) return;
  // Identifiers come from the migration source, never from user input.
  await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

interface AppliedRow {
  readonly id: number;
  readonly name: string;
  readonly checksum: string | null;
}

/**
 * Bring `db` up to the latest schema.
 *
 * Returns the resulting version. Throws {@link MigrationError} if an already
 * applied migration no longer matches the code, and never modifies or replaces
 * the database to recover from that: a user's history is worth more than a
 * clean start, and a wrong guess here would destroy it silently.
 */
export async function runMigrations(db: Database): Promise<number> {
  await ensureMigrationTable(db);

  const applied = await db.select<AppliedRow>(
    "SELECT id, name, checksum FROM schema_migrations ORDER BY id",
  );
  const byId = new Map(applied.map((row) => [row.id, row]));

  let current = 0;
  for (const migration of MIGRATIONS) {
    const checksum = migrationChecksum(migration);
    const record = byId.get(migration.id);

    if (record !== undefined) {
      // A checksum of NULL means the row predates checksumming, so there is
      // nothing to compare against. It is backfilled below rather than treated
      // as a mismatch: refusing to start would lock out every existing install
      // over a bookkeeping column.
      if (record.checksum !== null && record.checksum !== checksum) {
        throw new MigrationError(
          migration.id,
          migration.name,
          `Migration ${migration.id} ("${migration.name}") was already applied to this ` +
            `database, but its SQL has since changed.\n\n` +
            `This is the one schema mistake that cannot be repaired automatically: the ` +
            `database recorded this migration as applied, so the change below was never ` +
            `run on it, and guessing would risk your conversations.\n\n` +
            `Your data has not been modified. Fix it by adding a new migration for the ` +
            `change instead of editing migration ${migration.id}, and see ` +
            `docs/schema-migrations.md for how to recover a database in this state.`,
        );
      }
      if (record.checksum === null) {
        await db.execute("UPDATE schema_migrations SET checksum = ? WHERE id = ?", [
          checksum,
          migration.id,
        ]);
      }
      current = Math.max(current, migration.id);
      continue;
    }

    await db.transaction(async () => {
      // Columns first: a later statement in `up` may index one of them.
      for (const column of migration.addColumns ?? []) {
        await addColumnIfMissing(db, column.table, column.column, column.definition);
      }
      for (const statement of migration.up) await db.execute(statement);
      await db.execute(
        "INSERT INTO schema_migrations (id, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
        [migration.id, migration.name, Date.now(), checksum],
      );
    });
    current = Math.max(current, migration.id);
  }

  return current;
}

async function ensureMigrationTable(db: Database): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id         INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at INTEGER NOT NULL,
       checksum   TEXT
     )`,
  );
  // The table predates the checksum column, so an existing database has it
  // without one.
  if (!(await columnExists(db, "schema_migrations", "checksum"))) {
    await db.execute("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
  }
}
