/**
 * Gemini's model listing, and the 404 that made it look like a key problem.
 *
 * The shared hosted-provider implementation reads `<baseUrl>/models`. For Gemini
 * that URL is `https://generativelanguage.googleapis.com/v1beta/openai/models`,
 * and Google's OpenAI-compatibility surface has no listing endpoint -- verified
 * live on 2026-09-29:
 *
 *   GET /v1beta/openai/models  -> 404 "Requested entity was not found."
 *   GET /v1beta/models         -> 403 PERMISSION_DENIED, i.e. it exists
 *
 * A permanent 404 for every key is what a user cannot fix by re-entering their
 * key, so the section has to be able to say *that* rather than "no models".
 *
 * The response fixtures below are the real shape from `ai.google.dev/api/models`,
 * including the part that matters most: the same listing also returns image,
 * audio, TTS and embedding models, which the chat-completions path cannot drive.
 */

import { describe, expect, it } from "vitest";

import {
  GEMINI_NATIVE_MODELS_URL,
  fetchGeminiNativeModels,
} from "./native-models.js";
import { ProviderError, ProviderErrorKind } from "../errors.js";
import { ZenProvider } from "../zen/provider.js";
import { providerById } from "../registry.js";
import { migratedTestDatabase } from "../../storage/sqlite.test-support.js";

const GOOGLE_COMPAT = "https://generativelanguage.googleapis.com/v1beta/openai";

/** The real `ListModels` response, abridged but structurally exact. */
function nativeList(
  models: readonly Record<string, unknown>[],
  nextPageToken?: string,
): unknown {
  return {
    models: models.map((model) => ({
      baseModelId: model.baseModelId,
      name: model.name,
      version: "001",
      displayName: model.displayName,
      description: model.description,
      inputTokenLimit: model.inputTokenLimit,
      outputTokenLimit: model.outputTokenLimit,
      supportedGenerationMethods: model.supportedGenerationMethods,
      thinking: model.thinking,
    })),
    ...(nextPageToken ? { nextPageToken } : {}),
  };
}

const CHAT_MODELS = [
  {
    name: "models/gemini-3.7-flash",
    baseModelId: "gemini-3.7-flash",
    displayName: "Gemini 3.7 Flash",
    description: "Fast general-purpose model.",
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedGenerationMethods: ["generateContent", "countTokens"],
    thinking: true,
  },
  {
    name: "models/gemini-3.1-pro-preview",
    baseModelId: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro",
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedGenerationMethods: ["generateContent"],
  },
];

const NON_CHAT_MODELS = [
  {
    name: "models/gemini-3.1-flash-image",
    baseModelId: "gemini-3.1-flash-image",
    displayName: "Nano Banana 2",
    supportedGenerationMethods: ["predict"],
  },
  {
    name: "models/gemini-embedding-2",
    baseModelId: "gemini-embedding-2",
    displayName: "Gemini Embedding 2",
    supportedGenerationMethods: ["embedContent"],
  },
  {
    name: "models/gemini-3.5-live-api",
    baseModelId: "gemini-3.5-live-api",
    displayName: "Gemini Live",
    supportedGenerationMethods: ["generateContent"],
  },
];

function responder(
  routes: Readonly<Record<string, { status?: number; body?: unknown }>>,
): (url: string, signal?: AbortSignal) => Promise<Response> {
  return async (url) => {
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return new Response(JSON.stringify({ error: "nope" }), { status: 404 });
    const { status = 200, body } = hit[1];
    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("the registry points Gemini at the listing that exists", () => {
  it("marks google as native-listed while keeping the compat chat base URL", () => {
    const google = providerById("google");
    expect(google?.catalogSource).toBe("native-gemini");
    // Chat is still the OpenAI-shaped surface, which is the point of the split.
    expect(google?.baseUrl).toBe(GOOGLE_COMPAT);
  });

  it("leaves every other provider on the default listing", () => {
    for (const id of ["opencode-zen", "openrouter", "anthropic", "groq"]) {
      expect(providerById(id)?.catalogSource ?? null).toBeNull();
    }
  });
});

describe("fetching the native listing", () => {
  it("returns chat models with the id a chat request needs", async () => {
    const models = await fetchGeminiNativeModels(
      responder({ [GEMINI_NATIVE_MODELS_URL]: { body: nativeList(CHAT_MODELS) } }),
      "google",
    );

    expect(models.map((m) => m.id)).toEqual([
      "gemini-3.7-flash",
      "gemini-3.1-pro-preview",
    ]);
    // Not the resource path, which would 400 as a model id.
    expect(models.every((m) => !m.id.startsWith("models/"))).toBe(true);
  });

  it("keeps the display name and the real context limits", async () => {
    const [model] = await fetchGeminiNativeModels(
      responder({ [GEMINI_NATIVE_MODELS_URL]: { body: nativeList(CHAT_MODELS) } }),
      "google",
    );

    expect(model?.name).toBe("Gemini 3.7 Flash");
    expect(model?.contextWindow).toBe(1_048_576);
    expect(model?.maxOutput).toBe(65_536);
    expect(model?.reasoning).toBe(true);
  });

  it("drops models the chat path cannot drive", async () => {
    const models = await fetchGeminiNativeModels(
      responder({
        [GEMINI_NATIVE_MODELS_URL]: {
          body: nativeList([...CHAT_MODELS, ...NON_CHAT_MODELS]),
        },
      }),
      "google",
    );

    const ids = models.map((m) => m.id);
    expect(ids).toContain("gemini-3.7-flash");
    // Image, embedding and live models all 400 on a chat-completions request.
    expect(ids).not.toContain("gemini-3.1-flash-image");
    expect(ids).not.toContain("gemini-embedding-2");
    expect(ids).not.toContain("gemini-3.5-live-api");
  });

  it("follows pagination", async () => {
    const models = await fetchGeminiNativeModels(
      responder({
        [`${GEMINI_NATIVE_MODELS_URL}?pageToken=p2`]: {
          body: nativeList([CHAT_MODELS[1]!]),
        },
        [GEMINI_NATIVE_MODELS_URL]: {
          body: nativeList([CHAT_MODELS[0]!], "p2"),
        },
      }),
      "google",
    );

    expect(models.map((m) => m.id)).toEqual([
      "gemini-3.7-flash",
      "gemini-3.1-pro-preview",
    ]);
  });

  it("stops at a bounded number of pages", async () => {
    // A nextPageToken that never ends must not hang a refresh.
    const seen: string[] = [];
    await fetchGeminiNativeModels(
      async (url) => {
        seen.push(url);
        return new Response(
          JSON.stringify(nativeList([CHAT_MODELS[0]!], `page-${seen.length}`)),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      "google",
    );

    expect(seen.length).toBe(3);
  });

  it("keeps a model that omits its generation methods", async () => {
    // Some responses leave the field out; dropping the whole catalogue would be
    // a worse answer than including a model that turns out not to be chat.
    const models = await fetchGeminiNativeModels(
      responder({
        [GEMINI_NATIVE_MODELS_URL]: {
          body: { models: [{ name: "models/gemini-x", displayName: "Gemini X" }] },
        },
      }),
      "google",
    );

    expect(models.map((m) => m.id)).toEqual(["gemini-x"]);
  });
});

describe("a listing failure says what actually failed", () => {
  it("names a 401 as a rejected key", async () => {
    const error = await fetchGeminiNativeModels(
      responder({ [GEMINI_NATIVE_MODELS_URL]: { status: 401, body: {} } }),
      "google",
    ).catch((caught: unknown) => caught);

    expect((error as ProviderError).kind).toBe(ProviderErrorKind.auth);
    expect((error as ProviderError).userMessage).toMatch(/check it in Settings/i);
  });

  it("names project enablement for a 403 rather than sending the user to their key", async () => {
    const error = await fetchGeminiNativeModels(
      responder({
        [GEMINI_NATIVE_MODELS_URL]: {
          status: 403,
          body: {
            error: {
              code: 403,
              message:
                "Method doesn't allow unregistered callers. Please use API Key",
              status: "PERMISSION_DENIED",
            },
          },
        },
      }),
      "google",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    // Not `auth`: the key is fine, the project is not set up. "Check your key"
    // would be the wrong instruction entirely.
    expect(providerError.kind).toBe(ProviderErrorKind.forbidden);
    expect(providerError.userMessage).toMatch(/not enabled for this project/i);
    expect(providerError.userMessage).toMatch(/your key itself is fine/i);
    expect(providerError.userMessage).not.toMatch(/check it in Settings/i);
  });

  it("names a moved endpoint for a 404, not a missing key", async () => {
    const error = await fetchGeminiNativeModels(
      responder({ [GEMINI_NATIVE_MODELS_URL]: { status: 404, body: {} } }),
      "google",
    ).catch((caught: unknown) => caught);

    expect((error as ProviderError).userMessage).toMatch(/that endpoint moved/i);
  });

  it("names rate limiting for a 429", async () => {
    const error = await fetchGeminiNativeModels(
      responder({ [GEMINI_NATIVE_MODELS_URL]: { status: 429, body: {} } }),
      "google",
    ).catch((caught: unknown) => caught);

    expect((error as ProviderError).kind).toBe(ProviderErrorKind.rateLimit);
  });

  it("distinguishes an account that can see no models from a broken parse", async () => {
    const error = await fetchGeminiNativeModels(
      responder({ [GEMINI_NATIVE_MODELS_URL]: { body: { models: [] } } }),
      "google",
    ).catch((caught: unknown) => caught);

    expect((error as ProviderError).userMessage).toMatch(
      /accepted, but the account can see no/i,
    );
  });
});

describe("the provider lists Gemini models without touching the 404 path", () => {
  it("never requests the compat /models URL", async () => {
    const db = await migratedTestDatabase();
    const requested: string[] = [];
    try {
      const provider = new ZenProvider(
        { apiKey: null, baseUrl: GOOGLE_COMPAT },
        {
          db,
          providerId: "google",
          label: "Google Gemini",
          catalogSource: "native-gemini",
          now: () => 1_800_000_000_000,
          fetch: (async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input.toString();
            requested.push(url);
            if (url.startsWith(GEMINI_NATIVE_MODELS_URL)) {
              return new Response(JSON.stringify(nativeList(CHAT_MODELS)), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response("{}", { status: 200 });
          }) as typeof fetch,
        },
      );

      const catalog = await provider.listModels();

      expect(catalog.models.map((m) => m.id)).toContain("gemini-3.7-flash");
      expect(requested.some((url) => url.includes("/v1beta/openai/models"))).toBe(
        false,
      );
    } finally {
      await db.close();
    }
  });

  /**
   * The listing was fetched and then thrown away, keeping only the ids, so the
   * picker described Google's models with numbers from a different provider's
   * catalog. Keeping only the ids is not a neutral simplification: it replaces
   * the provider's own facts with a stranger's.
   */
  it("describes the model with what Google reported about it", async () => {
    const db = await migratedTestDatabase();
    try {
      const catalog = await nativeCatalog(db);
      const flash = catalog.models.find((m) => m.id === "gemini-3.7-flash");

      expect(flash?.name).toBe("Gemini 3.7 Flash");
      expect(flash?.description).toBe("Fast general-purpose model.");
      expect(flash?.capabilities.contextWindow).toBe(1_048_576);
      expect(flash?.capabilities.maxOutputTokens).toBe(65_536);
      expect(flash?.capabilities.reasoning).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("does not claim a model reasons when Google did not say so", async () => {
    const db = await migratedTestDatabase();
    try {
      const catalog = await nativeCatalog(db);
      const pro = catalog.models.find((m) => m.id === "gemini-3.1-pro-preview");
      // The fixture has no `thinking` flag. Inventing one from a stranger's
      // catalog would show a thinking toggle that does nothing.
      expect(pro?.capabilities.reasoning).toBe(false);
    } finally {
      await db.close();
    }
  });

  /**
   * Zen and OpenCode publish prices for their own accounts. Reading one and
   * attributing it to a Google model would make the free-only switch judge
   * billing the user is not on -- in either direction.
   */
  it("does not price a Google model from a third-party price list", async () => {
    const db = await migratedTestDatabase();
    try {
      const catalog = await nativeCatalog(db);
      for (const model of catalog.models) {
        expect(model.publishedPricing).toBeUndefined();
      }
    } finally {
      await db.close();
    }
  });

  it("still offers the models for tools, since chat runs over the compat surface", async () => {
    const db = await migratedTestDatabase();
    try {
      const catalog = await nativeCatalog(db);
      // Google's listing has no tool flag at all. The OpenAI-compatible chat
      // surface does, and that is the surface this app actually uses.
      expect(catalog.models.every((m) => m.capabilities.tools)).toBe(true);
    } finally {
      await db.close();
    }
  });
});

/**
 * A provider reading the real native listing, with nothing else stubbed in.
 *
 * Takes the database rather than opening one, so the caller owns the handle and
 * the close. A helper that opened its own would leak it, and an unclosed
 * in-memory database keeps its whole page table alive for the run.
 */
async function nativeCatalog(db: Awaited<ReturnType<typeof migratedTestDatabase>>) {
  return new ZenProvider(
    { apiKey: null, baseUrl: GOOGLE_COMPAT },
    {
      db,
      providerId: "google",
      label: "Google Gemini",
      catalogSource: "native-gemini",
      now: () => 1_800_000_000_000,
      fetch: (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith(GEMINI_NATIVE_MODELS_URL)) {
          return new Response(JSON.stringify(nativeList(CHAT_MODELS)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    },
  ).listModels();
}
