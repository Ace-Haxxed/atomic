/**
 * Provider isolation for the shared hosted-provider implementation.
 *
 * Every hosted provider in this app is served by one class. That is only safe if
 * the class knows *which* provider it is, and the bugs here are all that same
 * root cause wearing different hats:
 *
 *  - `id` was the constant `"opencode-zen"`, so an assistant message from Gemini
 *    was stored as `providerId: "opencode-zen"`, the cost guard priced an
 *    OpenRouter run with Zen's table, and a fallback candidate claimed to be Zen.
 *  - Cache keys were the bare literals `zen.catalog` / `zen.modelsdev` /
 *    `zen.publishedpricing` / `zen.atomicavailability`, written into
 *    `model_cache.provider_id` -- the column named for exactly the separation
 *    that was missing. Whichever provider refreshed last overwrote the row, so a
 *    provider could serve another provider's model list. That is the reported
 *    "Gemini is showing OpenRouter's list": Gemini was never being asked.
 *  - Availability learned from one provider's refusals was attributed to all of
 *    them, so a model Zen rejected could be marked unreachable at Gemini.
 *
 * The base URL is part of the cache scope as well as the id, because a provider
 * pointed at a different endpoint genuinely has a different list.
 */

import { describe, expect, it } from "vitest";

import { ZenProvider, providerCacheKey } from "./provider.js";
import { migratedTestDatabase } from "../../storage/sqlite.test-support.js";
import type { Database } from "../../storage/database.js";
import type { WireFormat } from "../../models/provider.js";

const ZEN_URL = "https://opencode.ai/zen/v1";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const GOOGLE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/** One model, so "which list is this" is decidable by a single id. */
function modelsResponse(ids: readonly string[]): unknown {
  return { data: ids.map((id) => ({ id })) };
}

function jsonFetch(routes: Readonly<Record<string, unknown>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response(JSON.stringify(hit[1]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** An empty models.dev and no published pricing, so only the endpoint decides. */
const NO_SIGNALS = { "https://models.dev": { opencode: { models: {} } } };

function hosted(
  providerId: string,
  baseUrl: string,
  db: Database,
  fetchImpl: typeof fetch,
): ZenProvider {
  return new ZenProvider(
    { apiKey: null, baseUrl },
    {
      db,
      fetch: fetchImpl,
      now: () => 1_800_000_000_000,
      providerId,
      label: providerId,
      defaultWireFormat: "openai-chat" as WireFormat,
      hasRoutingTable: false,
    },
  );
}

async function cacheRows(db: Database): Promise<string[]> {
  const rows = await db.select<{ provider_id: string }>(
    "SELECT provider_id FROM model_cache ORDER BY provider_id",
  );
  return rows.map((row) => row.provider_id);
}

describe("a hosted provider knows which provider it is", () => {
  it("reports the provider it was built for, not Zen", async () => {
    const db = await migratedTestDatabase();
    try {
      const gemini = hosted(
        "google",
        GOOGLE_URL,
        db,
        jsonFetch({}),
      );
      const openrouter = hosted("openrouter", OPENROUTER_URL, db, jsonFetch({}));

      expect(gemini.id).toBe("google");
      expect(openrouter.id).toBe("openrouter");
      expect(gemini.id).not.toBe(openrouter.id);
    } finally {
      await db.close();
    }
  });

  it("still defaults to Zen when nobody names it", async () => {
    const db = await migratedTestDatabase();
    try {
      const zen = new ZenProvider({ apiKey: null }, { db, fetch: jsonFetch({}) });
      expect(zen.id).toBe("opencode-zen");
    } finally {
      await db.close();
    }
  });
});

describe("model lists do not leak between providers", () => {
  it("gives each provider its own catalog", async () => {
    const db = await migratedTestDatabase();
    try {
      const openrouter = hosted(
        "openrouter",
        OPENROUTER_URL,
        db,
        jsonFetch({
          [`${OPENROUTER_URL}/models`]: modelsResponse(["vendor/x-free"]),
          ...NO_SIGNALS,
        }),
      );
      const gemini = hosted(
        "google",
        GOOGLE_URL,
        db,
        jsonFetch({
          [`${GOOGLE_URL}/models`]: modelsResponse(["gemini-2.5-flash"]),
          ...NO_SIGNALS,
        }),
      );

      const first = await openrouter.listModels();
      const second = await gemini.listModels();

      expect(first.models.map((m) => m.id)).toEqual(["vendor/x-free"]);
      expect(second.models.map((m) => m.id)).toEqual(["gemini-2.5-flash"]);
    } finally {
      await db.close();
    }
  });

  it("reads its own cache row rather than another provider's", async () => {
    const db = await migratedTestDatabase();
    try {
      const url = "https://generativelanguage.googleapis.com/v1beta/openai";
      // A row written by OpenRouter under Gemini's provider id and base URL --
      // exactly what the old unscoped keys produced.
      await db.execute(
        "INSERT INTO model_cache (provider_id, payload, fetched_at) VALUES (?, ?, ?)",
        [
          providerCacheKey("catalog", "google", url),
          JSON.stringify({
            models: [{ id: "vendor/x-free" }],
            fetchedAt: 1_800_000_000_000,
            source: "api",
          }),
          1_800_000_000_000,
        ],
      );

      // A fresh provider for the same identity reads the poisoned row, which is
      // why the test below -- a different identity -- is the one that matters.
      const openrouter = hosted(
        "openrouter",
        OPENROUTER_URL,
        db,
        jsonFetch({
          [`${OPENROUTER_URL}/models`]: modelsResponse(["vendor/x-free"]),
          ...NO_SIGNALS,
        }),
      );
      const listed = await openrouter.listModels();

      expect(listed.models.map((m) => m.id)).toEqual(["vendor/x-free"]);
    } finally {
      await db.close();
    }
  });

  it("writes cache rows keyed by provider and endpoint", async () => {
    const db = await migratedTestDatabase();
    try {
      await hosted(
        "openrouter",
        OPENROUTER_URL,
        db,
        jsonFetch({
          [`${OPENROUTER_URL}/models`]: modelsResponse(["vendor/x-free"]),
          ...NO_SIGNALS,
        }),
      ).listModels();
      await hosted(
        "google",
        GOOGLE_URL,
        db,
        jsonFetch({
          [`${GOOGLE_URL}/models`]: modelsResponse(["gemini-2.5-flash"]),
          ...NO_SIGNALS,
        }),
      ).listModels();

      const rows = await cacheRows(db);
      expect(rows).toContain(providerCacheKey("catalog", "openrouter", OPENROUTER_URL));
      expect(rows).toContain(providerCacheKey("catalog", "google", GOOGLE_URL));
      // The unscoped literals are gone, so no provider can claim another's row.
      expect(rows).not.toContain("zen.catalog");
    } finally {
      await db.close();
    }
  });

  it("scopes the cache by endpoint, so a re-pointed provider refetches", async () => {
    const db = await migratedTestDatabase();
    try {
      const endpoint = hosted(
        "openrouter",
        OPENROUTER_URL,
        db,
        jsonFetch({
          [`${OPENROUTER_URL}/models`]: modelsResponse(["vendor/x-free"]),
          ...NO_SIGNALS,
        }),
      );
      await endpoint.listModels();

      // Same provider, different endpoint: a different list, and it must not be
      // answered from the first endpoint's cache.
      const elsewhere = hosted(
        "openrouter",
        "https://example.test/v1",
        db,
        jsonFetch({
          "https://example.test/v1/models": modelsResponse(["local/other"]),
          ...NO_SIGNALS,
        }),
      );
      const listed = await elsewhere.listModels();

      expect(listed.models.map((m) => m.id)).toEqual(["local/other"]);
    } finally {
      await db.close();
    }
  });
});

describe("pre-scoping cache rows are discarded, not guessed at", () => {
  it("ignores and deletes the unscoped rows", async () => {
    const db = await migratedTestDatabase();
    try {
      const payload = JSON.stringify({
        models: [{ id: "leaked/model" }],
        fetchedAt: 1_800_000_000_000,
        source: "api",
      });
      for (const legacy of [
        "zen.catalog",
        "zen.modelsdev",
        "zen.publishedpricing",
        "zen.atomicavailability",
      ]) {
        await db.execute(
          "INSERT INTO model_cache (provider_id, payload, fetched_at) VALUES (?, ?, ?)",
          [legacy, payload, 1_800_000_000_000],
        );
      }

      const gemini = hosted(
        "google",
        GOOGLE_URL,
        db,
        jsonFetch({
          [`${GOOGLE_URL}/models`]: modelsResponse(["gemini-2.5-flash"]),
          ...NO_SIGNALS,
        }),
      );
      const listed = await gemini.listModels();

      // Not the leaked list.
      expect(listed.models.map((m) => m.id)).toEqual(["gemini-2.5-flash"]);
      // And the rows are gone rather than left to be misread again.
      const rows = await cacheRows(db);
      for (const legacy of [
        "zen.catalog",
        "zen.modelsdev",
        "zen.publishedpricing",
        "zen.atomicavailability",
      ]) {
        expect(rows).not.toContain(legacy);
      }
    } finally {
      await db.close();
    }
  });
});

describe("Zen's own provider is unaffected", () => {
  it("serves and caches under its Zen identity", async () => {
    const db = await migratedTestDatabase();
    try {
      const zen = new ZenProvider(
        { apiKey: null },
        {
          db,
          fetch: jsonFetch({
            [`${ZEN_URL}/models`]: modelsResponse(["big-pickle"]),
            ...NO_SIGNALS,
          }),
          now: () => 1_800_000_000_000,
        },
      );

      const listed = await zen.listModels();

      expect(zen.id).toBe("opencode-zen");
      expect(listed.models.map((m) => m.id)).toEqual(["big-pickle"]);
      expect(await cacheRows(db)).toContain(
        providerCacheKey("catalog", "opencode-zen", ZEN_URL),
      );
    } finally {
      await db.close();
    }
  });
});
