import { describe, expect, it } from "vitest";
import type { ModelInfo } from "./provider.js";
import { formatTokens, rankModels, selectAutoModel } from "./model-ranking.js";
import { providerById } from "../providers/registry.js";

const NOW = Date.parse("2026-09-28T00:00:00Z");

function model(partial: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    ...partial,
    id: partial.id,
    name: partial.name ?? partial.id,
    wireFormat: partial.wireFormat ?? "openai-chat",
    // Merged, not replaced: a test that only cares about `tools` should not
    // accidentally also drop streaming and fail for the wrong reason.
    capabilities: {
      tools: true,
      vision: false,
      reasoning: false,
      streaming: true,
      contextWindow: 128_000,
      ...partial.capabilities,
    },
  };
}

const zen = providerById("opencode-zen")!;
const ollama = providerById("ollama")!;
const chat = { provider: zen, mode: "chat" as const, onlyFree: false, now: NOW };
const code = { provider: zen, mode: "code" as const, onlyFree: false, now: NOW };

describe("ranking eligibility", () => {
  it("excludes a model that cannot call tools from code mode", () => {
    const noTools = model({ id: "m", capabilities: { tools: false } });
    expect(rankModels([noTools], code).ranked).toHaveLength(0);
    expect(rankModels([noTools], code).excluded[0]?.reason).toContain("call tools");
  });

  it("still allows a tool-less model in chat", () => {
    const noTools = model({ id: "m", capabilities: { tools: false } });
    expect(rankModels([noTools], chat).ranked).toHaveLength(1);
  });

  it("excludes embedding, audio and image models by family", () => {
    const catalog = [
      model({ id: "text-embed-3-large" }),
      model({ id: "whisper-large-v3" }),
      model({ id: "dall-e-3" }),
    ];
    const result = rankModels(catalog, chat);
    expect(result.ranked).toHaveLength(0);
    expect(result.excluded).toHaveLength(3);
  });

  it("excludes a non-streaming model", () => {
    const result = rankModels([model({ id: "m", capabilities: { streaming: false } })], chat);
    expect(result.ranked).toHaveLength(0);
  });

  it("does not exclude a model merely because its name is unfamiliar", () => {
    // Only clearly non-chat families are filtered. Guessing further would drop
    // a capable new model the day it ships.
    const result = rankModels([model({ id: "some-new-thing-9000" })], chat);
    expect(result.ranked).toHaveLength(1);
  });
});

describe("ranking order", () => {
  it("prefers a free model over an equally capable paid one", () => {
    const free = model({ id: "free-one", cost: { input: 0, output: 0 } });
    const paid = model({ id: "paid-one", cost: { input: 5, output: 25 } });
    const [first] = rankModels([paid, free], chat).ranked;
    expect(first?.model.id).toBe("free-one");
  });

  it("prefers the larger context window when everything else matches", () => {
    const small = model({ id: "small", capabilities: { contextWindow: 8_000 } });
    const large = model({ id: "large", capabilities: { contextWindow: 1_000_000 } });
    const [first] = rankModels([small, large], chat).ranked;
    expect(first?.model.id).toBe("large");
  });

  it("weights reasoning higher in code mode than in chat mode", () => {
    const reasoner = model({ id: "reasoner", capabilities: { reasoning: true } });
    const plain = model({ id: "plain" });
    const inCode = rankModels([plain, reasoner], code).ranked;
    const inChat = rankModels([plain, reasoner], chat).ranked;
    // Both should put the reasoner first, but the *margin* must be larger in code.
    expect(inCode[0]?.model.id).toBe("reasoner");
    const codeMargin = inCode[0]!.score - inCode[1]!.score;
    const chatMargin = inChat[0]!.score - inChat[1]!.score;
    expect(codeMargin).toBeGreaterThan(chatMargin);
  });

  it("penalises preview and deprecated models below stable ones", () => {
    const stable = model({ id: "model-stable", cost: { input: 1, output: 1 } });
    const preview = model({ id: "model-preview", cost: { input: 1, output: 1 } });
    const dead = model({ id: "model-deprecated", cost: { input: 1, output: 1 } });
    const order = rankModels([dead, preview, stable], chat).ranked.map((entry) => entry.model.id);
    expect(order[0]).toBe("model-stable");
    expect(order.indexOf("model-stable")).toBeLessThan(order.indexOf("model-preview"));
    expect(order.indexOf("model-preview")).toBeLessThan(order.indexOf("model-deprecated"));
  });

  it("prefers a newer model over an older one of equal cost and size", () => {
    const old = model({ id: "old", releaseDate: "2020-01-01" });
    const recent = model({ id: "recent", releaseDate: "2026-06-01" });
    const [first] = rankModels([old, recent], chat).ranked;
    expect(first?.model.id).toBe("recent");
  });

  it("reports a reason and factors for the winner", () => {
    const result = selectAutoModel(
      [model({ id: "m", cost: { input: 0, output: 0 }, capabilities: { contextWindow: 200_000, tools: true, reasoning: true } })],
      { ...chat, onlyFree: true },
    );
    expect(result.chosen?.reason).toBeTruthy();
    const labels = result.chosen?.factors.map((factor) => factor.label) ?? [];
    expect(labels).toContain("Context");
    expect(labels).toContain("Cost");
  });
});

describe("free-only policy", () => {
  const paid = model({ id: "paid", cost: { input: 3, output: 15 } });
  const free = model({ id: "free", cost: { input: 0, output: 0 } });
  const unpriced = model({ id: "unpriced" });

  it("picks the free model when one exists", () => {
    const result = selectAutoModel([paid, free, unpriced], { ...chat, onlyFree: true });
    expect(result.chosen?.model.id).toBe("free");
    expect(result.needsPaidConfirmation).toBe(false);
  });

  it("never auto-picks an unpriced model, even unconstrained", () => {
    const result = selectAutoModel([unpriced], { ...chat, onlyFree: true });
    expect(result.chosen).toBeNull();
  });

  it("asks for confirmation instead of silently spending money", () => {
    const result = selectAutoModel([paid], { ...chat, onlyFree: true });
    expect(result.chosen).toBeNull();
    expect(result.needsPaidConfirmation).toBe(true);
    expect(result.cheapestPaid?.model.id).toBe("paid");
    expect(result.emptyReason).toContain("No free model");
  });

  it("offers the cheapest paid model as the fallback hint", () => {
    const pricey = model({ id: "pricey", cost: { input: 30, output: 150 } });
    const result = selectAutoModel([pricey, paid], { ...chat, onlyFree: true });
    expect(result.cheapestPaid?.model.id).toBe("paid");
  });

  it("selects a paid model when free-only is off", () => {
    const result = selectAutoModel([paid, free], { ...chat, onlyFree: false });
    expect(result.chosen?.freeness).toBe("free");
  });
});

describe("local provider", () => {
  it("treats installed local models as free and selectable", () => {
    const result = selectAutoModel([model({ id: "llama3.2:3b" })], {
      provider: ollama,
      mode: "code",
      onlyFree: true,
      now: NOW,
    });
    expect(result.chosen?.freeness).toBe("free");
    expect(result.needsPaidConfirmation).toBe(false);
  });
});

describe("fallback list", () => {
  it("excludes the chosen model from the fallback list", () => {
    const catalog = [
      model({ id: "a", cost: { input: 0, output: 0 } }),
      model({ id: "b", cost: { input: 0, output: 0 } }),
      model({ id: "c", cost: { input: 0, output: 0 } }),
    ];
    const result = selectAutoModel(catalog, { ...chat, onlyFree: true });
    expect(result.chosen?.model.id).toBe(result.ranked[0]?.model.id);
    expect(result.fallbacks.map((entry) => entry.model.id)).not.toContain(result.chosen?.model.id);
    expect(result.fallbacks).toHaveLength(2);
  });

  it("orders fallbacks from the same ranked list", () => {
    const catalog = [
      model({ id: "a", cost: { input: 0, output: 0 } }),
      model({ id: "b", cost: { input: 0, output: 0 } }),
    ];
    const result = selectAutoModel(catalog, { ...chat, onlyFree: true });
    expect(result.fallbacks.map((entry) => entry.model.id)).toEqual(
      result.ranked.slice(1).map((entry) => entry.model.id),
    );
  });
});

describe("formatTokens", () => {
  it("formats in a way a person reads", () => {
    expect(formatTokens(8_000)).toBe("8k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(0)).toBe("unknown");
  });
});
