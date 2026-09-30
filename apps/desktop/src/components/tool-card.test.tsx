/**
 * The diff is the part of the UI a user trusts most: it is how they check what
 * the agent did to their files. A diff that misaligns lines is worse than no
 * diff, so the cases below are chosen for where alignment algorithms normally
 * go wrong -- not just for the happy path.
 */

import { describe, expect, it } from "vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { ToolCard } from "./tool-card.js";

/** The rendered diff as `["+ one", "- two"]` markers plus their text. */
function renderedRows(html: string): { mark: string; text: string }[] {
  return [...html.matchAll(/<span class="w-3[^"]*"[^>]*>([+ -])?<\/span><span class="w-8[^"]*"[^>]*>[\d]*<\/span><span class="w-8[^"]*"[^>]*>[\d]*<\/span><span class="pl-2[^"]*">([^<]*)<\/span>/g)].map((m) => ({
    mark: m[1] ?? " ",
    text: m[2] ?? "",
  }));
}

const text = (rows: { text: string }[]) => rows.map((row) => row.text);
const changed = (rows: { mark: string }[]) => rows.filter((row) => row.mark !== " ").map((row) => row.mark);

function render(before: string, after: string) {
  return renderToStaticMarkup(
    <ToolCard toolName="edit_file" display={{ kind: "file-edit", path: "a.ts", before, after, occurrences: 1 }} />,
  );
}

describe("tool card diff", () => {
  it("marks only the lines that actually changed", () => {
    const rows = renderedRows(render("one\ntwo\nthree", "one\ntwo point five\nthree"));
    expect(text(rows)).toEqual(["one", "two", "two point five", "three"]);
    expect(changed(rows)).toEqual(["-", "+"]);
  });

  it("keeps repeated lines aligned instead of pairing the wrong copies", () => {
    // The classic failure: "x" appears many times, so a greedy matcher pairs
    // the first removal with the first addition and shows a whole-file rewrite.
    const rows = renderedRows(render("x\nx\nx\nx\nkeep", "x\nx\nx\nkeep"));
    // Four "x" lines are printed, but only one of them is a removal: the other
    // three are untouched context. A matcher that paired the wrong copies would
    // show four removals and four additions instead.
    expect(changed(rows)).toEqual(["-"]);
    expect(text(rows)).toEqual(["x", "x", "x", "x", "keep"]);
  });

  it("shows a real insertion as an addition, not a replacement of everything", () => {
    const rows = renderedRows(render("a\nb", "a\nb\nc"));
    expect(text(rows)).toEqual(["a", "b", "c"]);
    expect(changed(rows)).toEqual(["+"]);
  });

  it("handles a pure deletion", () => {
    const rows = renderedRows(render("a\nb\nc", "a\nc"));
    expect(text(rows)).toEqual(["a", "b", "c"]);
    expect(changed(rows)).toEqual(["-"]);
  });

  it("handles an empty file becoming content", () => {
    const rows = renderedRows(render("", "a\nb"));
    expect(text(rows)).toEqual(["a", "b"]);
    expect(changed(rows)).toEqual(["+", "+"]);
  });

  it("reports a no-op as no change", () => {
    expect(renderToStaticMarkup(<ToolCard toolName="edit_file" display={{ kind: "file-edit", path: "a.ts", before: "same\n", after: "same\n", occurrences: 1 }} />)).toContain("No change in content");
  });
});

describe("tool card payload tolerance", () => {
  const render = (display: unknown) => renderToStaticMarkup(<ToolCard toolName="t" display={display} />);

  it("renders nothing for a payload it does not understand", () => {
    expect(render({ kind: "future-thing" })).toBe("");
    expect(render("a string")).toBe("");
    expect(render(null)).toBe("");
    expect(render(undefined)).toBe("");
    expect(render([1, 2, 3])).toBe("");
  });

  it("does not crash on a half-written payload from an older build", () => {
    // A finished transcript must stay readable even if a display payload is
    // missing fields, so every field read is defensive.
    expect(render({ kind: "bash", command: "npm test" })).toContain("npm test");
    expect(render({ kind: "bash" })).toContain("No output");
    expect(render({ kind: "file-write" })).toContain("wrote");
    expect(render({ kind: "todos" })).toContain("0/0 done");
    // Contentless steps are dropped rather than shown as blank checkboxes.
    expect(render({ kind: "todos", todos: ["nope", null, { status: "completed" }] })).toContain("0/0 done");
    expect(render({ kind: "todos", todos: ["nope", null, { status: "completed" }] })).not.toContain("<li");
  });
});

describe("bash card", () => {
  const render = (display: unknown) => renderToStaticMarkup(<ToolCard toolName="bash" display={display} />);

  it("shows the command, exit code, duration and both streams", () => {
    const html = render({
      kind: "bash",
      command: "npm test",
      exitCode: 0,
      durationMs: 1234,
      stdout: "3 passing",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
    expect(html).toContain("npm test");
    expect(html).toContain("exit 0");
    expect(html).toContain("1.2s");
    expect(html).toContain("3 passing");
  });

  it("marks a failure as an error rather than a success", () => {
    const html = render({ kind: "bash", command: "false", exitCode: 1, stdout: "", stderr: "boom" });
    expect(html).toContain("exit 1");
    expect(html).toContain("boom");
  });

  it("surfaces truncation instead of pretending the output was complete", () => {
    expect(render({ kind: "bash", command: "ls", exitCode: 0, truncated: true })).toContain("truncated");
  });
});

describe("todo card", () => {
  it("shows progress and marks the completed steps", () => {
    const html = renderToStaticMarkup(
      <ToolCard
        toolName="todo_write"
        display={{
          kind: "todos",
          todos: [
            { content: "read the code", status: "completed" },
            { content: "write the code", status: "in_progress" },
            { content: "run the tests", status: "pending" },
          ],
        }}
      />,
    );
    expect(html).toContain("1/3 done");
    expect(html).toContain("read the code");
    expect(html).toContain("line-through");
  });
});
