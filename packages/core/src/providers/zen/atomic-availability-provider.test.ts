import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZenProvider } from "./provider.js";
import { migratedTestDatabase } from "../../storage/sqlite.test-support.js";
import type { Database } from "../../storage/database.js";

/**
 * What the provider learns from traffic, as opposed to what it was told.
 *
 * These tests drive the real `complete` and `stream` paths with a stubbed
 * transport, so the assertions are about the provider's own bookkeeping: which
 * refusals become durable facts, which successes count as evidence, and what a
 * user-initiated refresh does to all of it.
 */

/** Read what the provider persisted, the way a relaunch would. */
async function readAvailability(db: Database): Promise<{
  blocked: Record<string, { reason: string; since: string }>;
  reachable: string[];
} | null> {
  const rows = await db.select<{ payload: string }>(
    "SELECT payload FROM model_cache WHERE provider_id = ?",
    ["zen.atomicavailability"],
  );
  return rows[0] ? JSON.parse(rows[0].payload) : null;
}

const FREE_TIER_BODY = JSON.stringify({
  error: {
    type: "FreeTierError",
    message: "OpenCode's free tier can only be used from within OpenCode",
  },
});

/**
 * A real in-memory database, so the cache round trip is genuinely exercised
 * rather than asserted against a mock that would agree with anything.
 */
function provider(fetchImpl: typeof fetch, db: Database) {
  return new ZenProvider(
    { apiKey: null },
    { db, fetch: fetchImpl, now: () => 1_800_000_000_000 },
  );
}

/**
 * A provider whose HTTP client will not retry.
 *
 * `HttpClient` retries 429 and 5xx with real backoff, which is right in
 * production and wrong in a test: a case that makes twelve failing calls would
 * spend seconds asleep proving a status is not a verdict.
 */
function noRetryProvider(fetchImpl: typeof fetch, db: Database) {
  return new ZenProvider(
    { apiKey: null },
    {
      db,
      fetch: fetchImpl,
      now: () => 1_800_000_000_000,
      retries: 0,
    },
  );
}

function chat(model: string) {
  return {
    providerId: "opencode-zen",
    model,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hi" }],
      },
    ],
    maxOutputTokens: 8,
  };
}

function okBody() {
  return JSON.stringify({
    choices: [{ message: { content: "hello" } }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  });
}

function sseBody() {
  return 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
}

describe("learning reachability", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("marks a model reachable when it answers with no credential", async () => {
    const db = await migratedTestDatabase();
    const zen = provider(
      async () => new Response(okBody(), { status: 200 }),
      db,
    );
    await zen.complete(chat("space-bunny-free"));
    // Written to the cache under the availability key, not just held in memory.
    expect(await readAvailability(db)).toMatchObject({
      reachable: ["space-bunny-free"],
    });
  });

  it("does not claim reachability when a credential was sent", async () => {
    const db = await migratedTestDatabase();
    const zen = new ZenProvider(
      { apiKey: "sk-some-real-key" },
      { db, fetch: async () => new Response(okBody(), { status: 200 }) },
    );
    await zen.complete(chat("space-bunny-free"));
    // It worked, but that says nothing about whether it works for free.
    expect(await readAvailability(db)).toBeNull();
  });

  it("marks reachable from a real stream too", async () => {
    const db = await migratedTestDatabase();
    const zen = provider(
      async () =>
        new Response(sseBody(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      db,
    );
    for await (const _event of zen.stream(chat("space-bunny-free"))) {
      // drain
    }
    expect(await readAvailability(db)).toMatchObject({
      reachable: ["space-bunny-free"],
    });
  });
});

describe("learning unavailability", () => {
  it("records the free-tier refusal with the provider's own words", async () => {
    const db = await migratedTestDatabase();
    const zen = provider(
      async () => new Response(FREE_TIER_BODY, { status: 403 }),
      db,
    );
    // Twice, from two separate calls. One refusal is only a suspicion; the count
    // is what makes it a fact.
    //
    // `complete` twice, deliberately: two refusals from one process, not two
    // providers and not two accounts. What is being tested is that the second
    // one confirms, not that there is some special second source.
    await expect(zen.complete(chat("big-pickle"))).rejects.toMatchObject({ status: 403 });
    await expect(zen.complete(chat("big-pickle"))).rejects.toMatchObject({ status: 403 });
    const learned = await readAvailability(db);
    expect(Object.keys(learned?.blocked ?? {})).toEqual(["big-pickle"]);
    // The provider's own sentence, kept verbatim so the UI can show it.
    expect(learned?.blocked["big-pickle"].reason).toBe(
      "OpenCode's free tier can only be used from within OpenCode",
    );
  });

  it("does not block a model after a single refusal", async () => {
    // The reported failure in miniature. One 403 and a free model is written
    // off -- which is how `space-bunny-free` came to be reported unavailable
    // and then worked minutes later. It must be a suspicion, and the count must
    // be remembered, so the next refusal is cheap to confirm.
    const db = await migratedTestDatabase();
    const zen = new ZenProvider(
      { apiKey: null },
      {
        db,
        fetch: (async (url: string | URL | Request) => {
          const target = String(url);
          if (target.startsWith("https://opencode.ai/zen/v1/chat/completions")) {
            return new Response(FREE_TIER_BODY, { status: 403 });
          }
          if (target.startsWith("https://opencode.ai/zen/v1/models")) {
            return new Response(
              JSON.stringify({ data: [{ id: "big-pickle", name: "Big Pickle" }] }),
              { status: 200 },
            );
          }
          if (target.startsWith("https://models.dev/")) {
            return new Response(JSON.stringify({}), { status: 200 });
          }
          if (target.includes("docs/zen")) {
            return new Response("<html>no pricing here</html>", { status: 200 });
          }
          throw new Error(`unstubbed request: ${target}`);
        }) as unknown as typeof fetch,
        now: () => 1_800_000_000_000,
      },
    );
    await expect(zen.complete(chat("big-pickle"))).rejects.toMatchObject({ status: 403 });
    const after = await readAvailability(db);
    expect(after?.blocked ?? {}).toEqual({});
    expect(after?.suspect["big-pickle"]?.count).toBe(1);

    // The catalog now says "refused once", not "unavailable": the row stays
    // selectable and can say a retry is worth making.
    const row = (await zen.listModels()).models.find((entry) => entry.id === "big-pickle");
    expect(row?.unavailableInAtomic).toBeUndefined();
    expect(row?.suspectedInAtomic?.count).toBe(1);

    // Second refusal from a real, separate call confirms it.
    await expect(zen.complete(chat("big-pickle"))).rejects.toMatchObject({ status: 403 });
    const confirmed = (await zen.listModels()).models.find((entry) => entry.id === "big-pickle");
    expect(confirmed?.unavailableInAtomic?.reason).toContain("free tier can only be used");
  });

  it("records a refusal seen while streaming", async () => {
    const db = await migratedTestDatabase();
    const zen = provider(
      async () => new Response(FREE_TIER_BODY, { status: 403 }),
      db,
    );
    for (let i = 0; i < 2; i += 1) {
      await expect(async () => {
        for await (const _event of zen.stream(chat("big-pickle"))) {
          // never reached
        }
      }).rejects.toMatchObject({ status: 403 });
    }
    const learned = await readAvailability(db);
    expect(Object.keys(learned?.blocked ?? {})).toEqual(["big-pickle"]);
  });

  it("does not record a plain 403, which is an admin's decision not the model's", async () => {
    const db = await migratedTestDatabase();
    const zen = provider(
      async () =>
        new Response(JSON.stringify({ error: { message: "model disabled" } }), {
          status: 403,
        }),
      db,
    );
    await expect(zen.complete(chat("some-model"))).rejects.toMatchObject({
      status: 403,
    });
    expect(await readAvailability(db)).toBeNull();
  });

  it("does not record a 401, which describes the request not the model", async () => {
    const db = await migratedTestDatabase();
    const zen = new ZenProvider(
      { apiKey: "sk-bad-key" },
      {
        db,
        fetch: async () =>
          new Response(
            JSON.stringify({ error: { message: "Invalid API key" } }),
            { status: 401 },
          ),
      },
    );
    await expect(zen.complete(chat("some-model"))).rejects.toMatchObject({
      status: 401,
    });
    expect(await readAvailability(db)).toBeNull();
  });

  it("does not record a 429 or a 500, however many times they happen", async () => {
    // Repeated on purpose. A status that is transient by definition cannot be
    // promoted by repetition, or a provider having a bad five minutes writes off
    // every free model in the catalog at once.
    //
    // Retries are disabled deliberately: the point of the test is what gets
    // *written down*, and `HttpClient`'s backoff between retries would spend
    // seconds of wall clock proving that a status is still not a verdict.
    for (const status of [429, 500, 502, 503]) {
      const db = await migratedTestDatabase();
      const zen = noRetryProvider(
        async () =>
          new Response(JSON.stringify({ error: { message: "later" } }), {
            status,
          }),
        db,
      );
      for (let i = 0; i < 3; i += 1) {
        await expect(zen.complete(chat("some-model"))).rejects.toMatchObject({ status });
      }
      const learned = await readAvailability(db);
      expect(learned?.blocked ?? {}).toEqual({});
      expect(learned?.suspect ?? {}).toEqual({});
    }
  });

  it("does not record a network failure", async () => {
    // Not even a status: the request never reached anyone, so nothing is known
    // about the model.
    const db = await migratedTestDatabase();
    const zen = provider(
      async () => {
        throw new TypeError("fetch failed");
      },
      db,
    );
    for (let i = 0; i < 3; i += 1) {
      await expect(zen.complete(chat("some-model"))).rejects.toThrow();
    }
    const learned = await readAvailability(db);
    expect(learned?.blocked ?? {}).toEqual({});
    expect(learned?.suspect ?? {}).toEqual({});
  });

  it("keeps a plain 403 a non-event however many times it happens", async () => {
    // A workspace admin disabling a model is a different fact from the free-tier
    // gate, and repeating it does not turn one into the other.
    const db = await migratedTestDatabase();
    const zen = provider(
      async () =>
        new Response(JSON.stringify({ error: { message: "model disabled" } }), { status: 403 }),
      db,
    );
    for (let i = 0; i < 3; i += 1) {
      await expect(zen.complete(chat("some-model"))).rejects.toMatchObject({ status: 403 });
    }
    const learned = await readAvailability(db);
    expect(learned?.blocked ?? {}).toEqual({});
    expect(learned?.suspect ?? {}).toEqual({});
  });

  it("clears the suspicion when the model starts working", async () => {
    // The other direction of the same lesson: a model that answers has not been
    // written off, whatever the count said a moment ago.
    const db = await migratedTestDatabase();
    let fail = true;
    const zen = provider(
      async () =>
        fail
          ? new Response(FREE_TIER_BODY, { status: 403 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
      db,
    );
    await expect(zen.complete(chat("big-pickle"))).rejects.toMatchObject({ status: 403 });
    expect((await readAvailability(db))?.suspect["big-pickle"]?.count).toBe(1);
    fail = false;
    await zen.complete(chat("big-pickle"));
    const learned = await readAvailability(db);
    expect(learned?.suspect ?? {}).toEqual({});
    expect(learned?.blocked ?? {}).toEqual({});
    expect(learned?.reachable).toContain("big-pickle");
  });
});

describe("rechecking on refresh", () => {
  /** A catalog fetch, so `listModels` has something to return. */
  const catalogBody = JSON.stringify({
    data: [
      { id: "big-pickle", name: "Big Pickle" },
      { id: "space-bunny-free", name: "Space Bunny Free" },
    ],
  });

  /**
   * Strict routing, on purpose.
   *
   * A stub that returns something for any unmatched URL lets a mis-wired test
   * fall through to the live API while still looking green -- which is exactly
   * what happened twice while writing this file. Throwing on an unrecognised
   * URL turns that into an obvious local failure.
   */
  function router() {
    return vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.startsWith("https://opencode.ai/zen/v1/models")) {
        return new Response(catalogBody, { status: 200 });
      }
      if (target.startsWith("https://models.dev/")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (target.includes("docs/zen")) {
        return new Response("<html>no pricing here</html>", { status: 200 });
      }
      if (target.startsWith("https://opencode.ai/zen/v1/chat/completions")) {
        return new Response(FREE_TIER_BODY, { status: 403 });
      }
      throw new Error(`unstubbed request: ${target}`);
    });
  }

  async function seed() {
    const db = await migratedTestDatabase();
    const fetchImpl = router();
    const zen = new ZenProvider(
      { apiKey: null },
      {
        db,
        fetch: fetchImpl as unknown as typeof fetch,
        now: () => 1_800_000_000_000,
      },
    );
    return { db, fetchImpl, zen };
  }

  it("stamps the learned block onto the catalog it returns", async () => {
    const { zen } = await seed();
    await zen.listModels();
    for (let i = 0; i < 2; i += 1) {
      await expect(zen.complete(chat("big-pickle"))).rejects.toMatchObject({ status: 403 });
    }
    const after = await zen.listModels();
    const gated = after.models.find((entry) => entry.id === "big-pickle");
    expect(gated?.unavailableInAtomic?.reason).toBe(
      "OpenCode's free tier can only be used from within OpenCode",
    );
  });

  it("drops learned blocks on a forced refresh, so a lifted gate can come back", async () => {
    const { zen } = await seed();
    await zen.listModels();
    for (let i = 0; i < 2; i += 1) {
      await expect(zen.complete(chat("big-pickle"))).rejects.toMatchObject({ status: 403 });
    }
    expect(
      (await zen.listModels()).models.find((entry) => entry.id === "big-pickle")
        ?.unavailableInAtomic,
    ).toBeDefined();

    zen.invalidateCatalog();
    const refreshed = await zen.listModels();
    // The gate is OpenCode's to change, so a user pressing Refresh has to be
    // able to find out that it was. Nothing is left over from last week.
    expect(
      refreshed.models.find((entry) => entry.id === "big-pickle")
        ?.unavailableInAtomic,
    ).toBeUndefined();
  });

  it("survives a restart by reading the learned facts back from the cache", async () => {
    const { db, zen } = await seed();
    await zen.listModels();
    for (let i = 0; i < 2; i += 1) {
      await expect(zen.complete(chat("big-pickle"))).rejects.toMatchObject({ status: 403 });
    }

    // Same cache, brand new provider: what a relaunch actually looks like.
    const relaunched = new ZenProvider(
      { apiKey: null },
      { db, fetch: router() as unknown as typeof fetch, now: () => 1_800_000_000_000 },
    );
    const models = await relaunched.listModels();
    expect(
      models.models.find((entry) => entry.id === "big-pickle")
        ?.unavailableInAtomic,
    ).toBeDefined();
  });

  it("does not resurrect a forgotten block after a refresh and a relaunch", async () => {
    const { db, zen } = await seed();
    await zen.listModels();
    await expect(zen.complete(chat("big-pickle"))).rejects.toMatchObject({
      status: 403,
    });

    zen.invalidateCatalog();
    await zen.listModels();

    // The half-fixed version of this cleared the field but left the row, so the
    // refresh appeared to work and then undid itself on the next launch. The
    // user pressed Refresh, watched the model come back, chose it, and got the
    // identical refusal with nothing on screen to explain it.
    const relaunched = new ZenProvider(
      { apiKey: null },
      { db, fetch: router() as unknown as typeof fetch, now: () => 1_800_000_000_000 },
    );
    const models = await relaunched.listModels();
    expect(
      models.models.find((entry) => entry.id === "big-pickle")
        ?.unavailableInAtomic,
    ).toBeUndefined();
  });
});
