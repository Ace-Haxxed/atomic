/**
 * What a model costs, and which piece of evidence decided it.
 *
 * The bug these lock down: a reported price of `0/0` was being dropped by a
 * truthiness check, so the one authoritative free signal available was thrown
 * away. Every free model without "-free" in its id -- `big-pickle` above all --
 * read as `unknown`, and `unknown` is never eligible for free-only selection.
 * The user saw a working app that silently refused to use its free models.
 *
 * The four states are load-bearing. `unknown` is not a synonym for "paid" and
 * not a synonym for "free"; it is the only honest answer when nobody has said,
 * and under a free-only guarantee it excludes the model rather than guessing.
 */

import { describe, expect, it } from "vitest";

import {
  freenessFor,
  isFreeEnough,
  knownCost,
  type Freeness,
} from "./freeness.js";
import {
  buildModelInfo,
  readModelMetadata,
} from "../providers/zen/models-dev.js";
import {
  normalizeModelName,
  parseZenPricing,
} from "../providers/zen/published-pricing.js";
import type { ModelInfo } from "./provider.js";
import { providerById } from "../providers/registry.js";

/** A models.dev provider block with one model in it. */
function feed(
  models: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  return { models };
}

const ZEN_DEF = providerById("opencode-zen")!;

function modelFrom(id: string, entry: Record<string, unknown>): ModelInfo {
  return buildModelInfo(
    id,
    "openai-chat",
    readModelMetadata(feed({ [id]: entry }) as never, id, "openai-chat"),
  );
}

function classify(model: ModelInfo): Freeness {
  return freenessFor(ZEN_DEF, model).freeness;
}

describe("a reported zero price is a price", () => {
  it("classifies 0/0 as free", () => {
    // The regression. `input: 0` used to fail a truthiness guard and vanish.
    const model = modelFrom("big-pickle", {
      cost: { input: 0, output: 0 },
      tool_call: true,
    });
    expect(knownCost(model)).toEqual({ input: 0, output: 0 });
    expect(classify(model)).toBe("free");
  });

  it("keeps a real zero price even when only one direction is zero", () => {
    const model = modelFrom("half-free", { cost: { input: 0, output: 5 } });
    expect(knownCost(model)).toEqual({ input: 0, output: 5 });
    // Half-priced is paid. Reading `0` as "no data" here would be free money.
    expect(classify(model)).toBe("paid");
  });

  it("does not invent a price from an empty or null cost object", () => {
    // `jev-1.13-free` really is shaped like this upstream: an entry exists but
    // carries no numbers. That is "unpriced", not "free".
    const empty = modelFrom("jev-1.13-free", { cost: {} });
    expect(knownCost(empty)).toBeNull();

    const nulled = modelFrom("other", { cost: { input: null, output: null } });
    expect(knownCost(nulled)).toBeNull();
    expect(classify(nulled)).not.toBe("free");
  });

  it("classifies a real price as paid", () => {
    const model = modelFrom("claude-sonnet-5", {
      cost: { input: 2, output: 10 },
    });
    expect(classify(model)).toBe("paid");
  });
});

describe("signals are consulted in priority order", () => {
  it("prefers a published price over a free-looking name", () => {
    // A name is a convention, not a commitment. A real price always wins.
    const model = modelFrom("promo-free", { cost: { input: 3, output: 3 } });
    expect(classify(model)).toBe("paid");
  });

  it("prefers a published price over the provider's own table", () => {
    const model: ModelInfo = {
      ...modelFrom("x", {}),
      publishedPricing: {
        free: true,
        source: "docs",
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    modelFrom("x", { cost: { input: 4, output: 4 } });
    const priced = modelFrom("y", { cost: { input: 4, output: 4 } });
    const withDocs: ModelInfo = {
      ...priced,
      publishedPricing: {
        free: true,
        source: "docs",
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    // The feed says paid, so the docs table cannot make it free.
    expect(classify(withDocs)).toBe("paid");
    expect(model.publishedPricing).toBeDefined();
  });

  it("uses the provider's table when the feed has no price", () => {
    const model: ModelInfo = {
      ...modelFrom("unpriced", {}),
      publishedPricing: {
        free: true,
        source: "the docs",
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const detail = freenessFor(ZEN_DEF, model);
    expect(detail.freeness).toBe("free");
    expect(detail.signal).toBe("published");
    expect(detail.reason).toContain("the docs");
  });

  it("falls back to the name only when nothing is published", () => {
    const model = modelFrom("space-bunny-free", {});
    const detail = freenessFor(ZEN_DEF, model);
    expect(detail.freeness).toBe("free");
    expect(detail.signal).toBe("suffix");
    // The wording has to admit this is weaker, or the badge over-promises.
    expect(detail.reason).toMatch(/not published a price/i);
  });

  it("is unknown when every signal is silent", () => {
    const model = modelFrom("some-new-model", {});
    const detail = freenessFor(ZEN_DEF, model);
    expect(detail.freeness).toBe("unknown");
    expect(detail.signal).toBe("none");
  });
});

describe("the free-only filter", () => {
  it("excludes unknown, so a model nobody has priced is never picked for you", () => {
    expect(isFreeEnough("unknown", true)).toBe(false);
    expect(isFreeEnough("paid", true)).toBe(false);
    // A free *tier* is rate-limited and can be withdrawn, so it is not "free".
    expect(isFreeEnough("free-tier", true)).toBe(false);
    expect(isFreeEnough("free", true)).toBe(true);
  });

  it("lets everything through once the user has turned the filter off", () => {
    for (const state of ["free", "free-tier", "paid", "unknown"] as const) {
      expect(isFreeEnough(state, false)).toBe(true);
    }
  });
});

describe("reading Zen's published pricing table", () => {
  // Trimmed from the live page; the shape is what matters, not the contents.
  const HTML = `
    <h2 id="pricing">Pricing</h2>
    <p>prices <strong>per 1M tokens</strong></p>
    <table>
      <tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th></tr>
      <tr><td>Big Pickle</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
      <tr><td>Space Bunny Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
      <tr><td>Claude Sonnet 5</td><td>$3</td><td>$15</td><td>$0.30</td><td>$3.75</td></tr>
      <tr><td>Mystery &amp; Co</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr>
    </table>
    <h2 id="something-else">Next section</h2>
    <table>
      <tr><td>Not A Price</td><td>Free</td><td>Free</td></tr>
    </table>`;

  it("reads free rows and priced rows", () => {
    const parsed = parseZenPricing(HTML);
    expect(parsed).not.toBeNull();
    expect(parsed!.prices.get("bigpickle")).toEqual({ free: true });
    expect(parsed!.prices.get("spacebunnyfree")).toEqual({ free: true });
    expect(parsed!.prices.get("claudesonnet5")).toEqual({
      free: false,
      input: 3,
      output: 15,
    });
    // An ampersand must not break the row.
    expect(parsed!.prices.get("mysteryco")).toEqual({ free: true });
  });

  it("stops at the next heading, so a later table cannot invent prices", () => {
    // "Not A Price" only appears in the section *after* pricing.
    expect(parseZenPricing(HTML)!.prices.has("notaprice")).toBe(false);
  });

  it("returns nothing, rather than an empty verdict, when the markup changes", () => {
    // An empty map would be read as "no model is free", which is a claim. A
    // null is read as "no opinion", which is the truth.
    expect(
      parseZenPricing("<h2 id='pricing'>Pricing</h2><p>Coming soon.</p>"),
    ).toBeNull();
    expect(parseZenPricing("<html>the docs moved</html>")).toBeNull();
  });

  it("does not call a row free when only one direction is", () => {
    // A live row: `Jev 1.13` is listed as $0.042 input / Free output. The
    // companion `Jev 1.13 Free` is genuinely free. Reading the output column
    // alone -- or matching on the word "Free" anywhere in the row -- would put a
    // model that charges money into the free list, where free-only selection
    // would then pick it and bill the user.
    const parsed = parseZenPricing(`
      <h2 id="pricing">Pricing</h2>
      <tr><td>Jev 1.13</td><td>$0.042</td><td>Free</td><td>-</td><td>-</td></tr>
      <tr><td>Jev 1.13 Free</td><td>Free</td><td>Free</td><td>-</td><td>-</td></tr>`);
    expect(parsed!.prices.get("jev113")).toEqual({
      free: false,
      input: 0.042,
      output: 0,
    });
    expect(parsed!.prices.get("jev113free")).toEqual({ free: true });
  });

  it("ignores a cell that means 'not applicable', not 'free'", () => {
    const parsed = parseZenPricing(`
      <h2 id="pricing">Pricing</h2>
      <tr><td>Odd One</td><td>Free</td><td>Free</td><td>-</td><td>-</td></tr>`);
    expect(parsed!.prices.get("oddone")).toEqual({ free: true });
  });

  it("normalises names so punctuation and case do not break the join", () => {
    expect(normalizeModelName("MiMo-V2.6-Flash Free")).toBe("mimov26flashfree");
    expect(normalizeModelName("mimo v2.6 flash free")).toBe(
      normalizeModelName("MiMo-V2.6-Flash Free"),
    );
  });

  it("counts rows it could not read instead of skipping them silently", () => {
    const parsed = parseZenPricing(`
      <h2 id="pricing">Pricing</h2>
      <tr><td>Good One</td><td>Free</td><td>Free</td></tr>
      <tr><td>Bad One</td><td>upon request</td><td>upon request</td></tr>`);
    expect(parsed!.prices.size).toBe(1);
    expect(parsed!.unparsed).toBe(1);
  });
});

describe("the real catalog, end to end", () => {
  // Shapes captured from the live feeds, so a change upstream is visible here.
  it("classifies the models that were actually mislabelled", () => {
    const free = [
      "big-pickle",
      "deepseek-v4-flash-free",
      "muse-spark-1.3-contributor-free",
      "space-bunny-free",
      "longcat-2.5-preview-free",
      "nemotron-3-ultra-free",
    ];
    for (const id of free) {
      const model = modelFrom(id, {
        cost: { input: 0, output: 0, cache_read: 0 },
      });
      expect(classify(model), id).toBe("free");
    }
  });

  it("still resolves the one model the feed prices as an empty object", () => {
    // `jev-1.13-free` has `cost: {}` upstream: no numbers at all. Cost cannot
    // speak, so the name does -- and the reason says so.
    const model = modelFrom("jev-1.13-free", { cost: {} });
    const detail = freenessFor(ZEN_DEF, model);
    expect(detail.freeness).toBe("free");
    expect(detail.signal).toBe("suffix");
  });
});
