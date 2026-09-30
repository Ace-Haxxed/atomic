/**
 * The question asked when a model is not known to be free.
 *
 * This exists because the alternative was a global switch, and a global switch
 * is a bad way to ask this question. It is answered once, in the abstract, by
 * someone who was not looking at a bill -- and then it stands in for every later
 * question, including ones about models that did not exist yet. So the answer is
 * scoped to the one model and the one message on screen, and the text says what
 * the choice actually means.
 *
 * The asymmetry is deliberate. A paid model can be agreed to. A model Atomic has
 * called and been refused cannot, and is never offered here -- there is no
 * version of "yes" that makes it work.
 */

import { Button, Card, CardBody, CardTitle, cn } from "@atomic/ui";

export interface PaidModelPrompt {
  /** The model being asked about, for a specific, unmissable question. */
  readonly model: string;
  /** Why this model is not free, in the user's terms. */
  readonly reason: string;
  /** Approve this one turn. */
  readonly onAllow: () => void;
  /** Go back and choose something else. */
  readonly onDecline: () => void;
  readonly busy?: boolean;
}

export function PaidModelPrompt(props: PaidModelPrompt) {
  const { model, reason, onAllow, onDecline, busy = false } = props;
  return (
    <Card
      className={cn("border-amber-500/40 bg-amber-500/5")}
      role="alertdialog"
      aria-labelledby="paid-model-title"
      aria-describedby="paid-model-reason"
    >
      <CardBody className="flex flex-col gap-3">
        <CardTitle id="paid-model-title" className="text-sm">
          {model} is not free
        </CardTitle>
        {/* The reason, not just the verdict: "it costs money" is not actionable
            on its own, and neither is "unknown" without saying why. */}
        <p id="paid-model-reason" className="text-muted-foreground text-sm">
          {reason} Atomic is set to use free models only, so it stopped before
          sending.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={onAllow}>
            Use it for this message
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDecline}>
            Pick a free model
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          This applies to this message only. To change the default, turn off
          &ldquo;Only auto-select free models&rdquo; in Settings.
        </p>
      </CardBody>
    </Card>
  );
}
