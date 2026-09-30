/**
 * Markdown parsing, as data.
 *
 * Model output is untrusted. Rather than hand the text to a library that
 * eventually calls `innerHTML`, the parser produces a token tree and the view
 * maps tokens to React elements. There is no HTML string anywhere in the path,
 * so markup in a model response is inert by construction rather than by
 * sanitisation.
 *
 * This file is pure: no DOM, no React. That is what makes the security property
 * — "HTML in the input stays text" — testable without a browser.
 *
 * Supported: fenced code blocks with a language label, inline code, bold,
 * italic, strikethrough, ATX headings, unordered lists, and paragraphs.
 */

export type InlineToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "em"; readonly text: string }
  | { readonly kind: "strike"; readonly text: string };

export type ProseToken =
  | { readonly kind: "paragraph"; readonly inline: readonly InlineToken[] }
  | { readonly kind: "heading"; readonly level: number; readonly inline: readonly InlineToken[] }
  | { readonly kind: "list"; readonly items: readonly (readonly InlineToken[])[] };

export type BlockToken =
  | { readonly kind: "code"; readonly language: string; readonly body: string }
  | { readonly kind: "prose"; readonly tokens: readonly ProseToken[] };

// `m` is required for `^` to mean "start of a line": a fenced block is almost
// never at offset 0 of a model response. Group 2 is the info string and group 3
// the body, so neither has to be recovered by re-parsing the whole match.
const FENCE = /^[ \t]*(```|~~~)([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\1[ \t]*(?:\n|$)|$)/gm;
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*|_[^_\n]+_)/g;
// `#` is greedy and the level is clamped later, so seven hashes is a level-6
// heading rather than a paragraph.
const HEADING = /^[ \t]*(#{1,})[ \t]+(.*)$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;

/** Split into code and prose blocks, then parse each prose block into tokens. */
export function parseMarkdown(source: string): BlockToken[] {
  const blocks: BlockToken[] = [];
  FENCE.lastIndex = 0;
  let lastIndex = 0;
  for (const match of source.matchAll(FENCE)) {
    if (match.index > lastIndex) blocks.push(prose(source.slice(lastIndex, match.index)));
    blocks.push({
      kind: "code",
      language: languageOf(match[2] ?? ""),
      body: match[3] ?? "",
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < source.length) blocks.push(prose(source.slice(lastIndex)));
  return blocks;
}

/**
 * The info string after the fence marker, if it names a language.
 *
 * Models routinely emit ```{json} or ~~~{"key":1}, where the "language" is
 * actually a JSON payload. Anything that is not a bare identifier is reported as
 * no language rather than displayed as one.
 */
function languageOf(info: string): string {
  // `{rust}` and `rust,ignore` both name a language; `{"a":1}` does not.
  const token = info.trim().split(/[\s,]/)[0] ?? "";
  const candidate = token.replace(/^\{/, "").replace(/\}$/, "").toLowerCase();
  return /^[a-z0-9+#._-]{1,20}$/.test(candidate) ? candidate : "";
}

function prose(body: string): BlockToken {
  const tokens: ProseToken[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (text.length > 0) tokens.push({ kind: "paragraph", inline: parseInline(text) });
  };

  const flushList = () => {
    if (items.length === 0) return;
    tokens.push({ kind: "list", items: items.map(parseInline) });
    items = [];
  };

  for (const line of body.split("\n")) {
    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      tokens.push({
        kind: "heading",
        level: Math.min(6, (heading[1] ?? "#").length),
        inline: parseInline((heading[2] ?? "").trim()),
      });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      items.push(bullet[1] ?? "");
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return { kind: "prose", tokens };
}

/**
 * Tokenise inline markup. Everything not matched stays literal text, which is
 * why `<script>` arrives here as four ordinary characters.
 */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  INLINE.lastIndex = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index;
    if (start > lastIndex) {
      tokens.push({ kind: "text", text: text.slice(lastIndex, start) });
    }
    const raw = match[0];
    if (raw.startsWith("`")) {
      tokens.push({ kind: "code", text: raw.slice(1, -1) });
    } else if (raw.startsWith("**")) {
      tokens.push({ kind: "strong", text: raw.slice(2, -2) });
    } else if (raw.startsWith("~~")) {
      tokens.push({ kind: "strike", text: raw.slice(2, -2) });
    } else {
      tokens.push({ kind: "em", text: raw.slice(1, -1) });
    }
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) {
    tokens.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return tokens;
}
