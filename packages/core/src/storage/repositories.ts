/**
 * Conversation and message repositories.
 *
 * Messages form a tree: `parent_id` points at the message that was regenerated
 * or edited, which is how branching works without duplicating a conversation.
 */

import { z } from "zod";
import type { Database } from "./database.js";
import type { TodoItem } from "../tools/git.js";
import type { ContentPart, ModelMessage, ToolCall, Usage } from "../models/types.js";
import type { Mode } from "../settings/schema.js";

export interface Conversation {
  readonly id: string;
  readonly mode: Mode;
  readonly title: string | null;
  readonly model: string | null;
  readonly providerId: string | null;
  readonly workspace: string | null;
  readonly systemPrompt: string | null;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoredMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly parentId: string | null;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: readonly ContentPart[];
  readonly reasoning: { readonly text: string; readonly signature: string } | null;
  readonly model: string | null;
  readonly providerId: string | null;
  readonly toolCalls: readonly ToolCall[] | null;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  readonly attachments: unknown[] | null;
  /** Structured tool output (diff, terminal, todos). Null for other roles. */
  readonly display: unknown | null;
  /** True once compaction has folded this turn into a summary. */
  readonly superseded: boolean;
  /** The run that produced this message. Null for anything typed by hand. */
  readonly runId: string | null;
  readonly usage: Usage | null;
  readonly finishReason: string | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly seq: number;
}

export interface ConversationSummary extends Conversation {
  readonly messageCount: number;
  readonly lastPreview: string | null;
}

export class ConversationRepository {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async create(input: {
    id: string;
    mode: Mode;
    title?: string | null;
    model?: string | null;
    providerId?: string | null;
    workspace?: string | null;
    systemPrompt?: string | null;
    now?: number;
  }): Promise<Conversation> {
    const now = input.now ?? Date.now();
    await this.#db.execute(
      `INSERT INTO conversations
         (id, mode, title, model, provider_id, workspace, system_prompt, pinned, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [
        input.id,
        input.mode,
        input.title ?? null,
        input.model ?? null,
        input.providerId ?? null,
        input.workspace ?? null,
        input.systemPrompt ?? null,
        now,
        now,
      ],
    );
    return {
      id: input.id,
      mode: input.mode,
      title: input.title ?? null,
      model: input.model ?? null,
      providerId: input.providerId ?? null,
      workspace: input.workspace ?? null,
      systemPrompt: input.systemPrompt ?? null,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  async get(id: string): Promise<Conversation | null> {
    const rows = await this.#db.select<ConversationRow>(
      `SELECT id, mode, title, model, provider_id AS providerId, workspace, system_prompt AS systemPrompt,
              pinned, archived, created_at AS createdAt, updated_at AS updatedAt
         FROM conversations WHERE id = ?`,
      [id],
    );
    const row = rows[0];
    return row ? mapConversation(row) : null;
  }

  /** Sidebar list: pinned first, then most recently updated. */
  async list(options: { mode?: Mode; search?: string; limit?: number } = {}): Promise<ConversationSummary[]> {
    const clauses: string[] = ["archived = 0"];
    const params: (string | number)[] = [];
    if (options.mode) {
      clauses.push("mode = ?");
      params.push(options.mode);
    }
    if (options.search?.trim()) {
      clauses.push("title LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(options.search.trim())}%`);
    }
    params.push(Math.min(options.limit ?? 200, 1_000));
    const rows = await this.#db.select<ConversationRow & { messageCount: number; lastPreview: string | null }>(
      `SELECT c.id, c.mode, c.title, c.model, c.provider_id AS providerId, c.workspace,
              c.system_prompt AS systemPrompt, c.pinned, c.archived,
              c.created_at AS createdAt, c.updated_at AS updatedAt,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messageCount,
              (SELECT m.content FROM messages m
                WHERE m.conversation_id = c.id AND m.role != 'tool'
                ORDER BY m.seq DESC LIMIT 1) AS lastPreview
         FROM conversations c
        WHERE ${clauses.join(" AND ")}
        ORDER BY c.pinned DESC, c.updated_at DESC
        LIMIT ?`,
      params,
    );
    return rows.map((row) => ({
      ...mapConversation(row),
      messageCount: Number(row.messageCount),
      lastPreview: row.lastPreview ? previewOf(JSON.parse(row.lastPreview) as ContentPart[]) : null,
    }));
  }

  async update(
    id: string,
    patch: Partial<Pick<Conversation, "title" | "model" | "workspace" | "systemPrompt" | "pinned" | "archived">>,
  ): Promise<void> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const push = (column: string, value: string | number | null | undefined) => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      params.push(value as string | number | null);
    };
    push("title", patch.title ?? undefined);
    push("model", patch.model ?? undefined);
    push("workspace", patch.workspace ?? undefined);
    push("system_prompt", patch.systemPrompt ?? undefined);
    push("pinned", patch.pinned === undefined ? undefined : patch.pinned ? 1 : 0);
    push("archived", patch.archived === undefined ? undefined : patch.archived ? 1 : 0);
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(Date.now(), id);
    await this.#db.execute(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  async touch(id: string): Promise<void> {
    await this.#db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", [Date.now(), id]);
  }

  async remove(id: string): Promise<void> {
    await this.#db.execute("DELETE FROM conversations WHERE id = ?", [id]);
  }

  /** Full history along one branch, oldest first. */
  async messages(conversationId: string, branchFrom?: string): Promise<StoredMessage[]> {
    const rows = branchFrom
      ? await this.#db.select<MessageRow>(
          `WITH RECURSIVE branch(id, parent_id) AS (
             SELECT id, parent_id FROM messages WHERE id = ?
             UNION ALL
             SELECT m.id, m.parent_id FROM messages m JOIN branch b ON m.id = b.parent_id
           )
           SELECT * FROM messages WHERE id IN (SELECT id FROM branch) ORDER BY seq ASC`,
          [branchFrom],
        )
      : await this.#db.select<MessageRow>(
          `SELECT * FROM messages WHERE conversation_id = ? AND parent_id IS NULL ORDER BY seq ASC`,
          [conversationId],
        );
    return rows.map(mapMessage);
  }

  /** Every branch head, for the "branch" switcher in the UI. */
  async branches(conversationId: string): Promise<{ id: string; role: string; seq: number }[]> {
    return this.#db.select<{ id: string; role: string; seq: number }>(
      `SELECT id, role, seq FROM messages
        WHERE conversation_id = ? AND parent_id IS NOT NULL
        ORDER BY seq ASC`,
      [conversationId],
    );
  }

  async nextSeq(conversationId: string): Promise<number> {
    const rows = await this.#db.select<{ next: number | null }>(
      "SELECT MAX(seq) + 1 AS next FROM messages WHERE conversation_id = ?",
      [conversationId],
    );
    return Number(rows[0]?.next ?? 1);
  }

  async addMessage(input: {
    id: string;
    conversationId: string;
    role: StoredMessage["role"];
    content?: readonly ContentPart[];
    parentId?: string | null;
    model?: string | null;
    providerId?: string | null;
    toolCalls?: readonly ToolCall[] | null;
    toolCallId?: string | null;
    toolName?: string | null;
    attachments?: unknown[] | null;
    display?: unknown;
    runId?: string | null;
    usage?: Usage | null;
    reasoning?: { text: string; signature: string } | null;
    finishReason?: string | null;
    error?: string | null;
    now?: number;
  }): Promise<StoredMessage> {
    const now = input.now ?? Date.now();
    const seq = await this.nextSeq(input.conversationId);
    await this.#db.execute(
      `INSERT INTO messages
         (id, conversation_id, parent_id, role, content, reasoning, model, provider_id,
          tool_calls, tool_call_id, tool_name, attachments, usage, finish_reason, error, display, run_id, created_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.conversationId,
        input.parentId ?? null,
        input.role,
        JSON.stringify(input.content ?? []),
        input.reasoning ? JSON.stringify(input.reasoning) : null,
        input.model ?? null,
        input.providerId ?? null,
        input.toolCalls ? JSON.stringify(input.toolCalls) : null,
        input.toolCallId ?? null,
        input.toolName ?? null,
        input.attachments ? JSON.stringify(input.attachments) : null,
        input.usage ? JSON.stringify(input.usage) : null,
        input.finishReason ?? null,
        input.error ?? null,
        input.display === undefined ? null : JSON.stringify(input.display),
        input.runId ?? null,
        now,
        seq,
      ],
    );
    await this.touch(input.conversationId);
    return {
      id: input.id,
      conversationId: input.conversationId,
      parentId: input.parentId ?? null,
      role: input.role,
      content: input.content ?? [],
      reasoning: input.reasoning ?? null,
      model: input.model ?? null,
      providerId: input.providerId ?? null,
      toolCalls: input.toolCalls ?? null,
      toolCallId: input.toolCallId ?? null,
      toolName: input.toolName ?? null,
      attachments: input.attachments ?? null,
      usage: input.usage ?? null,
      finishReason: input.finishReason ?? null,
      error: input.error ?? null,
      display: input.display ?? null,
      superseded: false,
      runId: input.runId ?? null,
      createdAt: now,
      seq,
    };
  }

  /**
   * Mark every message before `keepFromSeq` as folded into a summary.
   * Returns how many rows changed, so a caller can report honestly.
   */
  async supersedeBefore(conversationId: string, keepFromSeq: number): Promise<number> {
    const result = await this.#db.execute(
      `UPDATE messages SET superseded = 1 WHERE conversation_id = ? AND seq < ? AND superseded = 0`,
      [conversationId, keepFromSeq],
    );
    return result.rowsAffected;
  }

  /**
   * The structured write/edit payloads produced during one run, oldest first.
   *
   * Only the two file-writing tools are returned: a read or a shell command has
   * nothing to show as a diff, and pretending otherwise would pad the answer.
   */
  async changesInRun(conversationId: string, runId: string): Promise<
    { toolName: string; display: unknown; text: string }[]
  > {
    const rows = await this.#db.select<MessageRow>(
      `SELECT * FROM messages
         WHERE conversation_id = ? AND run_id = ? AND role = 'tool' AND tool_name IN ('write_file', 'edit_file')
         ORDER BY seq ASC`,
      [conversationId, runId],
    );
    return rows
      .filter((row) => row.display)
      .map((row) => ({
        toolName: row.tool_name ?? "tool",
        display: parseJson<unknown>(row.display ?? "", null),
        text: parseJson<ContentPart[]>(row.content, []).map((part) => (part.type === "text" ? part.text : "")).join(""),
      }));
  }

  async updateMessageContent(id: string, content: readonly ContentPart[]): Promise<void> {
    await this.#db.execute("UPDATE messages SET content = ? WHERE id = ?", [JSON.stringify(content), id]);
  }

  async removeMessage(id: string): Promise<void> {
    await this.#db.execute("DELETE FROM messages WHERE id = ?", [id]);
  }
}

export class RunRepository {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async start(input: {
    id: string;
    conversationId: string;
    mode: Mode;
    task?: string | null;
    workspace?: string | null;
  }): Promise<void> {
    await this.#db.execute(
      `INSERT INTO runs (id, conversation_id, mode, status, task, workspace, steps, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, 0, ?)`,
      [input.id, input.conversationId, input.mode, input.task ?? null, input.workspace ?? null, Date.now()],
    );
  }

  async finish(id: string, status: "done" | "cancelled" | "error", steps: number, error?: string): Promise<void> {
    await this.#db.execute(
      "UPDATE runs SET status = ?, steps = ?, finished_at = ?, error = ? WHERE id = ?",
      [status, steps, Date.now(), error ?? null, id],
    );
  }

  async list(conversationId: string, limit = 50): Promise<
    { id: string; mode: string; status: string; task: string | null; steps: number; startedAt: number; finishedAt: number | null }[]
  > {
    return this.#db.select(
      `SELECT id, mode, status, task, steps, started_at AS startedAt, finished_at AS finishedAt
         FROM runs WHERE conversation_id = ? ORDER BY started_at DESC LIMIT ?`,
      [conversationId, Math.min(limit, 500)],
    );
  }
}

/**
 * The messages that still count as turns, in order, keeping their `seq`.
 *
 * Separated from `toModelMessages` so that anything which has to line up an
 * index into the conversation with a message in the model-facing list can use
 * this one list for both. Deriving the two from the same filtered array is what
 * guarantees they stay the same length once a conversation has been compacted.
 */
export function survivingMessages(messages: readonly StoredMessage[]): StoredMessage[] {
  // System messages are instructions, not turns. Superseded ones are turns a
  // summary now stands in for, so sending them again would spend the context
  // window the compaction was meant to free.
  return messages.filter((message) => message.role !== "system" && !message.superseded);
}

export function toModelMessages(messages: readonly StoredMessage[]): ModelMessage[] {
  return survivingMessages(messages)
    .map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    }));
}

interface ConversationRow {
  id: string;
  mode: string;
  title: string | null;
  model: string | null;
  providerId: string | null;
  workspace: string | null;
  systemPrompt: string | null;
  pinned: number;
  archived: number;
  createdAt: number;
  updatedAt: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: string;
  content: string;
  reasoning: string | null;
  model: string | null;
  provider_id: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  attachments: string | null;
  display: string | null;
  superseded: number;
  run_id: string | null;
  usage: string | null;
  finish_reason: string | null;
  error: string | null;
  created_at: number;
  seq: number;
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    mode: row.mode as Mode,
    title: row.title,
    model: row.model,
    providerId: row.providerId,
    workspace: row.workspace,
    systemPrompt: row.systemPrompt,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    role: row.role as StoredMessage["role"],
    content: parseJson<ContentPart[]>(row.content, []),
    reasoning: row.reasoning ? parseJson(row.reasoning, null) : null,
    model: row.model,
    providerId: row.provider_id,
    toolCalls: row.tool_calls ? parseJson<ToolCall[]>(row.tool_calls, []) : null,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    attachments: row.attachments ? parseJson<unknown[]>(row.attachments, []) : null,
    display: row.display ? parseJson<unknown>(row.display, null) : null,
    superseded: row.superseded === 1,
    runId: row.run_id ?? null,
    usage: row.usage ? parseJson<Usage | null>(row.usage, null) : null,
    finishReason: row.finish_reason,
    error: row.error,
    createdAt: row.created_at,
    seq: row.seq,
  };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function previewOf(content: readonly ContentPart[]): string {
  const text = content
    .map((part) => (part.type === "text" ? part.text : part.type === "image" ? "[image]" : "[file]"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The per-conversation task list.
 *
 * Stored as one JSON blob rather than rows: the list is always replaced whole,
 * there is no per-item query, and a schema that cannot represent "reorder" is a
 * schema that will not need one.
 */
export class TodoRepository {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async list(conversationId: string): Promise<readonly TodoItem[]> {
    const rows = await this.#db.select<{ payload: string }>(
      "SELECT payload FROM todos WHERE conversation_id = ?",
      [conversationId],
    );
    const raw = rows[0]?.payload;
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      // Validated rather than trusted: a hand-edited or half-written row must
      // not be able to crash the UI that renders it.
      return TodoItemArraySchema.parse(parsed);
    } catch {
      return [];
    }
  }

  async replace(conversationId: string, items: readonly TodoItem[]): Promise<void> {
    const payload = JSON.stringify(items);
    await this.#db.execute(
      `INSERT INTO todos (conversation_id, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (conversation_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [conversationId, payload, Date.now()],
    );
  }
}

const TodoItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
const TodoItemArraySchema = z.array(TodoItemSchema);
