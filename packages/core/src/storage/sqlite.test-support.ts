/**
 * A real SQLite database behind the `Database` port, for tests.
 *
 * Why not a hand-written fake: the queries under test are the interesting part
 * -- `ORDER BY seq`, `tool_name IN (...)`, `LIMIT`, `ALTER TABLE` migrations --
 * and a fake that records calls proves nothing about whether the SQL is right. A
 * fake that emulates SQL is a worse, buggier version of SQLite. So this runs the
 * actual statements against the actual engine, and the only thing faked is the
 * driver.
 *
 * `better-sqlite3` is a devDependency of this package, so it never reaches the
 * shipped `dist`: this file is excluded from the build in `tsconfig.json`, and
 * the only importer is a `*.test.ts` file.
 *
 * Semantics deliberately match the production adapter in
 * `apps/desktop/src/lib/host.ts` (the Tauri SQL plugin), because a test double
 * that is more forgiving than the real thing tests the wrong behaviour.
 */

import Database from "better-sqlite3";

import { runMigrations } from "./migrations.js";
import type { Database as DatabasePort, SqlValue } from "./database.js";

/**
 * `better-sqlite3` is synchronous. The port is async, so the work is wrapped in
 * `queueMicrotask` rather than returned inline: an async port that resolves
 * synchronously lets a caller accidentally depend on ordering that the real
 * driver -- which goes through IPC -- does not guarantee.
 */
function later<T>(produce: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queueMicrotask(() => {
      try {
        resolve(produce());
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function openTestDatabase(): DatabasePort {
  const sqlite = new Database(":memory:");
  // WAL is meaningless for an in-memory database and, worse, silently ignored.
  sqlite.pragma("foreign_keys = ON");

  return {
    async execute(sql: string, params: readonly SqlValue[] = []) {
      return later(() => {
        const statement = sqlite.prepare(sql);
        // `all()` is used for statements that return rows, because better-sqlite3
        // refuses `run()` on them. Repositories use `execute` for writes and
        // `select` for reads, but migrations insert then read in the same
        // transaction, so both paths have to work here.
        if (statement.reader) {
          const rows = statement.all(...(params as never[]));
          return { rows: rows as unknown[], rowsAffected: 0 };
        }
        const result = statement.run(...(params as never[]));
        return {
          rows: [],
          rowsAffected: result.changes,
          lastInsertId: Number(result.lastInsertRowid),
        };
      });
    },

    async select<Row>(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
      return later(() => sqlite.prepare(sql).all(...(params as never[])) as Row[]);
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      // Not wrapped in `later()`: this has to be a real `await` so the rollback
      // path can observe a rejection from `fn`. `sqlite.exec` is synchronous but
      // the awaits between BEGIN and COMMIT still yield, which is what lets the
      // statements inside `fn` run on this same connection -- the same property
      // the production adapter relies on.
      sqlite.exec("BEGIN");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },

    async close(): Promise<void> {
      return later(() => {
        sqlite.close();
      });
    },
  };
}

/** A migrated, empty database. Every storage test starts here. */
export async function migratedTestDatabase(): Promise<DatabasePort> {
  const db = openTestDatabase();
  await runMigrations(db);
  return db;
}
