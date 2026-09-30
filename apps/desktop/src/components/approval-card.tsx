/**
 * Approval cards.
 *
 * One card per pending tool call, shown inline in the transcript. The wording is
 * the security boundary: it says what will happen and what will be remembered,
 * so "allow always" is a decision the user can actually make.
 */

import type { PendingApproval } from "@atomic/core";
import { Badge, Button, Card, CardBody, Separator, cn } from "@atomic/ui";

import { Icon } from "./sidebar.js";

export interface ApprovalCardProps {
  readonly approval: PendingApproval;
  readonly onResolve: (
    callId: string,
    decision: "allow" | "deny" | "allow-always",
  ) => void;
}

export function ApprovalCard({ approval, onResolve }: ApprovalCardProps) {
  const destructive = isDestructive(approval);

  return (
    <Card
      className={cn(
        "border-l-2",
        destructive ? "border-l-danger" : "border-l-accent",
      )}
    >
      <CardBody className="space-y-2">
        <div className="flex items-center gap-2">
          <Icon
            name="alert"
            className={cn("size-4 shrink-0", destructive ? "text-danger" : "text-accent")}
          />
          <p className="text-xs font-semibold text-content">
            {approval.tool} wants to run
          </p>
          {destructive ? (
            <Badge tone="danger">can change or delete data</Badge>
          ) : null}
        </div>

        <p className="font-mono text-[11px] leading-relaxed text-content-muted">
          {approval.summary}
        </p>

        {Object.keys(approval.args).length > 0 ? (
          <details>
            <summary className="cursor-pointer text-[11px] text-content-muted">
              Arguments
            </summary>
            <pre className="mt-1 overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-[10px] text-content">
              {safeJson(approval.args)}
            </pre>
          </details>
        ) : null}

        <Separator />

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="primary"
            size="sm"
            onClick={() => onResolve(approval.callId, "allow")}
          >
            Allow once
          </Button>
          {approval.suggestion ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onResolve(approval.callId, "allow-always")}
            >
              Always allow
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onResolve(approval.callId, "deny")}
          >
            Deny
          </Button>
          {approval.suggestion ? (
            <span className="ml-auto font-mono text-[10px] text-content-muted">
              {approval.suggestion}
            </span>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * A conservative second opinion on the summary the gate produced.
 *
 * The gate already refused the dangerous patterns; anything reaching here was
 * allowed to ask. This only affects how loudly the card is worded.
 */
function isDestructive(approval: PendingApproval): boolean {
  const haystack = `${approval.tool} ${approval.summary}`.toLowerCase();
  return [
    "rm ",
    "rmdir",
    "del ",
    "drop ",
    "truncate",
    "format",
    "chmod",
    "chown",
    "kill",
    "unlink",
    "overwrite",
    "delete",
    "install",
    "sudo",
  ].some((needle) => haystack.includes(needle));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
