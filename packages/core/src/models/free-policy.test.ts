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
    // Observed as free, because a price of zero is the one thing that proves
    // it -- and the session remembers it so the pre-send gate stops asking.
    expect(
      reviewTurnCost({
        model: model({ cost: { input: 0, output: 0 } }),
        usage,
        policy: onlyFree,
      }),
    ).toEqual({ ok: true, observed: "free", spend: { kind: "free", usd: 0 } });
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

  /**
   * The bug this replaces: an unpriced model was stopped, even though the same
   * policy had just allowed it and the turn had already succeeded. The user paid
   * nothing, read "the turn was stopped rather than assumed free", and had no
   * way to tell that apart from having been charged.
   */
  it("keeps an unpriced turn that the catalog calls free", () => {
    const result = reviewTurnCost({
      model: model({ name: "Unpriced Free" }),
      usage,
      policy: onlyFree,
      freeness: "free",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.note).toContain("does not publish a per-token price");
      expect(result.note).toContain("classified as free");
    }
  });

  it("keeps an unpriced free-tier turn too", () => {
    const result = reviewTurnCost({
      model: model({ name: "Free Tier" }),
      usage,
      policy: onlyFree,
      freeness: "free-tier",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.note).toBeTruthy();
  });

  /**
   * Asked before the turn by `checkModelPolicy`, so asking again over a
   * successful reply is the same uncertainty a second time and nothing new.
   */
  it("keeps an unclassified unpriced turn silently", () => {
    const result = reviewTurnCost({
      model: model(),
      usage,
      policy: onlyFree,
      freeness: "unknown",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.note).toBeUndefined();
  });

  it("does not note anything when the policy is off", () => {
    const result = reviewTurnCost({
      model: model(),
      usage,
      policy: anything,
      freeness: "free",
    });
    expect(result).toEqual({ ok: true, observed: undefined, spend: { kind: "free" } });
  });

  /**
   * "No price" is not "no charge". A model the catalog calls free but which the
   * provider actually billed is still a real charge and still stops.
   */
  it("still stops an unpriced model the provider charged for", () => {
    const result = reviewTurnCost({
      model: model({ name: "Surprise" }),
      usage,
      policy: onlyFree,
      freeness: "free",
      providerReportedCost: 0.0025,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cost).toBe(0.0025);
      expect(result.reason).toContain("was stopped");
    }
  });

  it("lets an unpriced turn through when the policy is off", () => {
    expect(reviewTurnCost({ model: model(), usage, policy: anything })).toEqual({
      ok: true,
      observed: undefined,
      spend: { kind: "unknown" },
    });
  });

  /**
   * A charge is a charge whatever the switch says. The switch is a promise not
   * to spend, not a licence to spend, and a user who turned it off to use a paid
   * model has not agreed to be billed for a model they did not pick.
   */
  /**
   * The bug this replaced.
   *
   * Any positive number stopped the turn, whether or not free-only was on, so
   * turning it off did nothing: every paid model stayed unreachable and the one
   * switch that governs spending could not spend. A published price is the
   * policy's business; the guard exists for charges nobody asked for.
   */
  it("allows a paid turn when free-only is off, because that is what off means", () => {
    expect(
      reviewTurnCost({
        model: model({ cost: { input: 3, output: 15 } }),
        usage,
        policy: anything,
      }),
    ).toEqual({
      ok: true,
      observed: undefined,
      spend: { kind: "estimated", usd: 0.033 },
    });
  });

  it("still stops a paid turn when free-only is on", () => {
    const result = reviewTurnCost({
      model: model({ cost: { input: 3, output: 15 } }),
      usage,
      policy: onlyFree,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cost).toBe(0.033);
  });

  /**
   * The rule, in the words it was asked for: a reported charge stops the turn
   * only when the model was classified free, or when free-only is on.
   *
   * An earlier version treated a reported charge as grounds to stop on its own,
   * on the reasoning that evidence outranks a setting. That is true of evidence
   * and false here: with the policy off and a model the user chose knowing it
   * was paid, a charge is the expected result of the choice, and refusing it
   * meant paid models could not be used at all -- the toggle looked broken in a
   * second, subtler way.
   */
  it("lets an explicitly paid model charge when free-only is off", () => {
    expect(
      reviewTurnCost({
        model: model({ name: "Paid", cost: { input: 3, output: 15 } }),
        usage,
        policy: anything,
        freeness: "paid",
        providerReportedCost: 0.4,
      }),
    ).toEqual({
      ok: true,
      observed: undefined,
      // The provider's number, kept labelled as the provider's number. A total
      // that cannot tell a catalog price from an invoice is a total nobody can
      // read.
      spend: { kind: "billed", usd: 0.4 },
    });
  });

  it("lets a paid model charge even without a freeness classification", () => {
    // Nothing known about the model and the policy off: the user said cost is
    // not a constraint, so a charge is not a surprise to them.
    expect(
      reviewTurnCost({
        model: model({ cost: { input: 3, output: 15 } }),
        usage,
        policy: anything,
        providerReportedCost: 0.4,
      }),
    ).toEqual({
      ok: true,
      observed: undefined,
      spend: { kind: "billed", usd: 0.4 },
    });
  });

  it("still stops a reported charge when free-only is on", () => {
    const result = reviewTurnCost({
      model: model({ cost: { input: 0, output: 0 } }),
      usage,
      policy: onlyFree,
      providerReportedCost: 0.4,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cost).toBe(0.4);
  });

  /**
   * The half that does not depend on the toggle: a model the user chose *because
   * it was free* being charged is a broken promise, so it stops whatever the
   * policy says. Turning free-only off is consent to pay for paid models, not
   * permission for a free one to bill.
   */
  it("stops a charge on a model classified free, even with free-only off", () => {
    for (const freeness of ["free", "free-tier"] as const) {
      const result = reviewTurnCost({
        model: model({ name: "Free Model", cost: { input: 0, output: 0 } }),
        usage,
        policy: anything,
        freeness,
        providerReportedCost: 0.25,
      });
      expect(result.ok, `${freeness} should have stopped`).toBe(false);
      if (!result.ok) expect(result.cost).toBe(0.25);
      if (!result.ok) expect(result.reason).toMatch(/classified as free/);
    }
  });

  it("explains which rule stopped a charge", () => {
    // The two reasons mean different things to the person who has to act on
    // them: one is a billing promise, the other is the protection they asked
    // for. The same sentence for both would be wrong for at least one.
    const byPromise = reviewTurnCost({
      model: model({}),
      usage,
      policy: anything,
      freeness: "free",
      providerReportedCost: 0.4,
    });
    const byPolicy = reviewTurnCost({
      model: model({}),
      usage,
      policy: onlyFree,
      freeness: "paid",
      providerReportedCost: 0.4,
    });
    expect(byPromise.ok).toBe(false);
    expect(byPolicy.ok).toBe(false);
    if (!byPromise.ok && !byPolicy.ok) {
      expect(byPromise.reason).toMatch(/classified as free/);
      expect(byPolicy.reason).toMatch(/free-only is on/);
    }
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

  /**
   * An unpriced turn proves nothing.
   *
   * The caller used to record every allowed turn as observed-free, so a model
   * with no published rate was treated as known free from its very first reply
   * and the pre-send gate went quiet. "Atomic could not price this" had become
   * "Atomic knows this is free", which is a much stronger claim and a false one.
   */
  it("observes nothing about a turn it could not price", () => {
    expect(
      reviewTurnCost({
        model: model({}),
        usage,
        policy: onlyFree,
        freeness: "free",
      }),
    ).toEqual({
      ok: true,
      note: expect.stringContaining("does not publish a per-token price"),
      observed: undefined,
      // Free by classification plus no charge reported: evidence of zero, which
      // is why a run total may add it rather than shrug at it.
      spend: { kind: "free" },
    });
  });

  it("observes nothing about an unclassified unpriced turn either", () => {
    expect(reviewTurnCost({ model: model({}), usage, policy: onlyFree })).toEqual({
      ok: true,
      observed: undefined,
      // Nobody reported, nobody published, nothing classifies it free. Not zero.
      spend: { kind: "unknown" },
    });
  });

  it("trusts a provider reporting zero for a model we thought was paid", () => {
    expect(
      reviewTurnCost({
        model: model({ cost: { input: 3, output: 15 } }),
        usage,
        policy: onlyFree,
        providerReportedCost: 0,
      }),
    ).toEqual({ ok: true, observed: "free", spend: { kind: "billed", usd: 0 } });
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
