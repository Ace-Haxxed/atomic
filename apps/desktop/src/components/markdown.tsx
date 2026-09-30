/**
 * The view for `parseMarkdown`.
 *
 * This file is deliberately dumb: tokens in, elements out. All of the parsing
 * decisions — and the guarantee that HTML in the source stays text — live in
 * `lib/markdown-parse.ts`, which is pure and unit tested.
 */

import { Fragment } from "react";

import { cn } from "@atomic/ui";

import {
  parseMarkdown,
  type BlockToken,
  type InlineToken,
  type ProseToken,
} from "../lib/markdown-parse.js";

export interface MarkdownProps {
  readonly children: string;
  readonly className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  const blocks = parseMarkdown(children);
  return (
    <div className={cn("space-y-2 text-[13px] leading-relaxed text-content", className)}>
      {blocks.map((block, index) => (
        <Block key={`block-${index}`} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: BlockToken }) {
  if (block.kind === "code") {
    return <CodeBlock language={block.language} body={block.body} />;
  }
  return (
    <Fragment>
      {block.tokens.map((token, index) => (
        <Prose key={`prose-${index}`} token={token} />
      ))}
    </Fragment>
  );
}

function Prose({ token }: { token: ProseToken }) {
  switch (token.kind) {
    case "heading": {
      const Tag = `h${Math.min(6, Math.max(1, token.level))}` as "h1";
      return (
        <Tag className="mt-3 text-sm font-semibold text-content first:mt-0">
          <Inline tokens={token.inline} />
        </Tag>
      );
    }
    case "list":
      return (
        <ul className="list-disc space-y-0.5 pl-5 marker:text-content-muted">
          {token.items.map((item, index) => (
            <li key={`item-${index}`}>
              <Inline tokens={item} />
            </li>
          ))}
        </ul>
      );
    default:
      return (
        <p className="whitespace-pre-wrap">
          <Inline tokens={token.inline} />
        </p>
      );
  }
}

function Inline({ tokens }: { tokens: readonly InlineToken[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        switch (token.kind) {
          case "code":
            return (
              <code
                key={index}
                className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[0.9em] text-content"
              >
                {token.text}
              </code>
            );
          case "strong":
            return (
              <strong key={index} className="font-semibold text-content">
                {token.text}
              </strong>
            );
          case "em":
            return (
              <em key={index} className="italic">
                {token.text}
              </em>
            );
          case "strike":
            return (
              <span key={index} className="line-through opacity-70">
                {token.text}
              </span>
            );
          default:
            // Plain text node. React escapes it; there is no path by which a
            // character in the source becomes markup.
            return <Fragment key={index}>{token.text}</Fragment>;
        }
      })}
    </>
  );
}

function CodeBlock({ language, body }: { language: string; body: string }) {
  return (
    <figure className="overflow-hidden rounded-md border border-border-base bg-surface-sunken">
      <figcaption className="flex items-center justify-between border-b border-border-base px-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-content-muted">
          {language || "code"}
        </span>
        <CopyButton body={body} />
      </figcaption>
      <pre className="overflow-x-auto px-3 py-2">
        <code className="font-mono text-[12px] leading-relaxed text-content">{body}</code>
      </pre>
    </figure>
  );
}

function CopyButton({ body }: { body: string }) {
  return (
    <button
      type="button"
      className="rounded px-1.5 py-0.5 text-[10px] text-content-muted transition-colors hover:bg-surface-raised hover:text-content"
      onClick={() => {
        // Clipboard access can be denied or absent; a failure here is not worth
        // interrupting the user for.
        void navigator.clipboard?.writeText(body).catch(() => undefined);
      }}
    >
      Copy
    </button>
  );
}
