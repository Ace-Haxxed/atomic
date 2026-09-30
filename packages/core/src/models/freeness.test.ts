import { describe, expect, it } from "vitest";
import type { ModelInfo } from "./provider.js";
import { freenessFor, isFreeEnough, knownCost } from "./freeness.js";
import { providerById } from "../providers/registry.js";

/**
 * Fixtures recorded from real responses, not invented.
 *
 * `zero-cost` and `priced` are the exact `cost` objects models.dev returned for a
 * zero-cost model and a paid one. `unpriced` is the shape it returns for a model
 * it has no price for, which is the case that used to be mislabelled as free.
 */
const ZERO_COST_FIXTURE = { input: 0, output: 0 };
const PRICED_FIXTURE = { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 };
const UNPRICED_FIXTURE = {} as const;

function model(id: string, cost: { input: number; output: number } | undefined): ModelInfo {
  return {
    id,
    name: id,
    wireFormat: "openai-chat",
    capabilities: { tools: true, vision: false, reasoning: false, streaming: true, ...(cost ? { free: cost.input === 0 && cost.output === 0 } : {}) },
    ...(cost ? { cost: { input: cost.input, output: cost.output } } : {}),
  };
}

const zen = providerById("opencode-zen")!;
const openrouter = providerById("openrouter")!;
const ollama = providerById("ollama")!;
const gemini = providerById("google")!;
const openai = providerById("openai")!;

describe("freeness: OpenCode Zen", () => {
  it("calls a model with two zero prices free", () => {
    expect(freenessFor(zen, model("m", ZERO_COST_FIXTURE)).freeness).toBe("free");
  });

  it("calls a priced model paid", () => {
    const detail = freenessFor(zen, model("m", { input: PRICED_FIXTURE.input, output: PRICED_FIXTURE.output }));
    expect(detail.freeness).toBe("paid");
  });

  it("treats a missing price as unknown, never free", () => {
    // The bug this guards: a model with no cost data is not a free model.
    expect(freenessFor(zen, model("m", undefined)).freeness).toBe("unknown");
  });

  it("treats an empty cost object as unknown, not zero", () => {
    const empty = { input: Number.NaN, output: Number.NaN };
    expect(knownCost(model("m", empty))).toBeNull();
  });

  it("reports the price in its reason so the UI can show it", () => {
    const detail = freenessFor(zen, model("m", { input: 1, output: 5 }));
    expect(detail.reason).toContain("1");
    expect(detail.reason).toContain("5");
  });
});

describe("freeness: OpenRouter", () => {
  it("treats a 0/0 price string as free", () => {
    const m = {
      ...model("x", undefined),
      pricing: { prompt: "0", completion: "0" },
    } as ModelInfo & { pricing: unknown };
    expect(freenessFor(openrouter, m).freeness).toBe("free");
  });

  it("treats a nonzero price string as paid", () => {
    const m = {
      ...model("x", undefined),
      pricing: { prompt: "0.0000025", completion: "0.00001" },
    } as ModelInfo & { pricing: unknown };
    expect(freenessFor(openrouter, m).freeness).toBe("paid");
  });

  it("uses the :free suffix when OpenRouter reports no price", () => {
    const m = model("meta-llama/llama-3.3-70b-instruct:free", undefined);
    expect(freenessFor(openrouter, m).freeness).toBe("free");
  });

  it("stays unknown for an unpriced, unsuffixed model", () => {
    expect(freenessFor(openrouter, model("some/model", undefined)).freeness).toBe("unknown");
  });
});

describe("freeness: local and free-tier providers", () => {
  it("treats every local model as free", () => {
    expect(freenessFor(ollama, model("llama3", undefined)).freeness).toBe("free");
  });

  it("labels a documented free tier as free-tier, not free", () => {
    expect(freenessFor(gemini, model("gemini-flash", undefined)).freeness).toBe("free-tier");
  });

  it("labels a provider with no free tier as paid", () => {
    expect(freenessFor(openai, model("gpt-x", undefined)).freeness).toBe("paid");
  });
});

/**
 * The badge is a claim about one model, so the account-level tier is not enough
 * evidence to support it. It used to be: every Google, Groq and Mistral model in
 * the catalog was badged "free tier" whether or not that model had a price, so
 * a model published at $15 per million carried the same badge as one the vendor
 * gives away.
 */
describe("freeness: a free tier is not a per-model price", () => {
  const tiered = [
    ["google", "gemini-pro"],
    ["groq", "llama-3.3-70b"],
    ["mistral", "large-latest"],
  ] as const;

  for (const [providerId, modelId] of tiered) {
    const provider = providerById(providerId)!;

    it(`keeps ${providerId} off the free-tier badge when the model has a price`, () => {
      const detail = freenessFor(provider, model(modelId, { input: 15, output: 75 }));
      expect(detail.freeness).toBe("paid");
    });

    it(`calls a ${providerId} model published at $0 free, not free-tier`, () => {
      expect(freenessFor(provider, model(modelId, ZERO_COST_FIXTURE)).freeness).toBe("free");
    });

    it(`still reports the tier as context on a priced ${providerId} model`, () => {
      // The tier is real and worth saying; what it is not allowed to do is
      // override the price.
      const detail = freenessFor(provider, model(modelId, { input: 15, output: 75 }));
      expect(detail.reason).toContain("free tier");
      expect(detail.reason).toContain("15");
    });

    it(`uses the tier for an unpriced ${providerId} model`, () => {
      expect(freenessFor(provider, model(modelId, undefined)).freeness).toBe("free-tier");
    });
  }

  it("does not let a free tier satisfy a free-only guarantee", () => {
    // Unchanged by the above, and the reason the distinction matters: even a
    // legitimately free-tiered model is not something to auto-select.
    const provider = providerById("google")!;
    const detail = freenessFor(provider, model("gemini-flash", undefined));
    expect(detail.freeness).toBe("free-tier");
    expect(isFreeEnough(detail.freeness, true)).toBe(false);
  });
});

describe("isFreeEnough", () => {
  it("allows free models under a free-only policy", () => {
    expect(isFreeEnough("free", true)).toBe(true);
  });

  it("blocks free-tier models under a free-only policy", () => {
    expect(isFreeEnough("free-tier", true)).toBe(false);
  });

  it("allows free-tier models when free-only is off", () => {
    expect(isFreeEnough("free-tier", false)).toBe(true);
  });

  it("blocks paid and unknown models when free-only is on", () => {
    expect(isFreeEnough("paid", true)).toBe(false);
    expect(isFreeEnough("unknown", true)).toBe(false);
    expect(isFreeEnough("free-tier", true)).toBe(false);
  });

  it("allows any model once the user switches free-only off", () => {
    // Turning the filter off is the user stating that cost is not a constraint.
    expect(isFreeEnough("paid", false)).toBe(true);
    expect(isFreeEnough("unknown", false)).toBe(true);
  });
});

describe("models.dev cost parsing", () => {
  it("does not mark a model free when the registry omits cost", async () => {
    // Regression: num() returns 0 for a missing field, so a naive
    // `input === 0 && output === 0` check labelled every unpriced model free.
    const { readModelMetadata } = await import("../providers/zen/models-dev.js");
    const metadata = readModelMetadata(
      { models: { m: { id: "m", limit: { context: 1000 }, modalities: { input: ["text"], output: ["text"] } } } },
      "m",
      "openai-chat",
    );
    expect(metadata.capabilities?.free).not.toBe(true);
  });

  it("marks a model free when the registry reports two zeros", async () => {
    const { readModelMetadata } = await import("../providers/zen/models-dev.js");
    const metadata = readModelMetadata(
      { models: { m: { id: "m", cost: { input: 0, output: 0 }, limit: { context: 1000 } } } },
      "m",
      "openai-chat",
    );
    expect(metadata.capabilities?.free).toBe(true);
  });
});
