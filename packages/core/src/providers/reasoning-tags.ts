/**
 * Think-tag extraction for streams that put reasoning *inside* the content
 * channel.
 *
 * Many OpenAI-compatible models ignore `reasoning_content` and emit
 * `<think>first, then the answer</think>` as ordinary `content`. Fed to the
 * markdown renderer that is the worst possible failure: a half-arrived `<think>`
 * shows up as literal text, so the transcript flickers through raw tags and
 * fragments of the model's private notes before the closing tag lands.
 *
 * This splitter is stateful on purpose. The tag routinely straddles a chunk
 * boundary -- `<thi` then `nk>` then the reasoning then `</thi` then `nk>` --
 * and a per-chunk regex cannot see that. Text that could still grow into a tag
 * is therefore held back rather than emitted and then corrected, which is what
 * makes the output stable: nothing is ever shown and then rewritten.
 */

const OPEN_TAG = /<think\s*>/i;
// Whitespace after `</` is uncommon but real, and a regex that misses it turns the
// whole rest of the answer into reasoning.
const CLOSE_TAG = /<\/\s*think\s*>/i;
/** Longest prefix of either tag that is worth holding back. */
const MAX_HELD = "</think>".length;

export interface SplitDelta {
  /** Answer text, with think tags and their contents removed. */
  readonly text: string;
  /** Reasoning text, ready to show in a Thinking block. */
  readonly reasoning: string;
}

/** Stateful splitter. One per stream; call `push` per content delta. */
export interface ThinkTagSplitter {
  push(chunk: string): SplitDelta;
  /**
   * Releases anything still held back at end of stream.
   *
   * Must be called or a trailing partial tag -- or an unterminated block --
   * would be silently dropped from the saved message.
   */
  flush(): SplitDelta;
}

export function createThinkTagSplitter(): ThinkTagSplitter {
  let inThink = false;
  let held = "";

  return {
    push(chunk) {
      held += chunk;
      let text = "";
      let reasoning = "";

      for (;;) {
        const open = OPEN_TAG.exec(held);
        const close = CLOSE_TAG.exec(held);
        if (inThink) {
          if (!close) break;
          reasoning += held.slice(0, close.index);
          held = held.slice(close.index + close[0].length);
          inThink = false;
          continue;
        }
        // In text mode a closing tag with no opener is a stray: drop it rather
        // than render `</think>` as literal text in the answer.
        const first = earliest(open, close);
        if (!first) break;
        if (open && (!close || open.index <= close.index)) {
          text += held.slice(0, open.index);
          held = held.slice(open.index + open[0].length);
          inThink = true;
          continue;
        }
        text += held.slice(0, close!.index);
        held = held.slice(close!.index + close![0].length);
      }

      if (inThink) {
        // Hold back only what could still become a closing tag.
        const hold = heldTagSuffix(held);
        reasoning += held.slice(0, held.length - hold);
        held = held.slice(held.length - hold);
      } else {
        const hold = heldTagSuffix(held);
        text += held.slice(0, held.length - hold);
        held = held.slice(held.length - hold);
      }

      return { text, reasoning };
    },

    flush() {
      // An unterminated `<think>` still has real reasoning in it, and the model
      // stopped for another reason; losing it would hide why the answer looks
      // short. A leftover partial *opening* tag was never a tag, so it goes
      // back to the text where the user can see it.
      const text = inThink ? "" : held;
      const reasoning = inThink ? held : "";
      held = "";
      return { text, reasoning };
    },
  };
}

function earliest(
  a: RegExpExecArray | null,
  b: RegExpExecArray | null,
): RegExpExecArray | null {
  if (a && b) return a.index <= b.index ? a : b;
  return a ?? b;
}

/**
 * Length of the trailing run of `text` that is still a prefix of a think tag.
 *
 * This is what stops `2 <` from being emitted before we know whether the model
 * is about to type `<think>` or was writing a less-than sign.
 */
function heldTagSuffix(text: string): number {
  const lower = text.toLowerCase();
  const limit = Math.min(MAX_HELD, lower.length);
  for (let k = limit; k > 0; k -= 1) {
    const tail = lower.slice(lower.length - k);
    if ("<think>".startsWith(tail) || "</think>".startsWith(tail)) return k;
  }
  return 0;
}
