/**
 * `addUsage`, which is where a reported charge used to disappear.
 *
 * The field did not exist when this function was written, so summing simply
 * dropped it -- and every multi-step run routes its usage through here before
 * the cost guard sees it. The result was that a charge the provider reported was
 * lost at the first tool call or compaction, which is to say on exactly the
 * longer runs where the number mattered.
 *
 * These are the only tests that catch that, because a single-step run never
 * calls this function with a non-empty `b`.
 */

import { describe, expect, it } from "vitest";

import { addUsage, EMPTY_USAGE, type Usage } from "./types.js";

function usage(over: Partial<Usage> = {}): Usage {
  return { inputTokens: 10, outputTokens: 20, totalTokens: 30, ...over };
}

describe("addUsage", () => {
  it("adds tokens", () => {
    expect(addUsage(usage(), usage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }))).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 33,
    });
  });

  it("adds the two reported charges rather than keeping the last", () => {
    // Money accumulates. Keeping only the later step would understate a run
    // that made several calls, which is the case a guard exists to catch.
    expect(
      addUsage(usage({ reportedCost: 0.25 }), usage({ reportedCost: 0.5 })).reportedCost,
    ).toBeCloseTo(0.75, 10);
  });

  it("keeps a single reported charge when only one side has one", () => {
    expect(addUsage(usage({ reportedCost: 0.25 }), usage()).reportedCost).toBe(0.25);
    expect(addUsage(usage(), usage({ reportedCost: 0.25 })).reportedCost).toBe(0.25);
  });

  it("leaves the field absent when neither side reported a cost", () => {
    // Absent is not zero. A reported zero is a free turn; an unreported cost is
    // not known, and the guard treats the two differently.
    expect("reportedCost" in addUsage(usage(), usage())).toBe(false);
    expect("reportedCost" in addUsage(usage(), EMPTY_USAGE)).toBe(false);
  });

  it("does not invent a charge from an empty accumulator", () => {
    // Compaction adds an empty step. If that produced a reported 0 the model
    // would be recorded as observed-free on no evidence.
    expect("reportedCost" in addUsage(EMPTY_USAGE, EMPTY_USAGE)).toBe(false);
  });
});
