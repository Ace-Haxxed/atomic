import { describe, expect, it } from "vitest";

import { createThinkTagSplitter } from "./reasoning-tags.js";

function run(chunks: readonly string[]): { text: string; reasoning: string } {
  const splitter = createThinkTagSplitter();
  let text = "";
  let reasoning = "";
  for (const chunk of chunks) {
    const delta = splitter.push(chunk);
    text += delta.text;
    reasoning += delta.reasoning;
  }
  const tail = splitter.flush();
  return { text: text + tail.text, reasoning: reasoning + tail.reasoning };
}

describe("think-tag splitting", () => {
  it("routes a whole block to reasoning and leaves the answer clean", () => {
    expect(run(["<think>hmm, maybe 3</think>", "The answer is 3."])).toEqual({
      text: "The answer is 3.",
      reasoning: "hmm, maybe 3",
    });
  });

  /**
   * The case a per-chunk regex gets wrong: `</thi` has no closing tag yet, so a
   * naive strip renders it as literal text and the answer then changes when the
   * rest of the tag arrives. Here the tag is split three ways and the answer
   * must come out identical to the unsplit case.
   */
  it("reassembles a closing tag split across chunks", () => {
    expect(run(["<think>a</think>ans", "wer"])).toEqual({ text: "answer", reasoning: "a" });
    const parts = ["<thi", "nk>thin", "king</thi", "nk>fi", "nal"];
    expect(run(parts)).toEqual({ text: "final", reasoning: "thinking" });
  });

  it("reassembles an opening tag split across chunks", () => {
    expect(run(["<th", "ink>why", "</thin", "k>because"])).toEqual({
      text: "because",
      reasoning: "why",
    });
  });

  it("handles a block split to one character per chunk", () => {
    const whole = "<think>x</think>done";
    const chars = whole.split("");
    expect(run(chars)).toEqual(run([whole]));
    expect(run(chars)).toEqual({ text: "done", reasoning: "x" });
  });

  it("drops a stray closing tag instead of showing it as text", () => {
    // An orphan `</think>` in the answer would render as literal junk.
    expect(run(["answer</think>more"])).toEqual({ text: "answermore", reasoning: "" });
  });

  it("keeps a less-than sign that is not a tag", () => {
    // The dangerous case for tag stripping: real prose with `<` and `>` in it.
    expect(run(["if a < b and c > d then"])).toEqual({
      text: "if a < b and c > d then",
      reasoning: "",
    });
  });

  it("holds back a dangling partial tag until the stream ends", () => {
    // Ends mid-tag. Dropping it would lose text the model actually emitted.
    expect(run(["answer<th"])).toEqual({ text: "answer<th", reasoning: "" });
  });

  it("keeps reasoning from an unterminated block rather than losing it", () => {
    // The model stopped mid-thought. Hiding the reason the answer looks short
    // is worse than showing a block that never closed.
    // Chunks concatenate with no separator, exactly as the wire delivers them.
    expect(run(["<think>started but never", " finished"])).toEqual({
      text: "",
      reasoning: "started but never finished",
    });
  });

  it("handles several blocks in one stream", () => {
    expect(run(["<think>one</think>a<think>two</think>b"])).toEqual({
      text: "ab",
      reasoning: "onetwo",
    });
  });

  it("accepts whitespace and casing inside the tag", () => {
    expect(run(["<THINK >a</ Think >b"])).toEqual({ text: "b", reasoning: "a" });
  });

  it("preserves markdown hard breaks around a block", () => {
    // The real Zen stream ends its content with two-space hard breaks; a
    // splitter that trimmed would silently break the list rendering.
    expect(run(["<think>r</think>line one  \nline two"])).toEqual({
      text: "line one  \nline two",
      reasoning: "r",
    });
  });

  it("emits nothing for a chunk that is entirely a partial tag", () => {
    const splitter = createThinkTagSplitter();
    expect(splitter.push("<th")).toEqual({ text: "", reasoning: "" });
    expect(splitter.push("ink>hi</th")).toEqual({ text: "", reasoning: "hi" });
    expect(splitter.push("ink>ok")).toEqual({ text: "ok", reasoning: "" });
    expect(splitter.flush()).toEqual({ text: "", reasoning: "" });
  });

  it("does not double-count a tag when the stream is flushed twice", () => {
    const splitter = createThinkTagSplitter();
    splitter.push("<think>a</think>b");
    expect(splitter.flush()).toEqual({ text: "", reasoning: "" });
    expect(splitter.flush()).toEqual({ text: "", reasoning: "" });
  });
});
