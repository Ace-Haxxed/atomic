import { describe, expect, it } from "vitest";
import { checkModelPolicy, reviewTurnCost, turnCost } from "./free-policy.js";
import { providerById } from "../providers/registry.js";
import type { ModelInfo } from "./provider.js";

const zen = providerById("opencode-zen");
if (!zen) throw new Error("opencode-zen is not registered");

function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "m",
    name: "Model M",
    capabilities: {
      streaming: true,
      tools: true,
      reasoning: false,
      vision: false,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
    },
    ...over,
  };
}

const onlyFree = { onlyFree: true };
const anything = { onlyFree: false };

describe("checkModelPolicy", () => {
  it("allows a model with a published zero price", () => {
    expect(
      checkModelPolicy(model({ cost: { input: 0, output: 0 } }), zen, onlyFree),
    ).toEqual({ kind: "allowed" });
  });

  it("asks before a paid model rather than refusing it", () => {
    const decision = checkModelPolicy(
      model({ name: "Paid Model", cost: { input: 3, output: 15 } }),
      zen,
      onlyFree,
    );
    expect(decision.kind).toBe("confirm");
    if (decision.kind === "confirm") {
      expect(decision.freeness).toBe("paid");
      // The user is being asked to spend money, so the question says so.
      expect(decision.reason).toContain("costs money");
    }
  });

  it("asks before a model nobody has published a price for", () => {
    const decision = checkModelPolicy(model({ name: "Mystery" }), zen, onlyFree);
    expect(decision.kind).toBe("confirm");
    if (decision.kind === "confirm") {
      expect(decision.freeness).toBe("unknown");
      expect(decision.reason).toContain("cannot tell");
    }
  });

  it("blocks a model Atomic has been refused, with no way to confirm", () => {
    const decision = checkModelPolicy(
      model({ unavailableInAtomic: { reason: "free tier is OpenCode-only", since: "x" } }),
      zen,
      onlyFree,
    );
    expect(decision.kind).toBe("blocked");
  });

  it("blocks a gated model even with the policy switched off", () => {
    // Nothing about the gate is a matter of preference. Turning off "free
    // models only" is consent to pay, not consent to call a model that refuses.
    const decision = checkModelPolicy(
      model({ unavailableInAtomic: { reason: "free tier is OpenCode-only", since: "x" } }),
      zen,
      anything,
    );
    expect(decision.kind).toBe("blocked");
  });

  it("allows a paid model once the policy is off", () => {
    expect(
      checkModelPolicy(model({ cost: { input: 3, output: 15 } }), zen, anything),
    ).toEqual({ kind: "allowed" });
  });

  it("allows an unpriced model once the policy is off", () => {
    expect(checkModelPolicy(model(), zen, anything)).toEqual({ kind: "allowed" });
  });
});

describe("turnCost", () => {
  it("prices a turn from per-million rates", () => {
    // $3/M in, $15/M out: 1k in and 2k out is 0.003 + 0.03.
    expect(
      turnCost(model({ cost: { input: 3, output: 15 } }), {
        inputTokens: 1_000,
        outputTokens: 2_000,
      }),
    ).toBeCloseTo(0.033, 6);
  });

  it("is zero for a genuinely free model", () => {
    expect(
      turnCost(model({ cost: { input: 0, output: 0 } }), {
        inputTokens: 1_000,
        outputTokens: 1_000,
      }),
    ).toBe(0);
  });

  it("is unknown rather than zero when the price is missing", () => {
    // The distinction the whole module turns on: unknown is not free.
    expect(turnCost(model(), { inputTokens: 1_000, outputTokens: 1_000 })).toBeNull();
  });

  it("is unknown when only one direction is priced", () => {
    expect(
      turnCost(model({ cost: { input: 0, output: 0, cacheRead: 0 } }), {
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toBe(0);
  });
});

describe("reviewTurnCost", () => {
  const usage = { inputTokens: 1_000, outputTokens: 2_000 };

  it("passes a turn that really was free", () => {
    expect(
      reviewTurnCost({
        model: model({ cost: { input: 0, output: 0 } }),
        usage,
        policy: onlyFree,
      }),
    ).toEqual({ ok: true });
  });

  it("stops a turn that turned out to cost money", () => {
    const result = reviewTurnCost({
      model: model({ name: "Paid", cost: { input: 3, output: 15 } }),
      usage,
      policy: onlyFree,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("was stopped");
  });

  it("stops an unpriced turn rather than assuming it was free", () => {
    const result = reviewTurnCost({ model: model(), usage, policy: onlyFree });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cost).toBeNull();
      expect(result.reason).toContain("cannot tell");
    }
  });

  it("lets an unpriced turn through when the policy is off", () => {
    expect(reviewTurnCost({ model: model(), usage, policy: anything })).toEqual({ ok: true });
  });

  it("lets a paid turn through when the policy is off", () => {
    expect(
      reviewTurnCost({
        model: model({ cost: { input: 3, output: 15 } }),
        usage,
        policy: anything,
      }),
    ).toEqual({ ok: true });
  });

  it("believes the provider over the catalog when they disagree", () => {
    // The catalog says free; the invoice disagrees. The invoice wins.
    const result = reviewTurnCost({
      model: model({ cost: { input: 0, output: 0 } }),
      usage,
      policy: onlyFree,
      providerReportedCost: 0.0042,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cost).toBe(0.0042);
  });

  it("trusts a provider reporting zero for a model we thought was paid", () => {
    expect(
      reviewTurnCost({
        model: model({ cost: { input: 3, output: 15 } }),
        usage,
        policy: onlyFree,
        providerReportedCost: 0,
      }),
    ).toEqual({ ok: true });
  });

describe("observed cost", () => {
  const provider = providerById("opencode-zen")!;

  it("lets a real call override a published free price", () => {
    // The catalog said free; a completed call disagreed. The call wins, because
    // the free-only switch is a promise not to spend and the invoice is the
    // only thing that can refute it.
    const priced = model({ id: "m", cost: { input: 0, output: 0 } });
    const decision = checkModelPolicy(priced, provider, {
      onlyFree: true,
      observed: "paid",
    });
    expect(decision.kind).toBe("confirm");
    expect(decision.kind === "confirm" && decision.freeness).toBe("paid");
  });

  it("asks again about a paid model the catalog has no price for", () => {
    const decision = checkModelPolicy(model({ id: "m" }), provider, {
      onlyFree: true,
      observed: "paid",
    });
    expect(decision.kind).toBe("confirm");
  });

  it("stays quiet when the observation was free", () => {
    const decision = checkModelPolicy(model({ id: "m" }), provider, {
      onlyFree: true,
      observed: "free",
    });
    expect(decision.kind).toBe("allowed");
  });

  it("treats an unreported cost as unknown, not as free", () => {
    const decision = checkModelPolicy(model({ id: "m" }), provider, {
      onlyFree: true,
      observed: "unknown",
    });
    expect(decision.kind).toBe("confirm");
    expect(decision.kind === "confirm" && decision.freeness).toBe("unknown");
  });

  it("does not block a model Atomic knows cannot be called", () => {
    // A free observation is not a licence: a model that 403s is still a model
    // that 403s, whatever the last call cost.
    const gated = model({
      id: "m",
      unavailableInAtomic: { reason: "OpenCode's own app only", since: "2026-01-01" },
    });
    expect(
      checkModelPolicy(gated, provider, { onlyFree: true, observed: "free" }).kind,
    ).toBe("blocked");
  });

  it("is ignored when the policy is not free-only", () => {
    const decision = checkModelPolicy(model({ id: "m" }), provider, {
      onlyFree: false,
      observed: "paid",
    });
    expect(decision.kind).toBe("allowed");
  });
});
});
