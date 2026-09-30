/**
 * Database port.
 *
 * `core` never imports a SQLite driver. The desktop host supplies an adapter
 * backed by Tauri's SQL plugin; a future Node host (for `atomic serve`) can
 * supply `node:sqlite`. Repositories below only speak this interface.
 */

export type SqlValue = string | number | null | Uint8Array | bigint;

export interface QueryResult<Row> {
  readonly rows: Row[];
  readonly rowsAffected: number;
  readonly lastInsertId?: number;
}

export interface Database {
  execute(sql: string, params?: readonly SqlValue[]): Promise<QueryResult<unknown>>;
  select<Row = Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A value that may be bound to a statement. */
export type Bindable = SqlValue | boolean | undefined;

export function toSqlValue(value: Bindable): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}
