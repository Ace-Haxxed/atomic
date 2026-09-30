/**
 * Streaming tests for the OpenAI Chat Completions dialect.
 *
 * `fixtures/zen-space-bunny-free.sse` is a **verbatim capture** of a real
 * OpenCode Zen stream (model `space-bunny-free`, no credential, recorded
 * 2026-09-29) and is replayed here byte-for-byte. It is the only fixture in the
 * repo that is genuine provider output rather than a hand-written frame, and it
 * is included precisely because it contains the parts a hand-written frame
 * would have got wrong: a usage-only `choices: []` frame, a final frame that
 * carries both `finish_reason` and trailing content, non-ASCII characters, and
 * `reasoning_content` arriving in the same deltas as content.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HttpClient } from "../http.js";
import { createThinkTagSplitter } from "../reasoning-tags.js";
import type { StreamEvent } from "../../models/types.js";
import { streamChatCompletions } from "./openai-chat.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): Uint8Array {
  return readFileSync(join(FIXTURES, name));
}

/**
 * Serves `bytes` as the response body, split every `size` bytes so that frame
 * boundaries land mid-line and mid-character -- the case a buffered parser
 * would fail.
 */
function clientFor(bytes: Uint8Array, size = 7): HttpClient {
  return new HttpClient({
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += size) {
              controller.enqueue(bytes.subarray(i, i + size));
            }
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
}

function sseFrame(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function frames(...payloads: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(
    payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join(""),
  );
}

async function drain(events: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function textOf(events: readonly StreamEvent[]): string {
  return events
    .filter((e) => e.type === "text-delta")
    .map((e) => (e as { text: string }).text)
    .join("");
}

function reasoningOf(events: readonly StreamEvent[]): string {
  return events
    .filter((e) => e.type === "reasoning-delta")
    .map((e) => (e as { text: string }).text)
    .join("");
}

describe("a real captured Zen stream", () => {
  it("reconstructs the answer and the reasoning separately", async () => {
    const events = await drain(
      streamChatCompletions(
        {
          baseUrl: "https://opencode.ai/zen/v1",
          apiKey: "",
          http: clientFor(fixture("zen-space-bunny-free.sse")),
          providerId: "opencode-zen",
        },
        {
          providerId: "opencode-zen",
          model: "space-bunny-free",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "How many r's are in 'strawberry'? Think it through step by step, then give the final answer.",
                },
              ],
            },
          ],
        },
      ),
    );

    // Reasoning goes to the Thinking block, not the answer.
    expect(reasoningOf(events)).toContain("positions 3, 8, 9 = 3");
    expect(textOf(events)).toBe(
      "1. **straw** contains 1 **r**.  \n2. **berry** contains 2 **r**’s.  \n3. Total: 1 + 2 = **3 r’s**.",
    );
    // The two trailing spaces are a markdown hard break; a parser that trimmed
    // deltas would collapse the list into one paragraph.
    expect(textOf(events)).toContain("  \n");
    // The curly apostrophes are exactly what the provider sent.
    expect(textOf(events)).toContain("’");
  });

  it("survives the usage-only frame that follows the last content frame", async () => {
    // The capture ends with `choices: []` carrying usage, then a second
    // `choices: []` cost frame. Indexing `choices[0]` blindly throws here and
    // loses the whole completed message.
    const events = await drain(
      streamChatCompletions(
        {
          baseUrl: "https://opencode.ai/zen/v1",
          apiKey: "",
          http: clientFor(fixture("zen-space-bunny-free.sse")),
          providerId: "opencode-zen",
        },
        { providerId: "opencode-zen", model: "space-bunny-free", messages: [] },
      ),
    );
    const done = events.find((e) => e.type === "done") as
      | { finishReason: string; usage: { outputTokens: number; reasoningTokens?: number } }
      | undefined;
    expect(done?.finishReason).toBe("stop");
    expect(done?.usage.outputTokens).toBe(192);
    expect(done?.usage.reasoningTokens).toBe(149);
  });

  it("produces the same result at one byte per chunk", async () => {
    // Pathological framing: every byte is its own network chunk, so multi-byte
    // characters and frames are split as much as the format allows.
    const at = async (size: number) =>
      textOf(
        await drain(
          streamChatCompletions(
            {
              baseUrl: "https://opencode.ai/zen/v1",
              apiKey: "",
              http: clientFor(fixture("zen-space-bunny-free.sse"), size),
              providerId: "opencode-zen",
            },
            { providerId: "opencode-zen", model: "space-bunny-free", messages: [] },
          ),
        ),
      );
    expect(await at(1)).toBe(await at(7));
    expect(await at(1)).toBe(await at(4096));
  });

  it("keeps the trailing content of the final finish_reason frame", async () => {
    // The last content frame carries `finish_reason: "stop"` and text at the
    // same time. Returning on the finish reason would truncate the answer.
    const events = await drain(
      streamChatCompletions(
        {
          baseUrl: "https://opencode.ai/zen/v1",
          apiKey: "",
          http: clientFor(fixture("zen-space-bunny-free.sse")),
          providerId: "opencode-zen",
        },
        { providerId: "opencode-zen", model: "space-bunny-free", messages: [] },
      ),
    );
    expect(textOf(events)).toContain("3 r’s**.");
  });
});

describe("reasoning fields", () => {
  it("reads OpenRouter's `delta.reasoning`", async () => {
    const body = frames(
      { choices: [{ delta: { reasoning: "step one" } }] },
      { choices: [{ delta: { content: "answer" } }] },
    );
    const events = await drain(
      streamChatCompletions(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "k",
          http: clientFor(body),
          providerId: "p",
        },
        { providerId: "p", model: "m", messages: [] },
      ),
    );
    expect(reasoningOf(events)).toBe("step one");
    expect(textOf(events)).toBe("answer");
  });

  it("prefers reasoning_content when a frame carries both", async () => {
    const frame = sseFrame({
      choices: [
        {
          delta: { reasoning: "openrouter", reasoning_content: "zen" },
        },
      ],
    });
    const events = await drain(
      streamChatCompletions(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "k",
          http: clientFor(frame),
          providerId: "p",
        },
        { providerId: "p", model: "m", messages: [] },
      ),
    );
    // Two different spellings of the same field; concatenating both would
    // duplicate the reasoning.
    expect(reasoningOf(events)).toBe("zen");
  });
});

describe("inline think tags", () => {
  async function run(chunks: readonly string[]): Promise<{ text: string; reasoning: string }> {
    const body = frames(...chunks.map((content) => ({ choices: [{ delta: { content } }] })));
    const events = await drain(
      streamChatCompletions(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "k",
          http: clientFor(body, 3),
          providerId: "p",
        },
        { providerId: "p", model: "m", messages: [] },
      ),
    );
    return { text: textOf(events), reasoning: reasoningOf(events) };
  }

  it("moves inline reasoning out of the answer and into the saved message", async () => {
    // The shape a DeepSeek-style model produces on an OpenAI-compatible route.
    const result = await run(["<think>count the r's</think>", "There are ", "3."]);
    expect(result).toEqual({ text: "There are 3.", reasoning: "count the r's" });
  });

  it("never emits a partial tag as text", async () => {
    const splitter = createThinkTagSplitter();
    // A tag arriving 4 bytes at a time: nothing may be shown until it is known
    // to be text, or the transcript flickers through raw tags.
    let shown = "";
    for (const piece of ["<thi", "nk>rea", "soning</thi", "nk>final"]) {
      shown += splitter.push(piece).text;
    }
    shown += splitter.flush().text;
    expect(shown).toBe("final");
    expect(shown).not.toContain("<");
  });

  it("keeps reasoning that the model emitted but never closed", async () => {
    // Silently dropping it would leave the user with a short answer and no idea
    // why.
    // Chunks concatenate with no separator, as the wire delivers them; the
    // space belongs inside one of them.
    const result = await run(["<think>started, then ran ", "out of tokens"]);
    expect(result.reasoning).toBe("started, then ran out of tokens");
  });
});

describe("finish reasons", () => {
  it("reports a length finish so the UI can offer Continue", async () => {
    const frame = sseFrame({
      choices: [{ delta: { content: "partial" }, finish_reason: "length" }],
    });
    const events = await drain(
      streamChatCompletions(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "k",
          http: clientFor(frame),
          providerId: "p",
        },
        { providerId: "p", model: "m", messages: [] },
      ),
    );
    const done = events.find((e) => e.type === "done") as
      | { finishReason: string }
      | undefined;
    // Without this the run looks like a normal completion and the answer just
    // stops mid-sentence with no explanation.
    expect(done?.finishReason).toBe("length");
  });
});
