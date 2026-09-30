/**
 * The transcript.
 *
 * Two sources are merged: rows that have already been written to SQLite, and the
 * in-flight run from the event stream. The live bubble is only rendered while a
 * run is actually producing text, so a finished run never shows twice.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { StoredMessage, Usage } from "@atomic/core";
import { Badge, Button, Separator, Spinner, cn } from "@atomic/ui";

import { Icon } from "./sidebar.js";
import { Markdown } from "./markdown.js";
import { ToolCard } from "./tool-card.js";
import type { ToolActivity } from "../app/use-agent-run.js";

export interface MessageListProps {
  readonly messages: readonly StoredMessage[];
  readonly liveText: string;
  readonly liveReasoning: string;
  readonly tools: readonly ToolActivity[];
  readonly streaming: boolean;
  readonly pendingApproval: boolean;
  readonly error: string | null;
  readonly usage: Usage;
  /**
   * Non-fatal lines above the transcript, for things the user should see that did
   * not stop the run -- a model or provider switch, a note about an unpriced free
   * model. Separate from `error` because an error ends the turn and these do not.
   *
   * A list rather than one string because a run can do both: a rate limit can
   * move the model to another provider *and* that model can publish no price.
   * The old single slot kept whichever came last and dropped the other, which
   * is how a switch notice stopped appearing the moment a note could.
   */
  readonly notices?: readonly string[];
  readonly onRetry?: () => void;
  /**
   * True when the answer was cut off at the output-token limit, and the handler
   * that asks for the rest.
   *
   * Not an error: the run succeeded as far as the host is concerned, so the
   * distinction has to be carried explicitly or a reply that stops mid-sentence
   * looks like a complete one.
   */
  readonly truncated?: boolean;
  readonly onContinue?: () => void;
  /**
   * A message that never made it to the server.
   *
   * Rendered in the transcript at the position it was typed rather than as a
   * full-screen error, because the text is the user's own work: taking the whole
   * app away to report that the send failed means the composer is cleared, the
   * conversation is gone, and the only way forward is to retype it.
   */
  readonly failedMessage?: FailedMessage | null;
}

export interface FailedMessage {
  readonly text: string;
  readonly attachmentNames: readonly string[];
  readonly error: string;
  readonly pending: boolean;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
}

export function MessageList(props: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Follow the stream, but stop following the moment the user scrolls up to read.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      pinnedToBottom.current = distance < 80;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [props.messages, props.liveText, props.tools, props.streaming]);

  const hasLiveContent =
    props.streaming && (props.liveText.length > 0 || props.liveReasoning.length > 0);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        {props.notices?.map((notice) => (
          <p
            key={notice}
            role="status"
            className="rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] text-content-muted"
          >
            {notice}
          </p>
        ))}

        {props.messages.length === 0 && !hasLiveContent ? (
          <Welcome />
        ) : null}

        {props.messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}

        {props.failedMessage ? <FailedUserMessage failed={props.failedMessage} /> : null}

        {hasLiveContent ? (
          <LiveBubble text={props.liveText} reasoning={props.liveReasoning} />
        ) : null}

        {props.tools.length > 0 ? <ToolList tools={props.tools} /> : null}

        {props.pendingApproval ? (
          <p className="flex items-center gap-2 text-[11px] text-content-muted">
            <Spinner className="size-3" />
            Waiting for your approval
          </p>
        ) : null}

        {props.error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2"
          >
            <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-danger">{props.error}</p>
              {props.onRetry ? (
                <button
                  type="button"
                  className="mt-1 text-[11px] underline underline-offset-2"
                  onClick={props.onRetry}
                >
                  Try again
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {props.truncated && props.onContinue ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-md border border-border-base bg-surface-sunken px-3 py-2"
          >
            <Icon name="alert" className="size-4 shrink-0 text-content-muted" />
            <p className="flex-1 text-[11px] text-content-muted">
              This answer stopped at the model&rsquo;s output limit, so it may be
              incomplete.
            </p>
            <Button size="sm" variant="ghost" onClick={props.onContinue}>
              Continue
            </Button>
          </div>
        ) : null}

        {props.usage.totalTokens > 0 ? <Usage usage={props.usage} /> : null}
      </div>
    </div>
  );
}

function Welcome() {
  const suggestions = useMemo(
    () => [
      "Explain this codebase's architecture in three sentences.",
      "Draft a release note for the changes in my last commit.",
      "Find every place this project calls the network, and why.",
    ],
    [],
  );
  return (
    <div className="py-8">
      <h1 className="text-lg font-semibold text-content">What are we working on?</h1>
      <p className="mt-1 text-[13px] text-content-muted">
        Ask a question, or start with one of these.
      </p>
      <ul className="mt-4 space-y-1.5">
        {suggestions.map((suggestion) => (
          <li
            key={suggestion}
            className="rounded-md border border-border-base px-3 py-2 text-[12px] text-content-muted"
          >
            {suggestion}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A user message that failed to send.
 *
 * Shown in the same place and shape as a sent one, with the error attached to
 * it, because that is what it is: the last thing the user did. The Retry action
 * resends exactly this text rather than making them find it again.
 */
function FailedUserMessage({ failed }: { readonly failed: FailedMessage }) {
  return (
    <article className="flex justify-end">
      <div className="max-w-[85%] space-y-1.5">
        <div className="rounded-lg rounded-br-sm border border-danger/40 bg-accent px-3 py-2 text-[13px] leading-relaxed text-accent-foreground">
          <p className="whitespace-pre-wrap">{failed.text}</p>
          {failed.attachmentNames.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5 border-t border-accent-foreground/20 pt-1.5 text-[11px]">
              {failed.attachmentNames.map((name) => (
                <li key={name} className="truncate">
                  {name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5"
        >
          <Icon name="alert" className="size-3.5 shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-[11px] text-danger">
            {failed.pending ? "Sending…" : failed.error}
          </p>
          {failed.pending ? null : (
            <>
              <Button size="sm" variant="ghost" onClick={failed.onRetry}>
                Retry
              </Button>
              <Button size="sm" variant="ghost" onClick={failed.onDiscard}>
                Discard
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function Message({ message }: { message: StoredMessage }) {
  const text = textOf(message);
  if (message.role === "user") {
    return (
      <article className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-br-sm bg-accent px-3 py-2 text-[13px] leading-relaxed text-accent-foreground">
          <p className="whitespace-pre-wrap">{text}</p>
          {attachmentsOf(message).length > 0 ? (
            <ul className="mt-1.5 space-y-0.5 border-t border-accent-foreground/20 pt-1.5 text-[11px]">
              {attachmentsOf(message).map((attachment) => (
                <li key={attachment.name} className="truncate">
                  {attachment.name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </article>
    );
  }
  if (message.role === "tool") {
    // A structured payload renders as a real card; anything without one keeps
    // the plain transcript row, which is right for reads and greps.
    const card = <ToolCard toolName={message.toolName ?? "tool"} display={message.display} />;
    if (card) {
      return (
        <div className="space-y-1">
          {card}
          {text ? <ToolText text={text} /> : null}
        </div>
      );
    }
    return (
      <article className="rounded-md border border-border-base bg-surface-sunken px-3 py-2">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-content-muted">
          <Icon name="check" className="size-3" />
          {message.toolName ?? "tool"}
        </p>
        {text ? <ToolText text={text} /> : null}
      </article>
    );
  }
  if (message.role === "system") {
    return (
      <p className="px-1 text-[11px] italic text-content-muted">{text}</p>
    );
  }
  return (
    <article className="space-y-2">
      {reasoningOf(message) ? <Reasoning text={reasoningOf(message)!} /> : null}
      <Markdown>{text}</Markdown>
      {message.error ? (
        <p className="text-[11px] text-danger">{message.error}</p>
      ) : null}
      <p className="flex items-center gap-1.5 text-[10px] text-content-muted">
        {message.model ? <span>{message.model}</span> : null}
        {message.usage ? (
          <span>
            {message.usage.inputTokens} in / {message.usage.outputTokens} out
          </span>
        ) : null}
      </p>
    </article>
  );
}

/** Tool prose, collapsed: the card carries the structure, this is the detail. */
function ToolText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 160) {
    return <p className="px-1 text-[11px] text-content-muted">{text}</p>;
  }
  return (
    <details className="rounded-md border border-border-base bg-surface-sunken">
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
        className="cursor-pointer select-none px-2 py-1 text-[11px] text-content-muted"
      >
        {open ? "Hide output" : `Show output (${text.length} chars)`}
      </summary>
      {open ? (
        <pre className="overflow-x-auto px-2 pb-2 font-mono text-[11px] text-content-muted">{text}</pre>
      ) : null}
    </details>
  );
}

/**
 * The in-progress reply.
 *
 * Rendered as plain text on purpose. Running the markdown parser over text that
 * is still arriving means every incomplete construct is parsed literally for a
 * moment -- `**bol` shows as raw asterisks, an unclosed fence opens a code block
 * and then closes again -- so the reply visibly thrashes and appears to contain
 * duplicate fragments that were never in the model output. The settled message
 * is parsed once, when the text is complete.
 */
function LiveBubble({ text, reasoning }: { text: string; reasoning: string }) {
  return (
    <article className="space-y-2">
      {reasoning ? <Reasoning text={reasoning} live /> : null}
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-content">
        {text}
      </p>
    </article>
  );
}

function Reasoning({ text, live = false }: { text: string; live?: boolean }) {
  return (
    <details className="rounded-md border border-border-base bg-surface-sunken" open={live}>
      <summary className="cursor-pointer select-none px-2 py-1 text-[11px] text-content-muted">
        {live ? "Thinking…" : "Reasoning"}
      </summary>
      <p className="whitespace-pre-wrap px-2 pb-2 text-[11px] leading-relaxed text-content-muted">
        {text}
      </p>
    </details>
  );
}

function ToolList({ tools }: { tools: readonly ToolActivity[] }) {
  return (
    <ul className="space-y-1">
      {tools.map((tool) => (
        <li
          key={tool.callId}
          className={cn(
            "flex items-start gap-2 rounded-md border px-2 py-1.5 text-[11px]",
            tool.status === "error"
              ? "border-danger/40 bg-danger/5"
              : "border-border-base bg-surface-sunken",
          )}
        >
          <Icon
            name={tool.status === "running" ? "chevron" : tool.status === "ok" ? "check" : "x"}
            className={cn(
              "mt-0.5 size-3 shrink-0",
              tool.status === "error" ? "text-danger" : "text-content-muted",
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5">
              <span className="font-mono text-content">{tool.name}</span>
              {tool.status === "running" ? <Spinner className="size-3" /> : null}
            </p>
            <p className="truncate text-content-muted">{tool.summary}</p>
            {tool.detail ? (
              <pre className="mt-1 overflow-x-auto font-mono text-[10px] text-content-muted">
                {tool.detail}
              </pre>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Usage({ usage }: { usage: Usage }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <Separator className="flex-1" />
      <Badge tone="neutral">
        {usage.inputTokens} in · {usage.outputTokens} out
      </Badge>
    </div>
  );
}

/** Content parts are a union; anything that is not text is shown as a stub. */
function textOf(message: StoredMessage): string {
  return message.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return "";
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function reasoningOf(message: StoredMessage): string | null {
  return message.reasoning?.text ?? null;
}

interface AttachmentView {
  readonly name: string;
}

function attachmentsOf(message: StoredMessage): readonly AttachmentView[] {
  const raw = message.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (entry && typeof entry === "object" && "name" in entry) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string") return [{ name }];
    }
    return [];
  });
}
