/**
 * The composer.
 *
 * Enter sends, Shift+Enter newlines, and the box grows with the text up to a
 * ceiling. Attachments are requested from the host, never read from the
 * webview's own filesystem, so the same code path works in the browser dev
 * server and in the packaged app.
 */

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { Attachment, Mode } from "@atomic/core";
import { matchCommands, resolveCommandLine, type SlashCommand } from "@atomic/core";
import type { SlashResult } from "../app/slash-commands.js";
import { ToolCard } from "./tool-card.js";
import { Button, Textarea, cn } from "@atomic/ui";

import { Icon } from "./sidebar.js";

export interface ComposerProps {
  readonly disabled: boolean;
  readonly sendKey: "enter" | "cmd-enter";
  readonly workspace: string | null;
  readonly onSend: (text: string, attachments: readonly Attachment[]) => void;
  readonly onStop: () => void;
  readonly onAttach: () => Promise<Attachment[]>;
  readonly onPickFolder: () => Promise<string | null>;
  /** Used to filter the command menu to what this mode offers. */
  readonly mode: Mode;
  /**
   * Runs a command. A result is local output -- text, cards, or both -- and
   * means the command produced something to show instead of sending a message.
   */
  readonly onCommand: (
    command: SlashCommand,
    argument: string,
  ) => Promise<SlashResult | null> | SlashResult | null;
}

const MAX_ROWS_PX = 200;

export function Composer(props: ComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the content, but stop before the composer eats the transcript.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_ROWS_PX)}px`;
  }, [text]);

  useEffect(() => {
    if (!props.disabled) textareaRef.current?.focus();
  }, [props.disabled]);

  const canSend = !props.disabled && !busy && text.trim().length > 0;

  const [menuIndex, setMenuIndex] = useState(0);
  // Local command output, rendered under the composer rather than pushed into
  // the transcript: a note or a recalled diff is about *this* run, and storing
  // it as a message would make it look like part of the conversation.
  const [output, setOutput] = useState<SlashResult | null>(null);

  // The menu only appears when the message so far is nothing but a slash word.
  // Mid-sentence `/` is just text, and offering commands there would be noise.
  const menuQuery = text.startsWith("/") && !text.slice(1).includes(" ") ? text : "";
  const matches: readonly SlashCommand[] =
    menuQuery === "" ? [] : matchCommands(menuQuery, props.mode);
  const menuOpen = menuQuery !== "" && matches.length > 0 && output === null;

  // Reset the highlight when the list changes, or Enter would act on whatever
  // happened to be selected a keystroke ago.
  useEffect(() => setMenuIndex(0), [menuQuery]);

  const accept = (command: SlashCommand, argument = "") => {
    setText("");
    setOutput(null);
    void Promise.resolve(props.onCommand(command, argument)).then((result) => {
      if (result) setOutput(result);
    });
  };

  const submit = () => {
    if (!canSend) return;
    const value = text.trim();
    setText("");
    setAttachments([]);
    setOutput(null);

    // Splitting on the first space is what makes `/release v1.2..v1.3` run the
    // command with an argument instead of being sent to the model as literal
    // text, which is what it did before this existed.
    const hit = resolveCommandLine(value, props.mode);
    if (hit) {
      accept(hit.command, hit.argument);
      return;
    }
    // Cleared before the send resolves: the transcript is the source of truth
    // for whether the message arrived, and a double-send is worse than a
    // visibly empty box.
    props.onSend(value, attachments);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMenuIndex((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMenuIndex((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuIndex(0);
        setText("");
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const picked = matches[menuIndex];
        if (picked) setText(`/${picked.name} `);
        return;
      }
    }
    const isEnter = event.key === "Enter" && !event.nativeEvent.isComposing;
    if (!isEnter) return;
    const wantsSend =
      props.sendKey === "enter"
        ? !event.shiftKey
        : event.metaKey || event.ctrlKey;
    if (!wantsSend) return;
    // Cmd-Enter must win even when the mode is plain Enter.
    event.preventDefault();
    if (menuOpen) {
      const picked = matches[menuIndex];
      if (picked) accept(picked);
      return;
    }
    submit();
  };

  const addAttachments = async () => {
    setBusy(true);
    try {
      const picked = await props.onAttach();
      if (picked.length > 0) {
        setAttachments((current) => [...current, ...picked].slice(0, 10));
      }
    } finally {
      setBusy(false);
    }
  };

  // A pasted image is a real attachment, not text.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void Promise.all(
      files.map(async (file) => {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of buffer) binary += String.fromCharCode(byte);
        return {
          id: `paste-${file.name}-${buffer.length}`,
          name: file.name || "pasted.png",
          mimeType: file.type || "application/octet-stream",
          data: btoa(binary),
          size: buffer.length,
        } satisfies Attachment;
      }),
    ).then((picked) => setAttachments((current) => [...current, ...picked].slice(0, 10)));
  };

  return (
    <div className="border-t border-border-base bg-surface px-4 py-3">
      <div className="mx-auto w-full max-w-3xl">
        {attachments.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="flex items-center gap-1.5 rounded border border-border-base bg-surface-sunken px-1.5 py-0.5 text-[11px] text-content-muted"
              >
                <Icon name="attach" className="size-3" />
                <span className="max-w-40 truncate">{attachment.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((item) => item.id !== attachment.id),
                    )
                  }
                >
                  <Icon name="x" className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {output ? (
          <div className="mb-2 space-y-1.5">
            {output.note ? (
              <p className="whitespace-pre-wrap rounded-md border border-border-base bg-surface-sunken px-2.5 py-1.5 text-[11px] leading-relaxed text-content-muted">
                {output.note}
              </p>
            ) : null}
            {output.cards?.map((card, index) => (
              <ToolCard key={index} toolName={card.toolName} display={card.display} status="ok" />
            ))}
            <p className="text-right">
              <button type="button" onClick={() => setOutput(null)} className="text-[11px] text-content-muted underline">
                dismiss
              </button>
            </p>
          </div>
        ) : null}

        {menuOpen ? (
          <ul className="mb-2 overflow-hidden rounded-lg border border-border-base bg-surface-raised">
            {matches.map((command, index) => (
              <li key={command.name}>
                <button
                  type="button"
                  onMouseEnter={() => setMenuIndex(index)}
                  onClick={() => accept(command)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left",
                    index === menuIndex && "bg-surface-sunken",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[12px] text-content">
                    <span className="font-mono">/{command.name}</span>
                    {command.destructive ? (
                      <span className="text-[10px] text-danger">changes files</span>
                    ) : null}
                  </span>
                  <span className="text-[11px] text-content-muted">{command.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div
          className={cn(
            "rounded-lg border border-border-strong bg-surface-raised",
            "focus-within:border-accent",
          )}
        >
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={
              props.workspace
                ? `Ask anything about ${basenameOf(props.workspace)}`
                : "Ask anything"
            }
            disabled={props.disabled}
            rows={1}
            className="max-h-[200px] min-h-9 resize-none border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
            aria-label="Message"
          />

          <div className="flex items-center gap-1 border-t border-border-base px-2 py-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void addAttachments()}
              disabled={props.disabled || busy}
              title="Attach files"
            >
              <Icon name="attach" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void props.onPickFolder()}
              title="Choose a workspace folder"
            >
              <Icon name="folder" />
            </Button>
            <span className="ml-auto text-[10px] text-content-muted">
              {props.sendKey === "enter" ? "Enter to send · Shift+Enter for a new line" : "Cmd/Ctrl+Enter to send"}
            </span>
            {props.disabled ? (
              <Button variant="secondary" size="sm" onClick={props.onStop}>
                <Icon name="stop" />
                Stop
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={submit} disabled={!canSend}>
                <Icon name="send" />
                Send
              </Button>
            )}
          </div>
        </div>

        {props.workspace ? (
          <p className="mt-1.5 truncate text-[10px] text-content-muted">
            Workspace: {props.workspace}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
