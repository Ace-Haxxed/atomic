/**
 * The parser is the app's XSS boundary, so its most important test is that
 * markup in a model response is returned as data, never as structure.
 */

import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown, type BlockToken } from "./markdown-parse.js";

const prose = (block: BlockToken | undefined) => {
  if (!block || block.kind !== "prose") throw new Error("expected a prose block");
  return block.tokens;
};

const only = (source: string): BlockToken => {
  const blocks = parseMarkdown(source);
  expect(blocks).toHaveLength(1);
  return blocks[0]!;
};

describe("parseInline", () => {
  it("keeps HTML as literal text", () => {
    const tokens = parseInline('<script>alert("xss")</script>');
    expect(tokens).toEqual([{ kind: "text", text: '<script>alert("xss")</script>' }]);
  });

  it("keeps an HTML attribute-looking string as text", () => {
    const tokens = parseInline('<img src=x onerror=alert(1)>');
    expect(tokens.every((token) => token.kind === "text")).toBe(true);
    expect(tokens.map((token) => (token as { text: string }).text).join("")).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });

  it("splits code, strong, emphasis and strikethrough", () => {
    expect(parseInline("a `b` **c** *d* ~~e~~")).toEqual([
      { kind: "text", text: "a " },
      { kind: "code", text: "b" },
      { kind: "text", text: " " },
      { kind: "strong", text: "c" },
      { kind: "text", text: " " },
      { kind: "em", text: "d" },
      { kind: "text", text: " " },
      { kind: "strike", text: "e" },
    ]);
  });

  it("does not let markup hide inside a code span", () => {
    const tokens = parseInline("`<b>not bold</b>`");
    expect(tokens).toEqual([{ kind: "code", text: "<b>not bold</b>" }]);
  });

  it("leaves an unterminated code span as text", () => {
    expect(parseInline("`open")).toEqual([{ kind: "text", text: "`open" }]);
  });

  it("preserves text either side of the last token", () => {
    const tokens = parseInline("tail `x` tail");
    expect(tokens[0]).toEqual({ kind: "text", text: "tail " });
    expect(tokens.at(-1)).toEqual({ kind: "text", text: " tail" });
  });
});

describe("parseMarkdown", () => {
  it("extracts a fenced code block with its language", () => {
    const blocks = parseMarkdown("before\n\n```ts\nconst a = 1;\n```\n\nafter");
    expect(blocks.map((block) => block.kind)).toEqual(["prose", "code", "prose"]);
    const code = blocks[1];
    expect(code).toEqual({ kind: "code", language: "ts", body: "const a = 1;" });
  });

  it("supports tilde fences", () => {
    const blocks = parseMarkdown("~~~python\nprint(1)\n~~~");
    expect(blocks[0]).toEqual({ kind: "code", language: "python", body: "print(1)" });
  });

  it("reports no language when the info string is a JSON payload", () => {
    // ```{...} is how models fence JSON; showing the payload as the language
    // would be noise on the code block's header.
    const blocks = parseMarkdown('~~~{"a":1}\n{}\n~~~');
    expect(blocks[0]).toEqual({ kind: "code", language: "", body: "{}" });
  });

  it("accepts a braced language tag", () => {
    const blocks = parseMarkdown("```{rust}\nfn main() {}\n```");
    expect(blocks[0]).toMatchObject({ kind: "code", language: "rust" });
  });

  it("closes a fence that is never closed, keeping the rest as code", () => {
    const blocks = parseMarkdown("```\nstill code");
    expect(blocks).toEqual([{ kind: "code", language: "", body: "still code" }]);
  });

  it("groups headings, lists and paragraphs in order", () => {
    const tokens = prose(only("# Title\n\n- one\n- two\n\nBody text"));
    expect(tokens.map((token) => token.kind)).toEqual([
      "heading",
      "list",
      "paragraph",
    ]);
    const heading = tokens[0]!;
    expect(heading).toMatchObject({ kind: "heading", level: 1 });
    const list = tokens[1]!;
    expect(list).toMatchObject({ kind: "list" });
    expect(list.kind === "list" && list.items).toHaveLength(2);
  });

  it("clamps a deep heading to six levels", () => {
    const tokens = prose(only("####### too deep"));
    expect(tokens[0]).toMatchObject({ kind: "heading", level: 6 });
  });

  it("keeps a javascript: URL as text", () => {
    const tokens = parseInline("[click](javascript:alert(1))");
    expect(tokens.every((token) => token.kind !== "strong")).toBe(true);
    expect(JSON.stringify(tokens)).toContain("javascript:alert(1)");
  });

  it("returns nothing for an empty document", () => {
    expect(parseMarkdown("")).toEqual([]);
  });

  it("does not treat an unclosed fence at the top level as prose", () => {
    const blocks = parseMarkdown("intro\n```\ncode\n```");
    expect(blocks.map((block) => block.kind)).toEqual(["prose", "code"]);
    expect(prose(blocks[0])[0]!.kind).toBe("paragraph");
  });
});
