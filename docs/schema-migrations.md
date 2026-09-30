# Schema migrations

Migrations live in `packages/core/src/storage/migrations.ts` and are applied by
`runMigrations()` on every app start, inside a transaction, in array order.

## Applied migrations are immutable

**Never edit a migration that has shipped. Append a new one.**

A database records the id of every migration it has applied and skips those
forever. Editing migration 4 therefore does nothing at all to any database that
already ran it — and nothing is the worst possible outcome, because the code and
the database then quietly disagree about what the schema is.

This is not hypothetical. `messages.display`, `superseded` and `run_id` were
added by appending statements to migration 4 (`todos`) after it had shipped.
Databases that had already recorded migration 4 skipped the new statements, so
the columns were never created and the app failed on startup with:

```
table messages has no column named display
```

The recovered fix is what those columns are now: migration 5, `tool-display`.
If you are reading this while looking at a database that has been broken the
same way, see [Recovering a broken database](#recovering-a-broken-database).

## Adding a migration

1. Append a new entry to `MIGRATIONS`. Never renumber, never reorder, never
   reuse an id. The `id` is the identity of the migration.
2. Prefer additive changes. Adding a nullable column, or one with a default, is
   safe on a populated table. Renaming, dropping or retyping a column is not:
   SQLite has no `ALTER COLUMN`, so that means copying the table.
3. Put column additions in the `addColumns` list, not in `up`. SQLite has no
   `ADD COLUMN IF NOT EXISTS`, so a bare `ALTER TABLE ... ADD COLUMN` in `up`
   aborts the whole transaction on any machine where the column already
   exists — which is exactly the machine you cannot test on.
4. Statements in `up` run *after* `addColumns`, so an index in `up` can safely
   reference a new column.
5. Add a test that starts from the previous version and asserts the new schema
   and that existing rows still read.

## How tampering is caught

`runMigrations` stores an FNV-1a checksum of each migration's `id`, `name` and
`up` statements in `schema_migrations.checksum`. On every start it compares the
checksums of migrations the database has already applied and throws
`MigrationError` on a mismatch, naming the migration. The app then refuses to
start and says so on the startup error screen.

A missing or `NULL` checksum is backfilled rather than treated as a mismatch,
so installs that predate checksumming are not locked out of the app.

`packages/core/src/storage/migrations.test.ts` pins the checksums of every
shipped migration. That table cannot detect a change to the migrations it
hashes — it would change with them — so those values are the literal safeguard.
Editing a shipped migration fails the `shipped migrations are immutable` test.

## Recovering a broken database

When a mismatch is reported, the database is **not** modified. There is no
automatic repair, and there should not be: the only correct repair depends on
which version of the schema a given machine actually has, and guessing risks
the user's conversations.

Work through these in order.

1. **Confirm the diagnosis.** The error names the migration. Check what the
   database actually has:
   ```sh
   sqlite3 ~/.local/share/dev.atomic.app/atomic.db 'SELECT id, name FROM schema_migrations;'
   sqlite3 ~/.local/share/dev.atomic.app/atomic.db 'PRAGMA table_info(messages);'
   ```
2. **Back up the file first**, including `-wal` and `-shm` if they exist, or use
   `VACUUM INTO 'backup.db'`, which is safe to run against a live database:
   ```sh
   sqlite3 ~/.local/share/dev.atomic.app/atomic.db "VACUUM INTO 'atomic-backup.db'"
   ```
3. **Prefer the normal fix.** If the tampered migration has not been released
   to anyone but you, revert it to its shipped form. The checksums match again
   and the app starts.
4. **If the bad migration did ship**, leave the applied row alone and append a
   new migration that brings the database up to the intended schema. The
   immutable check stays authoritative: it is the only thing guaranteeing that
   "applied" means the code you are running is the code that ran.
5. **Only if history itself is wrong** — an id was applied under SQL that was
   never the intended SQL, so the recorded checksum can never be satisfied —
   correct the `schema_migrations` row by hand, from a backup, and record what
   you did. This is the one case where editing history is the repair.
