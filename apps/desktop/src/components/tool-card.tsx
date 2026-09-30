/**
 * Rich cards for tool output.
 *
 * A write or an edit used to arrive as a wall of text, which is the wrong shape
 * for the one thing the user most needs to check: what changed. These cards
 * render the structured `display` payload the tools emit, which is persisted on
 * the message, so a diff the user approved is still there after a reload.
 *
 * The `unknown` parameter type is deliberate. The payload comes back out of
 * SQLite as JSON, so it is untyped at runtime, and a wrong `kind` or a missing
 * field must degrade to something readable rather than crash a finished
 * transcript. Every read below is treated as untrusted.
 */

import { useMemo, useState } from "react";
import { Spinner, cn } from "@atomic/ui";

import { Icon } from "./sidebar.js";

export interface ToolCardProps {
  readonly toolName: string;
  readonly display: unknown;
  readonly status?: "running" | "ok" | "error";
  readonly pendingApproval?: boolean;
}

export function ToolCard(props: ToolCardProps) {
  const payload = asRecord(props.display);
  if (payload === null) return null;

  switch (payload.kind) {
    case "file-write":
      return (
        <WriteCard
          path={str(payload.path)}
          bytes={num(payload.bytes)}
          created={payload.created === true}
          warning={str(payload.warning) || null}
          {...props}
        />
      );
    case "file-edit":
      return (
        <EditCard
          path={str(payload.path)}
          before={str(payload.before)}
          after={str(payload.after)}
          occurrences={num(payload.occurrences) ?? 1}
          warning={str(payload.warning) || null}
          {...props}
        />
      );
    case "bash":
      return (
        <BashCard
          command={str(payload.command)}
          exitCode={num(payload.exitCode)}
          durationMs={num(payload.durationMs)}
          stdout={str(payload.stdout)}
          stderr={str(payload.stderr)}
          truncated={payload.truncated === true}
          timedOut={payload.timedOut === true}
          {...props}
        />
      );
    case "todos":
      return <TodoCard todos={Array.isArray(payload.todos) ? payload.todos : []} {...props} />;
    default:
      return null;
  }
}

/** A checkpoint that failed, so this change cannot be undone with /undo. */
function BackupWarning({ warning }: { warning: string }) {
  return (
    <p className="flex items-start gap-1.5 border-t border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">
      <Icon name="alert" className="mt-0.5 size-3 shrink-0" />
      <span>
        {warning} This change is permanent from Atomic&apos;s point of view — use version control
        if you need it back.
      </span>
    </p>
  );
}

function Card({
  icon,
  title,
  subtitle,
  status,
  pendingApproval,
  warning,
  tone = "neutral",
  children,
}: {
  icon: string;
  title: string;
  subtitle?: string | null;
  status?: ToolCardProps["status"];
  pendingApproval?: boolean;
  warning?: string | null;
  tone?: "neutral" | "danger";
  children?: React.ReactNode;
}) {
  return (
    <article
      className={cn(
        "overflow-hidden rounded-md border",
        tone === "danger" ? "border-danger/40 bg-danger/5" : "border-border-base bg-surface-sunken",
      )}
    >
      <header
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-[11px]",
          status === "error" ? "text-danger" : "text-content-muted",
        )}
      >
        <Icon name={icon} className="size-3 shrink-0" />
        <span className="font-mono font-medium text-content">{title}</span>
        {subtitle ? <span className="truncate">{subtitle}</span> : null}
        <span className="flex-1" />
        {pendingApproval ? (
          <span className="flex items-center gap-1 text-content-secondary">
            <Spinner className="size-3" />
            waiting for you
          </span>
        ) : null}
        {status === "ok" && !pendingApproval ? <Icon name="check" className="size-3" /> : null}
      </header>
      {children}
      {warning ? <BackupWarning warning={warning} /> : null}
    </article>
  );
}

function WriteCard(props: {
  path: string;
  bytes: number | null;
  created: boolean;
  warning: string | null;
} & ToolCardProps) {
  const size = props.bytes === null ? null : `${(props.bytes / 1024).toFixed(1)} KB`;
  return (
    <Card
      icon="code"
      title={props.created ? "created" : "wrote"}
      subtitle={[props.path, size].filter(Boolean).join(" · ")}
      status={props.status}
      pendingApproval={props.pendingApproval}
      warning={props.warning}
    />
  );
}

function EditCard(props: {
  path: string;
  before: string;
  after: string;
  occurrences: number;
  warning: string | null;
} & ToolCardProps) {
  const rows = useMemo(() => diffLines(props.before, props.after), [props.before, props.after]);
  const added = rows.filter((row) => row.type === "add").length;
  const removed = rows.filter((row) => row.type === "del").length;
  const [expanded, setExpanded] = useState(rows.length <= 40);

  return (
    <Card
      icon="code"
      title="edited"
      subtitle={`${props.path} · +${added} −${removed}`}
      status={props.status}
      pendingApproval={props.pendingApproval}
      warning={props.warning}
    >
      {added === 0 && removed === 0 ? (
        <p className="px-2.5 pb-2 text-[11px] text-content-muted">No change in content.</p>
      ) : (
        <>
          <pre
            className={cn(
              "max-h-80 overflow-auto border-t border-border-base px-2.5 py-1.5 font-mono text-[11px] leading-relaxed",
              !expanded && "max-h-28",
            )}
          >
            {rows.map((row, i) => (
              <span
                key={i}
                className={cn(
                  "flex",
                  row.type === "add" && "bg-success/10 text-success",
                  row.type === "del" && "bg-danger/10 text-danger",
                  row.type === "ctx" && "text-content-muted",
                )}
              >
                <span className="w-3 shrink-0 select-none opacity-70">
                  {row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
                </span>
                <span className="w-8 shrink-0 select-none text-right opacity-50">
                  {row.type !== "add" ? row.before : ""}
                </span>
                <span className="w-8 shrink-0 select-none text-right opacity-50">
                  {row.type !== "del" ? row.after : ""}
                </span>
                <span className="pl-2 whitespace-pre-wrap break-all">{row.text}</span>
              </span>
            ))}
          </pre>
          {rows.length > 12 ? (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="w-full border-t border-border-base px-2.5 py-1 text-left text-[11px] text-content-muted hover:text-content"
            >
              {expanded ? "Show less" : `Show all ${rows.length} changed lines`}
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}

function BashCard(props: {
  command: string;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
} & ToolCardProps) {
  const failed = props.exitCode !== null && props.exitCode !== 0;
  const duration = props.durationMs === null ? null : `${(props.durationMs / 1000).toFixed(1)}s`;
  const parts = [
    props.exitCode === null ? null : `exit ${props.exitCode}`,
    duration,
    props.truncated ? "truncated" : null,
    props.timedOut ? "timed out" : null,
  ].filter(Boolean);

  return (
    <Card
      icon="code"
      title="terminal"
      subtitle={parts.length > 0 ? parts.join(" · ") : null}
      status={failed ? "error" : props.status}
      pendingApproval={props.pendingApproval}
      tone={failed ? "danger" : "neutral"}
    >
      <p className="border-t border-border-base px-2.5 py-1.5 font-mono text-[11px] text-content">
        <span className="select-none text-content-muted">$ </span>
        {props.command}
      </p>
      {props.stdout ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-border-base px-2.5 py-1.5 font-mono text-[11px] text-content-muted">
          {props.stdout}
        </pre>
      ) : null}
      {props.stderr ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-danger/30 px-2.5 py-1.5 font-mono text-[11px] text-danger">
          {props.stderr}
        </pre>
      ) : null}
      {!props.stdout && !props.stderr ? (
        <p className="border-t border-border-base px-2.5 py-1.5 text-[11px] text-content-muted">
          No output.
        </p>
      ) : null}
    </Card>
  );
}

function TodoCard({ todos, status, pendingApproval }: { todos: readonly unknown[] } & ToolCardProps) {
  const items = todos
    .map((todo) => {
      const record = asRecord(todo);
      if (record === null) return null;
      return { content: str(record.content).trim(), status: str(record.status) ?? "pending" };
    })
    // A step with no text is a malformed payload. Rendering it would show the
    // user a blank checkbox and hide the fact that the plan is broken.
    .filter((todo): todo is { content: string; status: string } => todo !== null && todo.content !== "");

  const done = items.filter((todo) => todo.status === "completed").length;
  return (
    <Card
      icon="check"
      title="plan"
      subtitle={`${done}/${items.length} done`}
      status={status}
      pendingApproval={pendingApproval}
    >
      <ol className="space-y-1 border-t border-border-base px-2.5 py-1.5">
        {items.map((todo, i) => (
          <li key={i} className="flex items-start gap-1.5 text-[11px]">
            <Icon
              name={todo.status === "completed" ? "check" : todo.status === "in_progress" ? "chevron" : "alert"}
              className={cn(
                "mt-0.5 size-3 shrink-0",
                todo.status === "completed" ? "text-success" : "text-content-muted",
              )}
            />
            <span
              className={cn(
                "min-w-0 flex-1",
                todo.status === "in_progress" ? "text-content" : "text-content-muted",
                todo.status === "completed" && "line-through opacity-60",
              )}
            >
              {todo.content}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

interface DiffRow {
  readonly type: "ctx" | "add" | "del";
  readonly text: string;
  readonly before: number;
  readonly after: number;
}

/** Beyond this, a full line diff is more noise than information. */
const MAX_DIFF_CELLS = 400_000;

function diffLines(before: string, after: string): DiffRow[] {
  // An empty file has no lines at all. Splitting it would invent a blank line,
  // and a brand new file would then appear to "change" from nothing to a line.
  const a = toLines(before);
  const b = toLines(after);

  let head = 0;
  while (head < a.length && head < b.length && at(a, head) === at(b, head)) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    at(a, a.length - 1 - tail) === at(b, b.length - 1 - tail)
  ) {
    tail++;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < head; i++) {
    rows.push({ type: "ctx", text: at(a, i), before: i + 1, after: i + 1 });
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    // Too big to align honestly. Say what changed rather than inventing an
    // alignment that misrepresents where the edits landed.
    for (let i = 0; i < midA.length; i++) {
      rows.push({ type: "del", text: at(midA, i), before: head + i + 1, after: 0 });
    }
    for (let i = 0; i < midB.length; i++) {
      rows.push({ type: "add", text: at(midB, i), before: 0, after: head + i + 1 });
    }
  } else {
    rows.push(...lcsDiff(midA, midB, head));
  }

  for (let i = 0; i < tail; i++) {
    rows.push({
      type: "ctx",
      text: at(a, a.length - tail + i),
      before: a.length - tail + i + 1,
      after: b.length - tail + i + 1,
    });
  }
  return rows;
}

function lcsDiff(midA: readonly string[], midB: readonly string[], offset: number): DiffRow[] {
  const rows: DiffRow[] = [];
  const table: number[][] = Array.from({ length: midA.length + 1 }, () => new Array<number>(midB.length + 1).fill(0));
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      table[i]![j] = at(midA, i) === at(midB, j) ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    const lineA = at(midA, i);
    const lineB = at(midB, j);
    if (lineA === lineB) {
      rows.push({ type: "ctx", text: lineA, before: offset + i + 1, after: offset + j + 1 });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      rows.push({ type: "del", text: lineA, before: offset + i + 1, after: 0 });
      i++;
    } else {
      rows.push({ type: "add", text: lineB, before: 0, after: offset + j + 1 });
      j++;
    }
  }
  while (i < midA.length) {
    rows.push({ type: "del", text: at(midA, i), before: offset + i + 1, after: 0 });
    i++;
  }
  while (j < midB.length) {
    rows.push({ type: "add", text: at(midB, j), before: 0, after: offset + j + 1 });
    j++;
  }
  return rows;
}

function toLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function at(lines: readonly string[], index: number): string {
  return lines[index] ?? "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
