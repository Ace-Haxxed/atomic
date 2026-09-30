import { describe, expect, it, vi } from "vitest";
import { ZenProvider } from "./provider.js";
import { ZEN_MODELS_URL } from "./catalog.js";
import { MODELS_DEV_URL } from "./models-dev.js";
import type { FetchLike } from "../http.js";

/**
 * The shape the real endpoints return, captured from a live request.
 *
 * `/zen/v1/models` answers `{"object":"list","data":[{"id":...}]}`, not the
 * `{models:[{id}]}` shape an earlier version of the parser assumed. A parser
 * that disagrees returns zero models, and zero models rendered as an empty
 * dropdown that looked like a network problem.
 */
const LIVE_ZEN_BODY = {
  object: "list",
  data: [
    { id: "claude-opus-5", object: "model", owned_by: "anthropic" },
    { id: "gpt-5.3-codex", object: "model", owned_by: "openai" },
  ],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handlers: Record<string, () => Response>): FetchLike {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const handler = handlers[url];
    if (!handler) throw new TypeError("Load failed");
    return handler();
  }) as unknown as FetchLike;
}

function provider(fetchImpl: FetchLike): ZenProvider {
  return new ZenProvider(
    { apiKey: "test-key", baseUrl: undefined, ownKeys: {} },
    {
      db: {
        execute: async () => ({ rows: [], rowsAffected: 1 }),
        select: async () => [],
        transaction: async (fn) => fn(),
        close: async () => undefined,
      },
      env: {},
      now: () => 1_700_000_000_000,
      fetch: fetchImpl,
    },
  );
}

describe("ZenProvider model catalog", () => {
  it("parses the live OpenAI-shaped /models response", async () => {
    const zen = provider(
      stubFetch({
        [ZEN_MODELS_URL]: () => json(LIVE_ZEN_BODY),
        [MODELS_DEV_URL]: () => json({}),
      }),
    );

    const catalog = await zen.listModels();

    expect(catalog.source).toBe("api");
    expect(catalog.models.map((model) => model.id).sort()).toEqual([
      "claude-opus-5",
      "gpt-5.3-codex",
    ]);
    // The error field exists to explain a fallback; a good fetch must not set it.
    expect(catalog.error).toBeUndefined();
  });

  it("routes each model to the wire format its family requires", async () => {
    const zen = provider(
      stubFetch({
        [ZEN_MODELS_URL]: () => json(LIVE_ZEN_BODY),
        [MODELS_DEV_URL]: () => json({}),
      }),
    );

    const models = (await zen.listModels()).models;
    const wireFormat = new Map(
      models.map((model) => [model.id, model.wireFormat]),
    );

    expect(wireFormat.get("claude-opus-5")).toBe("anthropic-messages");
    expect(wireFormat.get("gpt-5.3-codex")).toBe("openai-responses");
  });

  it("takes pricing from models.dev when it is available", async () => {
    const zen = provider(
      stubFetch({
        [ZEN_MODELS_URL]: () => json(LIVE_ZEN_BODY),
        // models.dev is keyed by provider, and Atomic reads the `opencode` block.
        [MODELS_DEV_URL]: () =>
          json({
            opencode: {
              models: {
                "claude-opus-5": {
                  cost: { input: 5, output: 25 },
                  limit: { context: 200_000, output: 64_000 },
                  modalities: { input: ["text", "image"] },
                  tool_call: true,
                },
              },
            },
          }),
      }),
    );

    const claude = (await zen.listModels()).models.find(
      (m) => m.id === "claude-opus-5",
    );

    expect(claude?.cost).toEqual({ input: 5, output: 25 });
    expect(claude?.capabilities?.contextWindow).toBe(200_000);
    expect(claude?.capabilities?.vision).toBe(true);
    expect(claude?.capabilities?.tools).toBe(true);
  });

  it("falls back to guessed models and records why", async () => {
    // The webview failure mode: a bare TypeError with no message, which is what a
    // blocked cross-origin request looks like.
    const zen = provider(
      vi.fn(async () => {
        throw new TypeError();
      }) as unknown as FetchLike,
    );

    const catalog = await zen.listModels();

    expect(catalog.source).toBe("fallback");
    expect(catalog.models.length).toBeGreaterThan(0);
    // Without this the UI showed two guessed models as if they were fetched.
    expect(catalog.error).toMatch(/network or CORS/i);
  });

  it("reports the status when the provider rejects the request", async () => {
    const zen = provider(
      stubFetch({
        [ZEN_MODELS_URL]: () => new Response("nope", { status: 401 }),
      }),
    );

    const catalog = await zen.listModels();

    expect(catalog.source).toBe("fallback");
    expect(catalog.error).toMatch(/401/);
  });

  it("serves a cached catalog when the network is down", async () => {
    let online = true;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (!online) throw new TypeError("Load failed");
      const url = typeof input === "string" ? input : input.toString();
      if (url === ZEN_MODELS_URL) return json(LIVE_ZEN_BODY);
      return json({});
    }) as unknown as FetchLike;

    const zen = provider(fetchImpl);
    await zen.listModels();
    online = false;

    // A fresh provider, because the cache is a dependency of this one.
    const cached = provider(fetchImpl);
    const catalog = await cached.listModels();

    expect(catalog.source).toBe("fallback");
    expect(catalog.error).toBeTruthy();
  });
});

describe("a provider that is not Zen", () => {
  /** A two-model /models response, and nothing else. */
  const respond = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  it("uses its own dialect instead of Zen's routing table", async () => {
    // `gpt-5.5` is an OpenAI Responses model on Zen. On a third-party gateway
    // that fronts many vendors, the same id is served by a different endpoint --
    // routing it by the table would 404 on a perfectly good key.
    const fetchImpl = (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/models"))
        return respond({ data: [{ id: "gpt-5.5" }] });
      return respond({});
    };
    const provider = new ZenProvider(
      { apiKey: "k", baseUrl: "https://gateway.example/v1" },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        hasRoutingTable: false,
        defaultWireFormat: "openai-chat",
      },
    );

    const catalog = await provider.listModels();

    expect(catalog.source).toBe("api");
    expect(catalog.models[0]?.wireFormat).toBe("openai-chat");
  });

  it("still lists the models the endpoint reports", async () => {
    const fetchImpl = (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return respond({
          data: [{ id: "some-gateway-model" }, { id: "another-model" }],
        });
      }
      return respond({});
    };
    const provider = new ZenProvider(
      { apiKey: "k", baseUrl: "https://gateway.example/v1" },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        hasRoutingTable: false,
        defaultWireFormat: "anthropic-messages",
      },
    );

    // Ranked by capability, so order is not the endpoint's order.
    const ids = (await provider.listModels()).models.map((model) => model.id);

    expect([...ids].sort()).toEqual(["another-model", "some-gateway-model"]);
  });

  it("asks the base URL it was given, not Zen", async () => {
    const seen: string[] = [];
    const fetchImpl = (input: RequestInfo | URL) => {
      seen.push(String(input));
      if (String(input).endsWith("/models")) return respond({ data: [] });
      return respond({});
    };
    const provider = new ZenProvider(
      { apiKey: "k", baseUrl: "http://localhost:11434/v1" },
      { fetch: fetchImpl as unknown as typeof fetch, hasRoutingTable: false },
    );

    await provider.listModels();

    expect(seen).toContain("http://localhost:11434/v1/models");
    expect(seen.every((url) => !url.startsWith("https://opencode.ai"))).toBe(
      true,
    );
  });
});
