/**
 * The "approve the plan" bar and the level it hands you.
 *
 * Plan mode is a permission level, not a mode of its own, so by itself it is a
 * dead end: the agent investigates, cannot change anything, and the user is
 * left holding a plan with no obvious way to act on it. This is the way out.
 *
 * Approving asks which level to continue at rather than picking one silently.
 * Both options are still constrained:
 *
 *   - `ask` is preselected. Approving a plan is consent to *that plan*, not a
 *     standing decision that every later edit should be automatic.
 *   - `auto-accept` is offered because a plan the user has read and agreed with
 *     is exactly the case where re-confirming each edit is friction.
 *   - `bypass` is not offered at all. Nothing about reading a plan implies
 *     consent to run every command without asking, and the plan-mode gate is the
 *     wrong place to hand that out.
 */

import { useState } from "react";
import { Button, Card, CardBody, CardHeader, CardTitle, cn } from "@atomic/ui";

import { Icon } from "./sidebar.js";

/** The only levels approving a plan may move to. */
export type ApprovedLevel = "ask" | "auto-accept";

export interface PlanApprovalProps {
  /** True when the level in force is `plan`. */
  readonly planning: boolean;
  /** True only once a run has finished, so the bar does not appear mid-run. */
  readonly settled: boolean;
  readonly busy: boolean;
  /** Nothing to approve before the agent has said anything. */
  readonly hasPlan: boolean;
  readonly onApprove: (level: ApprovedLevel) => void;
  readonly onLeavePlanning: () => void;
}

export function PlanApproval(props: PlanApprovalProps) {
  const [choosing, setChoosing] = useState(false);
  if (!props.planning || !props.settled || props.busy || !props.hasPlan) return null;

  return (
    <>
      <div className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2">
        <Icon name="alert" className="size-3.5 shrink-0 text-accent" />
        <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-content-secondary">
          Plan mode is read-only. Approving switches to <strong>ask</strong>, so each change is
          yours to confirm — the plan is not a standing permission to edit whatever comes next.
        </p>
        <Button variant="secondary" size="sm" onClick={props.onLeavePlanning}>
          Stay in plan mode
        </Button>
        <Button size="sm" onClick={() => setChoosing(true)}>
          Approve plan
        </Button>
      </div>
      {choosing ? (
        <PlanLevelDialog
          onCancel={() => setChoosing(false)}
          onChoose={(level) => {
            setChoosing(false);
            props.onApprove(level);
          }}
        />
      ) : null}
    </>
  );
}

const CHOICES: readonly { level: ApprovedLevel; title: string; detail: string }[] = [
  {
    level: "ask",
    title: "Ask every time",
    detail: "Each command and each command-line change waits for you. Safest, and the default.",
  },
  {
    level: "auto-accept",
    title: "Auto-accept edits",
    detail: "File edits go through on their own. Commands and anything outside the workspace still ask.",
  },
];

/**
 * Split out and driven by props rather than internal state so the choice it
 * renders can be asserted directly.
 */
export function PlanLevelDialog({
  onCancel,
  onChoose,
}: {
  readonly onCancel: () => void;
  readonly onChoose: (level: ApprovedLevel) => void;
}) {
  // Preselected, not merely defaulted: `ask` is what runs unless someone
  // deliberately reaches for the other one.
  const [selected, setSelected] = useState<ApprovedLevel>("ask");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="plan-approve-title"
    >
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle id="plan-approve-title">Carry out the plan?</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-xs leading-relaxed text-content-muted">
            Pick how much the agent does on its own from here. You can change this at any time in
            Settings.
          </p>

          <fieldset className="space-y-1.5">
            <legend className="sr-only">Permission level</legend>
            {CHOICES.map((choice) => (
              <label
                key={choice.level}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2",
                  selected === choice.level
                    ? "border-accent bg-accent/5"
                    : "border-border-base hover:bg-surface-sunken",
                )}
              >
                <input
                  type="radio"
                  name="plan-approval-level"
                  value={choice.level}
                  checked={selected === choice.level}
                  onChange={() => setSelected(choice.level)}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] text-content">{choice.title}</span>
                  <span className="block text-[11px] leading-relaxed text-content-muted">
                    {choice.detail}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => onChoose(selected)}>
              Start
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
