import { Button, Card, CardBody, CardTitle, cn } from "@atomic/ui";

export interface ProviderOfferProps {
  /** The model that would answer, on the other provider. */
  readonly model: string;
  /** Which account the user is about to hand the conversation to. */
  readonly providerLabel: string;
  /** Why the original provider could not answer. */
  readonly reason: string;
  /** Re-send the user's own message there. */
  readonly onAccept: () => void;
  /** Keep it here; go and choose something else. */
  readonly onDecline: () => void;
  readonly busy?: boolean;
}

/**
 * Asks before Atomic sends a conversation to another provider.
 *
 * A question rather than a notice because the answer changes who receives the
 * message: a different account, a different key, a different bill, and a
 * different party as data processor. The previous behaviour answered it
 * silently, which is why this is a dialog and not a line in the transcript.
 *
 * Declining is not a dead end. The user picks a model they already trust, and
 * the message is still theirs to resend.
 */
export function ProviderOffer(props: ProviderOfferProps) {
  const { model, providerLabel, reason, onAccept, onDecline, busy = false } = props;
  return (
    <Card
      className={cn("border-amber-500/40 bg-amber-500/5")}
      role="alertdialog"
      aria-labelledby="provider-offer-title"
      aria-describedby="provider-offer-reason"
    >
      <CardBody className="flex flex-col gap-3">
        <CardTitle id="provider-offer-title" className="text-sm">
          Answer this on {providerLabel}?
        </CardTitle>
        {/* Both halves matter: which model, and whose account. "Something else"
           without the account is not a consent question. */}
        <p id="provider-offer-reason" className="text-muted-foreground text-sm">
          {reason.replace(/\.$/, "")}, and your {providerLabel} account has {model}.
          Atomic did not switch on its own, because that is a different account
          with a different bill, and your message and conversation go to it.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={onAccept}>
            Use {providerLabel} for this message
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDecline}>
            Pick a model that is already set up
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          This applies to this message only. To change where chats go by default,
          pick a model in Settings &rarr; API &amp; Models.
        </p>
      </CardBody>
    </Card>
  );
}
