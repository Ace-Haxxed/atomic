import { describe, expect, it } from "vitest";
import {
  EMPTY_AVAILABILITY,
  applyAvailability,
  invalidateAtomicAvailability,
  isAtomicGated,
  isBlockedInAtomic,
  isVerifiedReachable,
  markBlocked,
  markReachable,
  markSuspect,
  normalizeAvailability,
  REFUSALS_TO_CONFIRM,
  isSuspectedInAtomic,
} from "../providers/zen/atomic-availability.js";
import { rankModels } from "./model-ranking.js";
import { extractProviderMessage } from "../providers/http.js";
import { providerById } from "../providers/registry.js";
import type { ModelInfo } from "./provider.js";

/** Refuse the same model `times` times, the way repeated live calls would. */
function refused(
  times = REFUSALS_TO_CONFIRM,
  reason = "FreeTierError",
  modelId = "big-pickle",
  since = "2026-01-01T00:00:00.000Z",
): ReturnType<typeof markSuspect> {
  let state = EMPTY_AVAILABILITY;
  for (let i = 0; i < times; i += 1) state = markSuspect(state, modelId, reason, since);
  return state;
}

function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "some-model",
    name: "Some Model",
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

describe("isAtomicGated", () => {
  it("recognises the free-tier refusal", () => {
    expect(
      isAtomicGated({
        status: 403,
        message: "FreeTierError: OpenCode's free tier can only be used from within OpenCode",
      }),
    ).toBe(true);
  });

  it("recognises the refusal without the error class prefix", () => {
    expect(
      isAtomicGated({
        status: 403,
        message: "free tier can only be used from within OpenCode",
      }),
    ).toBe(true);
  });

  it("does not treat a plain 403 as the gate", () => {
    // Zen uses 403 for a model a workspace has disabled too, and that one is an
    // admin's problem rather than a permanent verdict on the model.
    expect(isAtomicGated({ status: 403, message: "model disabled" })).toBe(false);
  });

  it("does not treat a 401 as the gate", () => {
    expect(isAtomicGated({ status: 401, message: "Invalid API key" })).toBe(false);
  });

  it("ignores the message when the status is not 403", () => {
    expect(
      isAtomicGated({ status: 200, message: "FreeTierError" }),
    ).toBe(false);
  });
});

describe("marking", () => {
  it("records a block with the reason", () => {
    const next = refused();
    expect(next.blocked["big-pickle"]).toEqual({
      reason: "FreeTierError",
      since: "2026-01-01T00:00:00.000Z",
    });
  });

  it("does not block on the first refusal", () => {
    // The whole point of counting. One 403 is a moment, not a fact: a free model
    // was written off by a single refusal here and then worked minutes later.
    const next = markSuspect(EMPTY_AVAILABILITY, "m", "FreeTierError");
    expect(next.blocked["m"]).toBeUndefined();
    expect(next.suspect["m"]?.count).toBe(1);
  });

  it("counts refusals, and confirms only on the second", () => {
    expect(isSuspectedInAtomic(model({ id: "m" }), refused(1, "FreeTierError", "m"))).toBe(true);
    expect(refused(1, "FreeTierError", "m").blocked["m"]).toBeUndefined();
    expect(refused(REFUSALS_TO_CONFIRM, "FreeTierError", "m").blocked["m"]).toBeDefined();
  });

  it("stamps a one-off refusal as suspect, not as unavailable", () => {
    // Two different UI states with two different affordances. A model stamped
    // `unavailable` is greyed out and offers no retry; a suspect is still
    // selectable and says "refused once".
    const stamped = applyAvailability(model({ id: "m" }), refused(1, "FreeTierError", "m"));
    expect(stamped.unavailableInAtomic).toBeUndefined();
    expect(stamped.suspectedInAtomic).toEqual({
      reason: "FreeTierError",
      since: "2026-01-01T00:00:00.000Z",
      count: 1,
    });
  });

  it("a success clears a suspicion as thoroughly as a block", () => {
    // Otherwise a model that works on the retry stays excluded for the session.
    const recovered = markReachable(refused(1, "FreeTierError", "m"), "m");
    expect(recovered.suspect["m"]).toBeUndefined();
    expect(recovered.blocked["m"]).toBeUndefined();
    expect(isSuspectedInAtomic(model({ id: "m" }), recovered)).toBe(false);
  });

  it("clears a stale suspect stamp when the entry is re-applied", () => {
    // Catalogs are persisted with the stamps baked in, so a row read after an
    // upgrade can still carry the one-off mark with no suspect entry behind it.
    const stale = { ...model({ id: "m" }), suspectedInAtomic: { reason: "old", since: "2026-01-01" } };
    expect(applyAvailability(stale, EMPTY_AVAILABILITY).suspectedInAtomic).toBeUndefined();
  });

  it("collapses whitespace in the reason it shows the user", () => {
    const next = refused(1, "a\n   b   c", "m");
    expect(next.suspect["m"]?.reason).toBe("a b c");
  });

  it("caps the reason so a huge error body cannot bloat the cache", () => {
    const next = refused(1, "x".repeat(5_000), "m");
    expect(next.suspect["m"]?.reason.length).toBe(300);
  });

  it("a later success clears an earlier block", () => {
    // The gate is OpenCode's to change. A model that starts working has to be
    // able to come back, or one bad afternoon disables it forever.
    const blocked = refused(1, "FreeTierError", "m");
    const reachable = markReachable(blocked, "m");
    expect(reachable.blocked["m"]).toBeUndefined();
    expect(reachable.reachable).toEqual(["m"]);
  });

  it("a later block clears an earlier success", () => {
    const reachable = markReachable(EMPTY_AVAILABILITY, "m");
    expect(refused(1, "FreeTierError", "m", reachable).reachable).toEqual([]);
  });

  it("does not duplicate a reachability mark", () => {
    const once = markReachable(EMPTY_AVAILABILITY, "m");
    expect(markReachable(once, "m")).toBe(once);
  });

  it("a no-op observation is not a new object", () => {
    // Lets the provider skip a cache write on every ordinary turn.
    const once = markReachable(EMPTY_AVAILABILITY, "m");
    expect(markReachable(once, "m")).toBe(once);
  });
});

describe("applyAvailability", () => {
  it("stamps a block onto the model with the reason", () => {
    const availability = refused(REFUSALS_TO_CONFIRM, "FreeTierError", "m", "2026-01-01");
    const stamped = applyAvailability(model({ id: "m" }), availability);
    expect(stamped.unavailableInAtomic).toEqual({
      reason: "FreeTierError",
      since: "2026-01-01",
    });
  });

  it("clears a block already baked into the model instead of trusting it", () => {
    // Older builds persisted catalogs with the learned fields set. A refreshed
    // record that no longer lists the model has to win over that, or a model the
    // user already recovered stays unusable with no way back.
    const stale = {
      ...model({ id: "m" }),
      unavailableInAtomic: { reason: "old reason", since: "2020-01-01" },
    };

    expect(applyAvailability(stale, EMPTY_AVAILABILITY).unavailableInAtomic).toBeUndefined();
    expect(
      applyAvailability(stale, markReachable(EMPTY_AVAILABILITY, "m")).unavailableInAtomic,
    ).toBeUndefined();
    expect(
      applyAvailability(stale, markReachable(EMPTY_AVAILABILITY, "m")).verifiedReachable,
    ).toBe(true);
  });

  it("stamps a verified reachability", () => {
    const stamped = applyAvailability(model({ id: "m" }), markReachable(EMPTY_AVAILABILITY, "m"));
    expect(stamped.verifiedReachable).toBe(true);
  });

  it("leaves an untouched model unmarked", () => {
    const stamped = applyAvailability(model({ id: "m" }), EMPTY_AVAILABILITY);
    expect(stamped.unavailableInAtomic).toBeUndefined();
    expect(stamped.verifiedReachable).toBeUndefined();
  });

  it("does not mark a model because a different one was blocked", () => {
    const availability = refused(REFUSALS_TO_CONFIRM, "FreeTierError", "other");
    expect(applyAvailability(model({ id: "m" }), availability).unavailableInAtomic).toBeUndefined();
    expect(applyAvailability(model({ id: "m" }), availability).suspectedInAtomic).toBeUndefined();
  });
});

describe("predicates", () => {
  it("agrees with the stamps", () => {
    const availability = refused(REFUSALS_TO_CONFIRM, "FreeTierError", "m");
    expect(isBlockedInAtomic(model({ id: "m" }), availability)).toBe(true);
    expect(isVerifiedReachable(model({ id: "m" }), availability)).toBe(false);
  });

  it("calls a single refusal a suspicion and not a block", () => {
    // The predicates and the stamps must not disagree, or the row says one thing
    // and the ranking another.
    const availability = refused(1, "FreeTierError", "m");
    expect(isBlockedInAtomic(model({ id: "m" }), availability)).toBe(false);
    expect(isSuspectedInAtomic(model({ id: "m" }), availability)).toBe(true);
  });

  it("keeps a confirmed block from drifting back to a suspicion", () => {
    const confirmed = refused(REFUSALS_TO_CONFIRM, "FreeTierError", "m");
    const again = markSuspect(confirmed, "m", "FreeTierError");
    expect(again.blocked["m"]).toBeDefined();
    expect(again.suspect["m"]).toBeUndefined();
  });
});

describe("normalizeAvailability", () => {
  it("survives a row written before the suspect map existed", () => {
    // The crash this prevents: `suspect` is indexed directly on every read, and
    // an upgraded install has real rows in the cache that predate the field.
    expect(() => normalizeAvailability({ blocked: {}, reachable: [] })).not.toThrow();
    const row = normalizeAvailability({ blocked: {}, reachable: [] });
    expect(row.suspect).toEqual({});
    // And a refusal counted against it works normally from there.
    expect(markSuspect(row, "m", "FreeTierError").suspect["m"]?.count).toBe(1);
  });

  it("discards entries that are not marks", () => {
    const row = normalizeAvailability({
      blocked: { ok: { reason: "r", since: "s" }, bad: "nope", partial: { reason: 1 } },
      suspect: null,
      reachable: ["fine", 7],
    });
    expect(Object.keys(row.blocked)).toEqual(["ok"]);
    expect(row.suspect).toEqual({});
    expect(row.reachable).toEqual(["fine"]);
  });

  it("will not adopt a count that should have confirmed a block", () => {
    // A row claiming 99 refusals must not be read as a confirmation, because
    // nothing checked the threshold that does the confirming.
    const row = normalizeAvailability({
      blocked: {},
      suspect: { m: { reason: "r", since: "s", count: 99 } },
      reachable: [],
    });
    expect(row.suspect["m"]?.count).toBe(REFUSALS_TO_CONFIRM);
    expect(row.blocked["m"]).toBeUndefined();
  });
});

describe("invalidateAtomicAvailability", () => {
  it("drops every mark so a refresh re-tests", () => {
    const learned = markReachable(
      markBlocked(refused(1, "FreeTierError", "m"), "m", "FreeTierError"),
      "n",
    );
    expect(invalidateAtomicAvailability()).toEqual(EMPTY_AVAILABILITY);
  });
});

describe("ranking with learned facts", () => {
  const zen = providerById("opencode-zen");
  if (!zen) throw new Error("opencode-zen is not registered");
  const options = { provider: zen, mode: "chat" as const, onlyFree: true, now: 0 };

  function free(over: Partial<ModelInfo> = {}): ModelInfo {
    return model({ id: "free-model", cost: { input: 0, output: 0 }, ...over });
  }

  it("excludes a model Atomic has been refused, with the provider's reason", () => {
    const gated = free({ id: "gated", unavailableInAtomic: { reason: "FreeTierError", since: "x" } });
    const catalog = rankModels([free(), gated], options);
    expect(catalog.ranked.map((entry) => entry.model.id)).toEqual(["free-model"]);
    expect(catalog.excluded).toEqual([
      { id: "gated", reason: "Not usable from Atomic: FreeTierError" },
    ]);
  });

  it("prefers a verified free model over an unverified one of equal quality", () => {
    const catalog = rankModels(
      [free({ id: "untested" }), free({ id: "proven", verifiedReachable: true })],
      options,
    );
    expect(catalog.ranked[0]?.model.id).toBe("proven");
  });

  it("does not let reachability outweigh a large capability gap", () => {
    // A verified model that cannot do the job is still not the right choice.
    const weak = free({ id: "weak", verifiedReachable: true, capabilities: { ...model().capabilities, contextWindow: 8_000 } });
    const strong = free({ id: "strong" });
    expect(rankModels([weak, strong], options).ranked[0]?.model.id).toBe("strong");
  });

  it("shows the reachability factor so the choice is auditable", () => {
    const catalog = rankModels([free({ verifiedReachable: true })], options);
    const factor = catalog.ranked[0]?.factors.find((f) => f.label === "Reachable");
    expect(factor?.detail).toBe("answered a real call from Atomic");
  });

  it("says why nothing was eligible when everything was gated", () => {
    const catalog = rankModels(
      [free({ id: "gated", unavailableInAtomic: { reason: "FreeTierError", since: "x" } })],
      options,
    );
    expect(catalog.ranked).toHaveLength(0);
    expect(catalog.emptyReason).toBe("No free model on this provider can run this mode.");
  });
});

describe("the reason shown to the user", () => {
  it("drops the console preamble Zen's proxies add", () => {
    expect(
      extractProviderMessage(
        JSON.stringify({
          error: {
            message:
              "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
          },
        }),
      ),
    ).toBe("OpenCode's free tier can only be used from within OpenCode");
  });

  it("still recognises the gate after the preamble is stripped", () => {
    const message =
      extractProviderMessage(
        JSON.stringify({
          error: {
            message:
              "Error from provider (Console): free tier can only be used from within OpenCode",
          },
        }),
      ) ?? "";
    expect(isAtomicGated({ status: 403, message })).toBe(true);
  });

  it("returns nothing useful for a bare invalid-key body", () => {
    // The status already says this; a redundant "Invalid API key." only adds
    // noise to whichever message ends up in front of the user.
    expect(
      extractProviderMessage(
        JSON.stringify({ error: { message: "Invalid API key." } }),
      ),
    ).toBeUndefined();
  });
});
