/**
 * Audit log.
 *
 * Every tool action and every permission decision is written here, in order,
 * before and after execution. This is the record you read when you want to know
 * what the agent actually did on your machine.
 *
 * Redaction: API keys never reach this table. `redact` scrubs anything that
 * looks like a bearer token or an `api_key` query parameter from free text.
 */

import type { Database } from "../storage/database.js";

export const AUDIT_KINDS = [
  "tool-call",
  "tool-result",
  "permission-decision",
  "approval",
  "model-request",
  "run-start",
  "run-finish",
  "error",
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditEntry {
  readonly kind: AuditKind;
  readonly conversationId?: string | null;
  readonly messageId?: string | null;
  readonly runId?: string | null;
  readonly tool?: string | null;
  readonly mode?: string | null;
  readonly decision?: string | null;
  readonly summary?: string | null;
  readonly detail?: unknown;
}

export interface AuditRow {
  id: number;
  ts: number;
  conversationId: string | null;
  messageId: string | null;
  runId: string | null;
  kind: string;
  tool: string | null;
  mode: string | null;
  decision: string | null;
  summary: string | null;
  detail: string | null;
}

const MAX_DETAIL_CHARS = 8_000;

export class AuditLog {
  #db: Database;
  #queue: Promise<void> = Promise.resolve();

  constructor(db: Database) {
    this.#db = db;
  }

  /** Fire-and-forget so the hot path never awaits disk. Writes stay ordered. */
  write(entry: AuditEntry): void {
    const detail = entry.detail === undefined ? null : safeStringify(redact(entry.detail));
    const params = [
      Date.now(),
      entry.conversationId ?? null,
      entry.messageId ?? null,
      entry.runId ?? null,
      entry.kind,
      entry.tool ?? null,
      entry.mode ?? null,
      entry.decision ?? null,
      entry.summary ? redactText(entry.summary).slice(0, 2_000) : null,
      detail,
    ];
    this.#queue = this.#queue
      .then(async () => {
        await this.#db.execute(
          `INSERT INTO audit_log
             (ts, conversation_id, message_id, run_id, kind, tool, mode, decision, summary, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params,
        );
      })
      .catch((error: unknown) => {
        console.error("[audit] write failed", error);
      });
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  async list(
    filter: { conversationId?: string; runId?: string; limit?: number } = {},
  ): Promise<AuditRow[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.conversationId) {
      clauses.push("conversation_id = ?");
      params.push(filter.conversationId);
    }
    if (filter.runId) {
      clauses.push("run_id = ?");
      params.push(filter.runId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.min(filter.limit ?? 500, 5_000));
    return this.#db.select<AuditRow>(
      `SELECT id, ts, conversation_id AS conversationId, message_id AS messageId, run_id AS runId,
              kind, tool, mode, decision, summary, detail
         FROM audit_log ${where}
        ORDER BY id DESC
        LIMIT ?`,
      params,
    );
  }

  /** Delete entries older than N days. History export is a separate flow. */
  async prune(olderThanMs: number): Promise<number> {
    const result = await this.#db.execute("DELETE FROM audit_log WHERE ts < ?", [
      Date.now() - olderThanMs,
    ]);
    return result.rowsAffected;
  }
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|pk|api|key|token)[-_][A-Za-z0-9]{12,}\b/gi,
  /("?(?:api[_-]?key|authorization|access[_-]?token|password|secret)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
  /([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi,
];

export function redactText(text: string): string {
  let out = text;
  out = out.replace(SECRET_PATTERNS[0]!, "Bearer REDACTED");
  out = out.replace(SECRET_PATTERNS[1]!, "REDACTED");
  out = out.replace(SECRET_PATTERNS[2]!, "$1REDACTED");
  out = out.replace(SECRET_PATTERNS[3]!, "$1REDACTED");
  return out;
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = /^(?:api[_-]?key|authorization|token|password|secret)$/i.test(key)
        ? "REDACTED"
        : redact(inner);
    }
    return out;
  }
  return value;
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
  } catch {
    return '"[unserialisable]"';
  }
}
