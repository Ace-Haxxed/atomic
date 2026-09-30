/**
 * The merged catalog: grouping, badges, filters, and the vanished-model case.
 *
 * Pure functions over data the host already fetched, so the tests are about
 * decisions rather than plumbing. The behaviours that matter here are the ones a
 * user notices as wrong:
 *
 *  - "free only" must not admit a model whose price nobody reported
 *  - a pinned model that has vanished must produce a notice, not a silent swap
 *  - an empty catalog must not be mistaken for a vanished model
 */

import { describe, expect, it } from "vitest";

import {
  catalogKey,
  configuredProviders,
  filterModels,
  filterSection,
  isKeylessProvider,
  isUnconfigured,
  mergeModels,
  missingSelections,
  parseCatalogKey,
  resolveSelection,
  selectionKey,
  toCatalogModel,
  type CatalogModel,
  type ProviderModels,
} from "./catalog-service.js";
import { providerById, PROVIDERS } from "../providers/registry.js";
import { selectAutoModel } from "./model-ranking.js";
import { SettingsSchema, type Settings } from "../settings/schema.js";
import { AUTO_MODEL } from "./auto-model.js";
import type { ModelInfo } from "./provider.js";

const def = (id: string) => {
  const found = providerById(id);
  if (!found) throw new Error(`no provider ${id}`);
  return found;
};

function model(input: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: input.id,
    wireFormat: "openai-chat",
    capabilities: {
      tools: false,
      vision: false,
      reasoning: false,
      reasoningEffort: false,
      streaming: true,
    },
    ...input,
  } as ModelInfo;
}

const ZEN_FREE = model({ id: "some-model:free", cost: { input: 0, output: 0 } });
const ZEN_PAID = model({ id: "paid-model", cost: { input: 3, output: 15 } });
const ZEN_UNPRICED = model({ id: "unpriced-model" });
const ZEN_TOOLS = model({
  id: "tooling-model",
  cost: { input: 0, output: 0 },
  capabilities: {
    tools: true,
    vision: true,
    reasoning: true,
    reasoningEffort: false,
    streaming: true,
    contextWindow: 200_000,
  },
});

const LOCAL = model({ id: "local-coder:8b", description: "Qwen3 coder, quantised for a 16 GB machine" });

function section(providerId: string, models: readonly ModelInfo[]): ProviderModels {
  return {
    provider: def(providerId),
    models,
    source: "api",
    status: "connected",
    error: null,
    fetchedAt: 1,
    stale: false,
  };
}

const SECTIONS: readonly ProviderModels[] = [
  section("opencode-zen", [ZEN_FREE, ZEN_PAID, ZEN_UNPRICED, ZEN_TOOLS]),
  section("ollama", [LOCAL]),
];

const ALL = mergeModels(SECTIONS);

describe("merging", () => {
  it("tags every model with the provider that serves it", () => {
    expect(ALL.map((entry) => [entry.id, entry.providerId])).toEqual([
      ["some-model:free", "opencode-zen"],
      ["paid-model", "opencode-zen"],
      ["unpriced-model", "opencode-zen"],
      ["tooling-model", "opencode-zen"],
      ["local-coder:8b", "ollama"],
    ]);
  });

  it("keeps provider order, then provider order within each", () => {
    // The dropdown is grouped, so a stable order is what makes it readable.
    expect(ALL[0]?.providerLabel).toBe("OpenCode Zen");
    expect(ALL[4]?.providerLabel).toBe("Ollama (local)");
  });

  it("marks local models, and only local models", () => {
    expect(ALL.find((entry) => entry.id === "local-coder:8b")?.local).toBe(true);
    expect(ALL.find((entry) => entry.id === "some-model:free")?.local).toBe(false);
  });

  it("carries capabilities and the context window onto the row", () => {
    const tooling = ALL.find((entry) => entry.id === "tooling-model");
    expect(tooling?.tools).toBe(true);
    expect(tooling?.vision).toBe(true);
    expect(tooling?.reasoning).toBe(true);
    expect(tooling?.contextWindow).toBe(200_000);
  });
});

describe("freeness badges", () => {
  it("labels a zero-cost model free", () => {
    expect(ALL.find((entry) => entry.id === "some-model:free")?.freeness).toBe("free");
  });

  it("labels a priced model paid", () => {
    expect(ALL.find((entry) => entry.id === "paid-model")?.freeness).toBe("paid");
  });

  it("labels a local model free, because the machine is the user's", () => {
    const local = ALL.find((entry) => entry.id === "local-coder:8b");
    expect(local?.freeness).toBe("free");
    expect(local?.freenessReason).toContain("Ollama");
  });

  it("leaves a model with no reported price unknown rather than calling it free", () => {
    // The dangerous direction: a model shown as free that is not.
    expect(ALL.find((entry) => entry.id === "unpriced-model")?.freeness).toBe("unknown");
  });

  it("never puts a credential in the reason", () => {
    for (const entry of ALL) {
      expect(entry.freenessReason).not.toMatch(/\bsk-[A-Za-z0-9]|bearer\s|api[-_]?key\s*[:=]/i);
    }
  });
});

describe("which providers are configured", () => {
  it("counts a saved key, and Ollama, and the active provider", () => {
    const settings = SettingsSchema.parse({ providerId: "groq" });
    const ids = configuredProviders(settings, { openrouter: true }).map((entry) => entry.id);
    expect(ids).toContain("openrouter");
    expect(ids).toContain("ollama");
    expect(ids).toContain("groq");
    expect(ids).not.toContain("anthropic");
  });

  it("treats Ollama as needing no key", () => {
    expect(isKeylessProvider("ollama")).toBe(true);
    expect(isKeylessProvider("openrouter")).toBe(false);
  });

  it("marks a keyless section with no models as unconfigured, for the Add key prompt", () => {
    const prompt: ProviderModels = {
      provider: def("anthropic"),
      models: [],
      source: "fallback",
      status: "unconfigured",
      error: null,
      fetchedAt: null,
      stale: false,
    };
    expect(isUnconfigured(prompt)).toBe(true);
    expect(isUnconfigured(section("opencode-zen", [ZEN_FREE]))).toBe(false);
  });
});

describe("search and filters", () => {
  it("returns everything with no filters", () => {
    expect(filterModels(ALL)).toHaveLength(ALL.length);
  });

  it("matches on id, name and description, case-insensitively", () => {
    expect(filterModels(ALL, { query: "LOCAL-CODER" }).map((m) => m.id)).toEqual(["local-coder:8b"]);
    expect(filterModels(ALL, { query: "qwen3" }).map((m) => m.id)).toEqual(["local-coder:8b"]);
  });

  it("narrows by provider name, so typing a vendor shows that vendor", () => {
    expect(filterModels(ALL, { query: "ollama" }).map((m) => m.id)).toEqual(["local-coder:8b"]);
  });

  it("returns nothing for a query that matches nothing, rather than everything", () => {
    expect(filterModels(ALL, { query: "no-such-model" })).toEqual([]);
  });

  it("keeps only confirmed free and free-tier models under free-only", () => {
    const ids = filterModels(ALL, { freeOnly: true }).map((m) => m.id);
    expect(ids).toContain("some-model:free");
    expect(ids).toContain("local-coder:8b");
    expect(ids).not.toContain("paid-model");
    // An unreported price is not a confirmed zero. Admitting it here is how a
    // model the user cannot afford ends up under a filter promising it is free.
    expect(ids).not.toContain("unpriced-model");
  });

  /**
   * The freeness chips.
   *
   * The header picker and the models tab used to carry separate copies of this
   * filter, and only the settings copy honoured `freeness` -- so ticking Paid
   * narrowed the list in one place and did nothing in the other, which reads as
   * a broken chip rather than as two filters disagreeing. The behaviour is
   * pinned here on the shared implementation both surfaces now call.
   */
  it("narrows to the chosen freeness groups", () => {
    const paid = filterModels(ALL, { freeness: ["paid"] }).map((m) => m.id);
    expect(paid).toEqual(["paid-model"]);

    const unknown = filterModels(ALL, { freeness: ["unknown"] }).map((m) => m.id);
    expect(unknown).toEqual(["unpriced-model"]);

    const freeish = filterModels(ALL, { freeness: ["free", "free-tier"] }).map((m) => m.id);
    expect(freeish).toEqual(["some-model:free", "tooling-model", "local-coder:8b"]);
  });

  it("shows everything when no group is chosen", () => {
    // The chips clear to "no choice". Reading that as an empty intersection
    // emptied the whole catalog, so the unselected state has to mean "no
    // narrowing" rather than "nothing matches".
    expect(filterModels(ALL, { freeness: [] })).toHaveLength(ALL.length);
    expect(filterModels(ALL, { freeness: undefined })).toHaveLength(ALL.length);
  });

  it("combines the group chips with the other filters", () => {
    expect(filterModels(ALL, { freeness: ["free"], localOnly: true }).map((m) => m.id)).toEqual([
      "local-coder:8b",
    ]);
    // Groups and free-only are the intersection when both are present, so a
    // contradictory pair honestly shows nothing rather than quietly widening.
    expect(filterModels(ALL, { freeness: ["paid"], freeOnly: true })).toEqual([]);
  });

  it("keeps only tool-capable models under the tools filter", () => {
    expect(filterModels(ALL, { toolsOnly: true }).map((m) => m.id)).toEqual(["tooling-model"]);
  });

  it("keeps only local models under the local filter", () => {
    expect(filterModels(ALL, { localOnly: true }).map((m) => m.id)).toEqual(["local-coder:8b"]);
  });

  it("combines filters", () => {
    expect(filterModels(ALL, { freeOnly: true, localOnly: true }).map((m) => m.id)).toEqual([
      "local-coder:8b",
    ]);
    // A local model without tools, so the combination is empty.
    expect(filterModels(ALL, { localOnly: true, toolsOnly: true })).toEqual([]);
  });

  it("ignores an all-whitespace query", () => {
    expect(filterModels(ALL, { query: "   " })).toHaveLength(ALL.length);
  });

  it("filters within one provider's section", () => {
    const zen = SECTIONS[0]!;
    expect(filterSection(zen, { providerId: "opencode-zen", freeOnly: true }).map((m) => m.id)).toEqual([
      "some-model:free",
      "tooling-model",
    ]);
    expect(filterSection(zen, { providerId: "opencode-zen", query: "local" })).toEqual([]);
  });
});

describe("a pinned model that has disappeared", () => {
  // A pin and the provider that serves it are always written together, so the
  // fixtures do it too: testing a Zen-pinned Ollama model id would exercise a
  // state `setModelForMode` cannot produce.
  const settings = (chat: string, providerId = "opencode-zen"): Settings =>
    SettingsSchema.parse({ models: { chat, providers: { chat: providerId } } });

  it("keeps a pinned model that is still available", () => {
    const state = resolveSelection(settings("paid-model"), "chat", ALL);
    expect(state.health).toBe("ok");
    expect(state.effective).toBe("paid-model");
    expect(state.notice).toBeNull();
  });

  it("falls back to an available model and says so", () => {
    // Deleted from Ollama, or retired by the vendor. Sending it anyway fails with
    // a provider 404 that means nothing, so the mode moves on -- visibly.
    const state = resolveSelection(settings("gone-zen-model"), "chat", ALL, SECTIONS);
    expect(state.health).toBe("missing");
    expect(state.notice).toContain("gone-zen-model");
    expect(state.notice).toContain("OpenCode Zen");
    // The replacement is named *and* attributed: the two are different facts, and
    // the second is the one that lets anyone check the first.
    expect(state.notice).toMatch(/instead\.$/);
    expect(state.notice).toMatch(/will use .+ from .+ instead\./);
  });

  it("offers the alternatives, most likely first", () => {
    const state = resolveSelection(settings("gone-zen-model"), "chat", ALL, SECTIONS);
    expect(state.replacements.length).toBeGreaterThan(0);
    expect(state.replacements.map((m) => m.id)).toContain("local-coder:8b");
  });

  it("does not touch a mode that is on Auto", () => {
    // Auto is resolved from the ranking, so it can never be "missing", and
    // rewriting it would destroy the user's choice to delegate the decision.
    const state = resolveSelection(settings(""), "chat", ALL, SECTIONS);
    expect(state.health).toBe("auto");
    expect(state.effective).toBe(AUTO_MODEL);
    expect(state.notice).toBeNull();
  });

  it("keeps the pinned model when the catalog could not be loaded at all", () => {
    // Different from "missing": nothing was learned about the model, so nothing
    // justifies replacing it. The send path reports the real error.
    const state = resolveSelection(settings("paid-model"), "chat", []);
    expect(state.health).toBe("unavailable");
    expect(state.effective).toBe("paid-model");
    expect(state.notice).toContain("could not be loaded");
  });

  it("collects every affected mode for one banner", () => {
    const all = SettingsSchema.parse({
      models: { chat: "gone-chat", cowork: "gone-cowork", code: "paid-model" },
    });
    const missing = missingSelections(all, ALL, SECTIONS);
    expect(missing.map((entry) => entry.mode)).toEqual(["chat", "cowork"]);
    expect(missing[0]?.effective).toBeTruthy();
  });

  it("reports nothing missing when every pinned model is present", () => {
    const all = SettingsSchema.parse({
      models: { chat: "paid-model", code: "local-coder:8b", providers: { code: "ollama" } },
    });
    expect(missingSelections(all, ALL, SECTIONS)).toEqual([]);
  });
});

/**
 * The reported failure, reproduced.
 *
 * A mode pinned to `space-bunny-free` had Zen's catalog fail to load while
 * OpenRouter's succeeded. The merged list was then non-empty, the pin was
 * declared "no longer available", and the replacement was `models[0]` -- the
 * first row of a flat, all-providers catalog, which was a *paid* DeepSeek model
 * from OpenRouter. Free-only was on the whole time.
 *
 * Three separate mistakes, each with its own test: the flat first-row choice,
 * the absence of any freeness check, and telling the user a model was gone when
 * the truth was that nobody had looked.
 */
describe("the reported fallback bug", () => {
  const OPENROUTER = section("openrouter", [
    model({ id: "deepseek/deepseek-chat", cost: { input: 0.27, output: 1.1 } }),
    model({ id: "meta-llama/llama-3.3-70b-instruct:free", cost: { input: 0, output: 0 } }),
  ]);
  const ALL_SECTIONS: readonly ProviderModels[] = [
    // Zen answered, but the pinned model is genuinely gone from its list.
    section("opencode-zen", [ZEN_TOOLS]),
    OPENROUTER,
    section("ollama", [LOCAL]),
  ];
  const ALL_CATALOG = mergeModels(ALL_SECTIONS);
  const pinned = (chat: string): Settings =>
    SettingsSchema.parse({
      models: { chat, providers: { chat: "opencode-zen" } },
      autoSelectFreeModelsOnly: true,
    });

  it("never substitutes a paid model while free-only is on", () => {
    // The exact shape that produced the report: the flat, all-providers list is
    // led by OpenRouter's paid DeepSeek row, and the old code took `models[0]`
    // from it with no freeness check at all. Ordered by hand so the regression
    // does not depend on registry order and quietly pass if that changes.
    const catalog: readonly CatalogModel[] = [
      toCatalogModel(def("openrouter"), model({ id: "deepseek/deepseek-chat", cost: { input: 0.27, output: 1.1 } })),
      toCatalogModel(def("openrouter"), model({ id: "meta-llama/llama-3.3-70b-instruct:free", cost: { input: 0, output: 0 } })),
      toCatalogModel(def("opencode-zen"), ZEN_TOOLS),
    ];
    expect(catalog[0]?.id).toBe("deepseek/deepseek-chat");
    const sections: readonly ProviderModels[] = [
      section("opencode-zen", [ZEN_TOOLS]),
      OPENROUTER,
    ];
    const state = resolveSelection(pinned("space-bunny-free"), "chat", catalog, sections);
    const chosen = catalog.find((entry) => entry.id === state.effective);
    expect(state.health).toBe("missing");
    expect(chosen?.freeness).toBe("free");
    expect(chosen?.id).not.toContain("deepseek-chat");
  });

  it("takes the free OpenRouter model rather than the paid one above it", () => {
    const sections: readonly ProviderModels[] = [
      section("opencode-zen", [ZEN_TOOLS]),
      OPENROUTER,
    ];
    const catalog = mergeModels(sections);
    const state = resolveSelection(pinned("space-bunny-free"), "chat", catalog, sections);
    expect(state.effective).toBe("meta-llama/llama-3.3-70b-instruct:free");
  });

  it("does not fall back to an unpriced model either", () => {
    // `unknown` is not `free`. The old first-row pick had no freeness check at
    // all, so it would have taken either of these.
    const sections: readonly ProviderModels[] = [
      section("opencode-zen", [ZEN_TOOLS]),
      section("openrouter", [model({ id: "some/unpriced" })]),
    ];
    const state = resolveSelection(
      pinned("space-bunny-free"),
      "chat",
      mergeModels(sections),
      sections,
    );
    const chosen = mergeModels(sections).find((entry) => entry.id === state.effective);
    expect(chosen?.freeness).not.toBe("unknown");
  });

  it("names the provider the replacement is served by", () => {
    const state = resolveSelection(pinned("space-bunny-free"), "chat", ALL_CATALOG, ALL_SECTIONS);
    const chosen = ALL_CATALOG.find((entry) => entry.id === state.effective);
    expect(state.notice).toContain(chosen?.providerLabel ?? "!!");
    expect(chosen?.providerId).toBeTruthy();
  });

  it("does not claim a model is gone when its own provider never answered", () => {
    // The actual sequence: Zen's request failed, OpenRouter's succeeded. Nothing
    // was learned about space-bunny-free, and minutes later it worked again.
    const sections: readonly ProviderModels[] = [
      { ...section("opencode-zen", []), status: "unreachable", error: "network" },
      OPENROUTER,
    ];
    const state = resolveSelection(
      pinned("space-bunny-free"),
      "chat",
      mergeModels(sections),
      sections,
    );
    expect(state.health).toBe("unavailable");
    expect(state.notice).not.toContain("no longer offered");
    expect(state.notice).toContain("could not be reached");
    // And the pin is left alone rather than being swapped for something else.
    expect(state.effective).toBe("space-bunny-free");
  });

  it("keeps a free model that has been learned as unusable out of the choices", () => {
    // Reachable on paper, refused in practice. Offering it as the replacement
    // would put the user straight back into the error they were recovering from.
    const sections: readonly ProviderModels[] = [
      {
        ...section("opencode-zen", []),
        models: [
          {
            ...ZEN_TOOLS,
            unavailableInAtomic: { reason: "OpenCode's own app only", since: "2026-01-01" },
          },
          ZEN_FREE,
        ],
      },
    ];
    const state = resolveSelection(
      pinned("space-bunny-free"),
      "chat",
      mergeModels(sections),
      sections,
    );
    expect(state.effective).toBe("some-model:free");
  });
});

describe("free-only fallbacks", () => {
  const options = {
    provider: def("opencode-zen"),
    mode: "chat" as const,
    onlyFree: true,
  };

  it("carries no fallback at all when no free model exists", () => {
    // The regression that made a rate limit on a free model silently bill the
    // user: the paid ranking was returned as the fallback list.
    const selection = selectAutoModel([ZEN_PAID, ZEN_UNPRICED], options);
    expect(selection.chosen).toBeNull();
    expect(selection.fallbacks).toEqual([]);
    expect(selection.needsPaidConfirmation).toBe(true);
  });

  it("still offers the paid models to be confirmed", () => {
    const selection = selectAutoModel([ZEN_PAID], options);
    expect(selection.ranked.map((entry) => entry.model.id)).toEqual(["paid-model"]);
    expect(selection.cheapestPaid?.model.id).toBe("paid-model");
  });

  it("keeps only free models in the fallback list when free models exist", () => {
    const selection = selectAutoModel([ZEN_TOOLS, ZEN_FREE, ZEN_PAID], options);
    expect(selection.chosen).not.toBeNull();
    for (const fallback of selection.fallbacks) {
      expect(fallback.freeness).toBe("free");
    }
  });
});

describe("toCatalogModel", () => {
  it("falls back to the id when a provider reports no name", () => {
    const entry = toCatalogModel(def("opencode-zen"), model({ id: "no-name-model", name: "" }));
    expect(entry.name).toBe("no-name-model");
  });

  it("omits the context window rather than reporting zero", () => {
    // 0 would render as "0" in a context column and imply a model that cannot
    // hold a prompt.
    const entry = toCatalogModel(def("opencode-zen"), model({ id: "no-window" }));
    expect(entry.contextWindow).toBeUndefined();
  });
});

describe("every registered provider is describable", () => {
  it("never calls a hosted model free without a reported zero", () => {
    for (const provider of PROVIDERS) {
      if (isKeylessProvider(provider.id)) continue;
      const entry = toCatalogModel(provider, model({ id: "probe" }));
      expect(entry.freenessReason.length).toBeGreaterThan(0);
      // A price nobody reported is not a price of zero, and this badge is what
      // the free-only filter reads.
      expect(entry.freeness).not.toBe("free");
    }
  });

  it("calls a local model free and says why", () => {
    const entry = toCatalogModel(def("ollama"), model({ id: "probe" }));
    expect(entry.freeness).toBe("free");
    expect(entry.local).toBe(true);
  });
});

describe("keys for a native select", () => {
  it("round-trips a provider and a model", () => {
    const key = catalogKey("opencode-zen", "some-model");
    expect(parseCatalogKey(key)).toEqual({ providerId: "opencode-zen", modelId: "some-model" });
  });

  it("keeps a model id that contains a slash intact", () => {
    // OpenRouter ids are vendor-prefixed, so a "provider/id" join would be
    // ambiguous in exactly the case this exists to solve.
    const key = catalogKey("openrouter", "anthropic/claude-sonnet-4");
    expect(parseCatalogKey(key)).toEqual({
      providerId: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
    });
  });

  it("keeps two providers' identically named models apart", () => {
    expect(catalogKey("openrouter", "gpt-4o-mini")).not.toBe(catalogKey("openai", "gpt-4o-mini"));
  });

  it("rejects a key with no provider or no model", () => {
    expect(parseCatalogKey("")).toBeNull();
    expect(parseCatalogKey("provider")).toBeNull();
  });

  it("has no key for a mode on Auto", () => {
    expect(selectionKey(SettingsSchema.parse({ models: { chat: AUTO_MODEL } }), "chat")).toBeNull();
    expect(selectionKey(SettingsSchema.parse({ models: { chat: "" } }), "chat")).toBeNull();
  });

  it("builds the key from the mode's own provider", () => {
    const settings = SettingsSchema.parse({
      providerId: "opencode-zen",
      models: { chat: "paid-model", providers: { chat: "openrouter" } },
    });
    expect(selectionKey(settings, "chat")).toBe(catalogKey("openrouter", "paid-model"));
  });

  it("falls back to the top-level provider for older settings", () => {
    const settings = SettingsSchema.parse({ providerId: "groq", models: { chat: "some-model" } });
    expect(selectionKey(settings, "chat")).toBe(catalogKey("groq", "some-model"));
  });
});

describe("pinning a default for one mode", () => {
  it("leaves the other modes alone", async () => {
    const { withModelForMode } = await import("../settings/schema.js");
    const start = SettingsSchema.parse({
      models: { chat: "paid-model", cowork: "", code: "" },
    });
    const next = withModelForMode(start, "code", "local-coder:8b", "ollama");
    // `modelFor` falls back to `lastUsed` for unset modes, so writing it here
    // would have repointed cowork at the code model.
    expect(next.models.code).toBe("local-coder:8b");
    expect(next.models.cowork).toBe("");
  });
});
