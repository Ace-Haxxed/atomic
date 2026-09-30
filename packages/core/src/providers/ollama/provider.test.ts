/**
 * How Ollama fails, and what the user is told.
 *
 * Two failure modes worth separating, because the advice is opposite. "The
 * server is not running" means start Ollama. "The server answered and refused"
 * means something in front of it -- a proxy, a different service on the port, a
 * permission policy -- and starting Ollama again will not help. Reporting the
 * first for the second sends people to restart a service that was already up.
 *
 * The address is validated before any request, because a typo in Settings used
 * to be reported as a server that was not running, which is a statement about
 * the wrong machine.
 */

import { describe, expect, it, vi } from "vitest";

import { OllamaProvider } from "./provider.js";
import { OLLAMA_DEFAULT_ROOT } from "./catalog.js";
import { ProviderError, ProviderErrorKind } from "../errors.js";

/** A fetch that answers one route and refuses or hangs as told. */
function fakeFetch(input: {
  readonly status?: number;
  readonly body?: unknown;
  readonly hang?: boolean;
  readonly refuse?: boolean;
} = {}): typeof fetch {
  return (async () => {
    if (input.hang) return new Promise<Response>(() => {});
    if (input.refuse) throw new TypeError("fetch failed: ECONNREFUSED");
    return new Response(input.body === undefined ? "{}" : JSON.stringify(input.body), {
      status: input.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const TAGS = {
  models: [{ name: "qwen3-coder:8b", size: 5_100_000_000, details: { parameter_size: "8.2B" } }],
};

describe("a bad Ollama address", () => {
  it("is refused before any request, naming the fix", () => {
    // A config error, not a network one. Left as a raw parse failure it reached
    // the user through a generic path and came out as "isn't running".
    let thrown: unknown;
    try {
      new OllamaProvider({ baseUrl: "localhost:11434" }, { fetch: fakeFetch() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
    const error = thrown as ProviderError;
    expect(error.kind).toBe(ProviderErrorKind.config);
    expect(error.code).toBe("ollama_bad_url");
    expect(error.userMessage).toMatch(/needs a scheme/);
    // The advice has to be actionable, not just a complaint.
    expect(error.userMessage).toMatch(/http:\/\/localhost:11434/);
  });

  it("is a config error, so nothing is reported as unreachable", () => {
    // The distinction the whole file is about: a bad address is not a server
    // that is down, and a config error must not be rewritten as one.
    let kind: string | undefined;
    try {
      new OllamaProvider({ baseUrl: "htp://localhost:11434" });
    } catch (error) {
      kind = (error as ProviderError).kind;
    }
    expect(kind).not.toBe(ProviderErrorKind.network);
  });

  it("is distinct for a mistyped scheme, a stray path, and a missing scheme", () => {
    const messages = ["htp://localhost:11434", "http://localhost:11434/api/v1", "localhost:11434"].map(
      (baseUrl) => {
        try {
          new OllamaProvider({ baseUrl });
          return "";
        } catch (error) {
          return (error as ProviderError).userMessage;
        }
      },
    );
    expect(messages[0]).toMatch(/Use http, or https/);
    expect(messages[1]).toMatch(/no path after the host/);
    expect(messages[2]).toMatch(/needs a scheme/);
    // Three different mistakes, three different fixes, so three different
    // messages rather than one catch-all.
    expect(new Set(messages).size).toBe(3);
  });

  it("is not an error to have no address at all", () => {
    const provider = new OllamaProvider({}, { fetch: fakeFetch({ body: TAGS }) });
    expect(provider.root).toBe(OLLAMA_DEFAULT_ROOT);
  });

  it("accepts the /v1 suffix the registry stores", () => {
    const provider = new OllamaProvider({ baseUrl: "http://127.0.0.1:11434/v1" });
    expect(provider.root).toBe("http://127.0.0.1:11434");
  });
});

describe("probing Ollama", () => {
  it("says the server is not running, and how to start it", async () => {
    const provider = new OllamaProvider({}, { fetch: fakeFetch({ refuse: true }) });
    const probe = await provider.probe();
    expect(probe.reachable).toBe(false);
    // "network error" here sends people to check a firewall instead.
    expect(probe.message).toMatch(/isn't running/);
    expect(probe.message).toMatch(/ollama serve/);
  });

  it("reports a server that answered", async () => {
    const provider = new OllamaProvider({}, { fetch: fakeFetch({ body: TAGS }) });
    expect((await provider.probe()).reachable).toBe(true);
  });

  /**
   * The case that matters. A 403 means something answered and said no, so the
   * fix is not to start Ollama again.
   */
  it("does not call a refusal a server that is not running", async () => {
    const provider = new OllamaProvider({}, { fetch: fakeFetch({ status: 403 }) });
    const probe = await provider.probe();
    expect(probe.reachable).toBe(false);
    expect(probe.message).not.toMatch(/isn't running/);
    expect(probe.message).not.toMatch(/ollama serve/);
  });

  it("bounds a request that never answers", async () => {
    /*
     * Asserted by the deadline the request sets, not by waiting it out. The
     * default elsewhere is 120s: on loopback that is not a safety net, it is a
     * two-minute wait to be told the thing is not there. Spending five seconds
     * of every run to prove the number would be its own cost, and the deadline
     * is the fact being claimed.
     */
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
        if (typeof timeout === "number") delays.push(timeout);
        return realSetTimeout(handler as () => void, timeout, ...rest);
      }) as typeof globalThis.setTimeout);
    try {
      const provider = new OllamaProvider({}, { fetch: fakeFetch({ hang: true }) });
      void provider.probe().catch(() => undefined);
      await Promise.resolve();
    } finally {
      spy.mockRestore();
    }
    expect(delays).toContain(5_000);
    expect(delays.every((delay) => delay <= 5_000)).toBe(true);
  });
});

describe("listing Ollama models", () => {
  it("never throws when the server is absent", async () => {
    // A dead Ollama is a state, not a crash: the catalog falls back so the rest
    // of the app still has a model list.
    const provider = new OllamaProvider({}, { fetch: fakeFetch({ refuse: true }) });
    const catalog = await provider.listModels();
    expect(catalog.models).toEqual([]);
    expect(catalog.source).toBe("fallback");
    expect(catalog.error).toMatch(/isn't running/);
  });

  it("reports the refused connection as a network problem, not a parse one", async () => {
    const provider = new OllamaProvider({}, { fetch: fakeFetch({ refuse: true }) });
    const catalog = await provider.listModels();
    expect(catalog.errorKind).toBe(ProviderErrorKind.network);
  });
});
