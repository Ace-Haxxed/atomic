/**
 * The boundary a compaction starts keeping verbatim messages from.
 *
 * This was picked with the wrong list once: the index comes from the filtered
 * model messages, and applying it to the raw history was correct only until a
 * conversation had been compacted for the first time. These cases are the two
 * lists disagreeing, which is the only situation the bug lived in.
 */

import { describe, expect, it } from "vitest";

import { survivingMessages, type StoredMessage } from "../storage/repositories.js";
import { compactionBoundary } from "./local.js";

/** A conversation already compacted once: 1-4 superseded, 5 the summary, 6+ live. */
const SURVIVING = [{ seq: 5 }, { seq: 6 }, { seq: 7 }, { seq: 8 }];
/** The same conversation unfiltered, as the repository returns it. */
const HISTORY = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }, ...SURVIVING];

describe("compactionBoundary", () => {
  it("returns the seq of the first message that stays", () => {
    expect(compactionBoundary(SURVIVING, 2)).toBe(7);
  });

  it("reads the filtered list, so a second compaction keeps the right turns", () => {
    // The bug: index 2 into the history is the old superseded message at seq 3,
    // which would have made the next compaction supersede messages 5 and 6 --
    // turns the user could still see and had not agreed to lose.
    expect(compactionBoundary(SURVIVING, 2)).toBe(7);
    expect(HISTORY[2]?.seq).toBe(3);
  });

  it("differs from the raw history in every position once rows are superseded", () => {
    // Guards the premise: if these two ever agreed again, the test above would
    // be passing for the wrong reason.
    expect(HISTORY.map((m) => m.seq)).not.toEqual(SURVIVING.map((m) => m.seq));
  });

  it("fails safe when the index is past the end, rather than dropping everything", () => {
    // `supersedeBefore` marks every row below the boundary, so a large
    // fallback would supersede the entire conversation and hide the bug. Zero
    // marks nothing. `planCompaction` cannot reach this, so it is a backstop.
    expect(compactionBoundary(SURVIVING, 99)).toBe(0);
    expect(compactionBoundary([], 0)).toBe(0);
  });

  it("keeps only the summary when the plan keeps nothing", () => {
    expect(compactionBoundary(SURVIVING, 0)).toBe(5);
  });
});

describe("survivingMessages", () => {
  const message = (seq: number, role: string, superseded = false) =>
    ({ seq, role, superseded, content: [] }) as unknown as StoredMessage;

  it("drops superseded turns and system instructions, keeping the seqs", () => {
    // The seq has to survive the filter: it is what the boundary is built from,
    // and `toModelMessages` deliberately drops it.
    const kept = survivingMessages([
      message(1, "system"),
      message(2, "user", true),
      message(3, "assistant", true),
      message(4, "user"),
    ]);
    expect(kept.map((m) => m.seq)).toEqual([4]);
  });

  it("agrees with the model message list on length, which is the whole point", () => {
    const history = [message(1, "user", true), message(2, "assistant"), message(3, "user")];
    expect(survivingMessages(history)).toHaveLength(2);
  });
});
