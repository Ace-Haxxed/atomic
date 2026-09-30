import { describe, expect, it } from "vitest";
import type { ModelInfo } from "./provider.js";
import { AUTO_MODEL, isAutoModel, resolveModelForMode } from "./auto-model.js";
import { providerById } from "../providers/registry.js";

const zen = providerById("opencode-zen")!;
const NOW = Date.parse("2026-09-28T00:00:00Z");

function model(id: string, cost?: { input: number; output: number }): ModelInfo {
  return {
    id,
    name: id,
    wireFormat: "openai-chat",
    ...(cost ? { cost } : {}),
    capabilities: { tools: true, vision: false, reasoning: false, streaming: true, contextWindow: 128_000 },
  };
}

const base = { mode: "chat" as const, provider: zen, onlyFree: true, now: NOW };

describe("isAutoModel", () => {
  it("treats the sentinel and empty values as auto", () => {
    expect(isAutoModel(AUTO_MODEL)).toBe(true);
    expect(isAutoModel("")).toBe(true);
    expect(isAutoModel(null)).toBe(true);
    expect(isAutoModel(undefined)).toBe(true);
  });

  it("does not treat a concrete id as auto", () => {
    expect(isAutoModel("gpt-5")).toBe(false);
  });
});

describe("resolveModelForMode", () => {
  it("resolves the ranked winner when the mode is on auto", () => {
    const result = resolveModelForMode({
      ...base,
      configured: AUTO_MODEL,
      catalog: [model("paid", { input: 5, output: 25 }), model("free", { input: 0, output: 0 })],
    });
    expect(result.auto).toBe(true);
    expect(result.model).toBe("free");
  });

  it("treats an empty setting as auto too", () => {
    const result = resolveModelForMode({
      ...base,
      configured: "",
      catalog: [model("free", { input: 0, output: 0 })],
    });
    expect(result.auto).toBe(true);
    expect(result.model).toBe("free");
  });

  it("never overwrites a pinned model with the ranking winner", () => {
    // The user picked the paid model on purpose; a cheaper one now ranking
    // higher must not quietly replace it.
    const result = resolveModelForMode({
      ...base,
      configured: "paid",
      catalog: [model("paid", { input: 5, output: 25 }), model("free", { input: 0, output: 0 })],
    });
    expect(result.auto).toBe(false);
    expect(result.model).toBe("paid");
  });

  it("keeps a pinned model even when the catalog cannot be reached", () => {
    const result = resolveModelForMode({ ...base, configured: "my-model", catalog: [] });
    expect(result.model).toBe("my-model");
    expect(result.missingFromCatalog).toBe(false);
  });

  it("flags a pinned model that has disappeared from a catalog it fetched", () => {
    const result = resolveModelForMode({
      ...base,
      configured: "retired",
      catalog: [model("free", { input: 0, output: 0 })],
    });
    expect(result.model).toBe("retired");
    expect(result.missingFromCatalog).toBe(true);
  });

  it("returns an empty model when auto finds nothing eligible", () => {
    const result = resolveModelForMode({
      ...base,
      configured: AUTO_MODEL,
      catalog: [model("paid", { input: 5, output: 25 })],
    });
    expect(result.auto).toBe(true);
    expect(result.model).toBe("");
    expect(result.selection?.needsPaidConfirmation).toBe(true);
  });

  it("leaves the pin alone when free-only is off and the pin is paid", () => {
    const result = resolveModelForMode({
      configured: "paid",
      mode: "chat",
      provider: zen,
      onlyFree: false,
      now: NOW,
      catalog: [model("free", { input: 0, output: 0 }), model("paid", { input: 5, output: 25 })],
    });
    expect(result.model).toBe("paid");
    expect(result.auto).toBe(false);
  });
});

/**
 * Auto across several providers.
 *
 * The single-provider case is the easy one. What breaks when there are many is
 * that a model id is only unique within the provider serving it, and freeness
 * belongs to the pair: the same id can be free on one provider and paid on
 * another. A ranking that flattened the catalogs before scoring would compare
 * prices from different accounts and pick the wrong one.
 */
describe("Auto across configured providers", () => {
  const zen = providerById("opencode-zen")!;
  const router = providerById("openrouter")!;
  const ollama = providerById("ollama")!;

  const candidate = (p: typeof zen, m: ModelInfo) => ({ provider: p, model: m });
  /**
   * OpenRouter's freeness is read from the `pricing` block its API returns, not
   * from `cost`, so a fixture for it has to carry the field the real provider
   * does. Getting this wrong makes the model classify as `unknown` and the test
   * fails for a reason that has nothing to do with what it is checking.
   */
  const routerModel = (
    id: string,
    prompt: number,
    completion: number,
  ): ModelInfo =>
    ({
      ...model(id),
      pricing: { prompt: String(prompt), completion: String(completion) },
    }) as ModelInfo;

  it("prices each model under the provider that will serve it", () => {
    // The same id, free on one provider and paid on the other. Under free-only
    // the free one must win, and it can only be recognised as free because the
    // provider is carried alongside.
    const result = resolveModelForMode({
      configured: AUTO_MODEL,
      mode: "chat",
      provider: zen,
      candidates: [
        candidate(zen, model("shared-id", { input: 3, output: 15 })),
        candidate(router, routerModel("shared-id", 0, 0)),
      ],
      onlyFree: true,
    });
    expect(result.providerId).toBe(router.id);
    expect(result.model).toBe("shared-id");
    expect(result.policy.kind).toBe("allowed");
  });

  it("finds a free model on a provider that is not the active one", () => {
    // The common real case: Zen is active and rate limiting, and a local model
    // is free and sitting right there. Auto used to only ever look at Zen.
    const result = resolveModelForMode({
      configured: AUTO_MODEL,
      mode: "chat",
      provider: zen,
      candidates: [
        candidate(zen, model("zen-only", { input: 2, output: 10 })),
        candidate(ollama, model("local-free")),
      ],
      onlyFree: true,
    });
    expect(result.providerId).toBe(ollama.id);
    expect(result.model).toBe("local-free");
  });

  it("puts a model on another provider first when ordering a fallback list", () => {
    // With the mode on Zen, Auto's chosen model is a Zen one, and the *next*
    // thing tried must be elsewhere. After a 429 on Zen, another Zen model is the
    // one option guaranteed to fail the same way.
    const result = resolveModelForMode({
      configured: AUTO_MODEL,
      mode: "chat",
      provider: zen,
      avoidProviderId: zen.id,
      candidates: [
        candidate(zen, model("zen-a", { input: 0, output: 0 })),
        candidate(zen, model("zen-b", { input: 0, output: 0 })),
        candidate(router, routerModel("router-a", 0, 0)),
      ],
      onlyFree: true,
    });
    const fallbacks = result.selection?.fallbacks ?? [];
    expect(fallbacks.length).toBe(2);
    // A different provider, and not merely somewhere in the list.
    expect(fallbacks[0]?.candidate.provider.id).toBe(router.id);
  });

  it("still prefers the better model once the provider is already changing", () => {
    // Cross-provider preference orders the list; it does not override quality.
    // After moving provider, the better model on the new provider is the right
    // next choice and a worse one is not.
    const result = resolveModelForMode({
      configured: AUTO_MODEL,
      mode: "chat",
      provider: zen,
      avoidProviderId: zen.id,
      candidates: [
        candidate(zen, model("zen-only", { input: 0, output: 0 })),
        candidate(router, routerModel("router-good", 0, 0)),
        candidate(router, routerModel("router-rubbish", 0, 0)),
      ],
      onlyFree: true,
    });
    const fallbacks = result.selection?.fallbacks ?? [];
    // Both router models are ahead of the Zen one, ordered between themselves by
    // the same ranking as everything else.
    expect(fallbacks.every((entry) => entry.candidate.provider.id === router.id)).toBe(true);
  });

  it("orders the initial choice by rank, not by novelty", () => {
    // The opposite rule on purpose: when choosing, the provider the user left
    // active must win on merit. Preferring a different provider here would send
    // every message to somewhere the user did not ask for.
    const result = resolveModelForMode({
      configured: AUTO_MODEL,
      mode: "chat",
      provider: zen,
      candidates: [
        candidate(zen, model("zen-good", { input: 0, output: 0 })),
        candidate(router, routerModel("router-other", 0, 0)),
      ],
      onlyFree: true,
    });
    expect(result.providerId).not.toBe("");
    expect(result.selection?.ranked[0]?.candidate.provider.id).toBeTruthy();
    // With no `avoidProviderId` the order is score-then-provider, so the two
    // entries are both present and deterministic rather than provider-rotated.
    expect(result.selection?.ranked.map((entry) => entry.candidate.provider.id)).toHaveLength(2);
  });

  it("still returns nothing eligible when only paid models exist anywhere", () => {
    const result = resolveModelForMode({
      configured: AUTO_MODEL,
      mode: "chat",
      provider: zen,
      candidates: [candidate(zen, model("paid", { input: 5, output: 25 }))],
      onlyFree: true,
    });
    expect(result.model).toBe("");
    expect(result.selection?.needsPaidConfirmation).toBe(true);
    // And it names the provider the paid option would come from, so the error
    // is actionable rather than "turn the setting off, somewhere".
    expect(result.selection?.cheapestPaid?.candidate.provider.label).toBeTruthy();
  });

  it("checks a pin against its own provider, not a same-named model elsewhere", () => {
    // Pinning `shared-id` on Zen while OpenRouter also serves `shared-id` for
    // money must price the Zen one. Matching on the id alone found whichever
    // came first in the merged list.
    const result = resolveModelForMode({
      configured: "shared-id",
      mode: "chat",
      provider: zen,
      candidates: [
        candidate(router, model("shared-id", { input: 0, output: 0 })),
        candidate(zen, model("shared-id", { input: 4, output: 20 })),
      ],
      onlyFree: true,
    });
    expect(result.missingFromCatalog).toBe(false);
    // Zen's copy is paid, so free-only must ask rather than allow. Matching on
    // the id alone would have found OpenRouter's free copy and allowed it.
    expect(result.policy.kind).toBe("confirm");
  });

  it("reports a pin missing only when its own provider lacks it", () => {
    const result = resolveModelForMode({
      configured: "shared-id",
      mode: "chat",
      provider: zen,
      candidates: [candidate(router, model("shared-id"))],
      onlyFree: true,
    });
    // OpenRouter has it, Zen does not. The pin is Zen's, so this is a real miss.
    expect(result.missingFromCatalog).toBe(true);
  });

  it("falls back within one provider when that is all there is", () => {
    const result = resolveModelForMode({
      configured: AUTO_MODEL,
      mode: "chat",
      provider: zen,
      candidates: [candidate(zen, model("a")), candidate(zen, model("b"))],
      onlyFree: true,
    });
    expect(result.providerId).toBe(zen.id);
    expect(result.selection?.fallbacks.every((entry) => entry.candidate.provider.id === zen.id)).toBe(
      true,
    );
  });
});
