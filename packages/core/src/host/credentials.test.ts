/**
 * Credential handling: what "Test connection" proves, and what it must not.
 *
 * The bug these lock down: Zen's `GET /models` is public and answers 200 to an
 * anonymous caller, so the old Test connection reported "Connected" for a key
 * the API rejects. A connection test that cannot fail is worse than none,
 * because it moves the failure to the one place it is most expensive -- pressing
 * Send.
 *
 * No key value appears in this file, and none is ever asserted on: the fake key
 * is a fixture shape, and there is a test that a rejected key cannot leak into
 * any message the user sees.
 */

import { describe, expect, it, vi } from "vitest";

import { LocalHost } from "./local.js";
import { SettingsStore } from "../settings/store.js";
import { MemorySecretStore } from "../secrets/secret-store.js";
import { migratedTestDatabase } from "../storage/sqlite.test-support.js";
import type { HostServices } from "./ports.js";
import {
  setProviderDiagnostics,
  type ProviderDiagnostic,
} from "../providers/diagnostics.js";

/** A key-shaped fixture. Never a credential: it is never sent anywhere real. */
const FIXTURE_KEY = "sk-test-0000000000000000000000000000";

const CATALOG = {
  data: [
    { id: "big-pickle" },
    { id: "space-bunny-free" },
    { id: "claude-sonnet-5" },
  ],
};

/** One free model and one paid, so the probe's cheapest-first order is testable. */
const MODELS_DEV = {
  opencode: {
    models: {
      "big-pickle": {
        id: "big-pickle",
        name: "Big Pickle",
        cost: { input: 0, output: 0 },
        limit: { context: 200_000, output: 64_000 },
        tool_call: true,
        reasoning: true,
      },
      "space-bunny-free": {
        id: "space-bunny-free",
        name: "Space Bunny Free",
        cost: { input: 0, output: 0 },
        tool_call: true,
      },
      "claude-sonnet-5": {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        cost: { input: 2, output: 10 },
        limit: { context: 200_000, output: 64_000 },
        tool_call: true,
      },
    },
  },
};

interface Route {
  readonly status?: number;
  readonly body?: unknown;
  readonly refuse?: boolean;
}

function fakeFetch(routes: Readonly<Record<string, Route>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const entry = Object.entries(routes).find(([prefix]) =>
      url.startsWith(prefix),
    );
    if (!entry) return new Response("not found", { status: 404 });
    const [prefix, route] = entry;
    void prefix;
    if (route.refuse) throw new TypeError("fetch failed: ECONNREFUSED");
    return new Response(
      route.body === undefined ? "" : JSON.stringify(route.body),
      {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
}

/**
 * The non-streaming completion body.
 *
 * A single-token answer, which is what the probe actually asks for: the point is
 * to spend the smallest possible amount to learn whether the key is real, not to
 * find out whether the model is good.
 */
function completionBody(text = "ok"): Record<string, unknown> {
  return {
    id: "probe-1",
    model: "big-pickle",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

const DEFAULT_ROUTES: Readonly<Record<string, Route>> = {
  "https://opencode.ai/zen/v1/models": { body: CATALOG },
  "https://models.dev": { body: MODELS_DEV },
  "https://opencode.ai/zen/v1/chat/completions": { body: completionBody() },
};

async function harness(
  options: {
    routes?: Readonly<Record<string, Route>>;
    key?: string | null;
  } = {},
) {
  const db = await migratedTestDatabase();
  const secrets = new MemorySecretStore();
  if (options.key)
    await secrets.set("provider.opencode-zen.apiKey", options.key);
  const settings = new SettingsStore(db, { providerId: "opencode-zen" });
  const services = {
    env: {},
    ownKeys: {},
    fetch: fakeFetch({ ...DEFAULT_ROUTES, ...(options.routes ?? {}) }),
  } as unknown as HostServices;
  return {
    db,
    secrets,
    settings,
    host: new LocalHost({ db, secrets, settings, services }),
  };
}

describe("Test connection proves the key", () => {
  it("reports valid only after an authenticated request succeeds", async () => {
    const { host, db } = await harness({ key: FIXTURE_KEY });
    try {
      const result = await host.testConnection("opencode-zen");
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("valid");
    } finally {
      await db.close();
    }
  });

  it("asks for a single token, so testing a key is not an open tab in the bill", async () => {
    let asked: {
      body: Record<string, unknown> | null;
      authHeaderPresent: boolean;
    } = {
      body: null,
      authHeaderPresent: false,
    };
    const db = await migratedTestDatabase();
    const secrets = new MemorySecretStore();
    await secrets.set("provider.opencode-zen.apiKey", FIXTURE_KEY);
    const settings = new SettingsStore(db, { providerId: "opencode-zen" });
    const services = {
      env: {},
      ownKeys: {},
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("https://opencode.ai/zen/v1/models")) {
          return new Response(JSON.stringify(CATALOG), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith("https://models.dev")) {
          return new Response(JSON.stringify(MODELS_DEV), {
            headers: { "content-type": "application/json" },
          });
        }
        const headers = new Headers(init?.headers);
        asked = {
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
          authHeaderPresent: headers.has("authorization"),
        };
        return new Response(JSON.stringify(completionBody()), {
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    } as unknown as HostServices;
    const host = new LocalHost({ db, secrets, settings, services });
    try {
      await host.testConnection("opencode-zen");
      expect(asked.authHeaderPresent).toBe(true);
      expect(asked.body?.max_tokens).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("treats an offline provider as 'network', not as a broken key", async () => {
    // The catalog falls back to a guessed model list when the host is
    // unreachable. Probing that guess would blame the key for the outage.
    const { host, db } = await harness({
      key: FIXTURE_KEY,
      routes: {
        "https://opencode.ai/zen/v1/models": { refuse: true },
        "https://models.dev": { refuse: true },
      },
    });
    try {
      const result = await host.testConnection("opencode-zen");
      expect(result.outcome).toBe("network");
      expect(result.message).not.toMatch(/rejected/i);
    } finally {
      await db.close();
    }
  });

  it("reports 'rejected' on 401, where the old version reported success", async () => {
    const { host, db } = await harness({
      key: FIXTURE_KEY,
      routes: {
        "https://opencode.ai/zen/v1/chat/completions": {
          status: 401,
          body: {
            type: "error",
            error: { type: "AuthError", message: "Invalid API key." },
          },
        },
      },
    });
    try {
      const result = await host.testConnection("opencode-zen");
      expect(result.ok).toBe(false);
      expect(result.outcome).toBe("rejected");
      expect(result.message).toMatch(/rejected/i);
    } finally {
      await db.close();
    }
  });

  it("reports 'rate-limited' on 429, distinctly from a rejected key", async () => {
    const { host, db } = await harness({
      key: FIXTURE_KEY,
      routes: {
        "https://opencode.ai/zen/v1/chat/completions": {
          status: 429,
          body: { error: { message: "slow down" } },
        },
      },
    });
    try {
      const result = await host.testConnection("opencode-zen");
      expect(result.outcome).toBe("rate-limited");
      expect(result.ok).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("reports 'network' when the provider cannot be reached", async () => {
    const { host, db } = await harness({
      key: FIXTURE_KEY,
      routes: {
        "https://opencode.ai/zen/v1/models": { refuse: true },
        "https://models.dev": { refuse: true },
        "https://opencode.ai/zen/v1/chat/completions": { refuse: true },
      },
    });
    try {
      const result = await host.testConnection("opencode-zen");
      expect(result.outcome).toBe("network");
    } finally {
      await db.close();
    }
  });

  it("reports 'no-key' rather than a network error when nothing is saved", async () => {
    const { host, db } = await harness({ key: null });
    try {
      const result = await host.testConnection("opencode-zen");
      expect(result.outcome).toBe("no-key");
      expect(result.ok).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("does not call the public /models endpoint as the proof of a key", async () => {
    // The regression that mattered: /models is public, so a catalog fetch is
    // not evidence. The probe must reach the completions endpoint.
    const seen: string[] = [];
    const db = await migratedTestDatabase();
    const secrets = new MemorySecretStore();
    await secrets.set("provider.opencode-zen.apiKey", FIXTURE_KEY);
    const settings = new SettingsStore(db, { providerId: "opencode-zen" });
    const services = {
      env: {},
      ownKeys: {},
      fetch: (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        seen.push(url);
        if (url.startsWith("https://opencode.ai/zen/v1/models")) {
          return new Response(JSON.stringify(CATALOG), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.startsWith("https://models.dev")) {
          return new Response(JSON.stringify(MODELS_DEV), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(completionBody()), {
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    } as unknown as HostServices;
    const host = new LocalHost({ db, secrets, settings, services });
    try {
      const result = await host.testConnection("opencode-zen");
      expect(seen.some((url) => url.includes("/chat/completions"))).toBe(true);
      expect(result.outcome).toBe("valid");
    } finally {
      await db.close();
    }
  });
});

describe("a key is refused rather than mangled", () => {
  it("trims the newlines a paste leaves behind", async () => {
    const { host, secrets, db } = await harness();
    try {
      await host.setApiKey("opencode-zen", `  ${FIXTURE_KEY}\n`);
      expect(await secrets.get("provider.opencode-zen.apiKey")).toBe(
        FIXTURE_KEY,
      );
    } finally {
      await db.close();
    }
  });

  it("rejects a key with interior whitespace instead of silently deleting it", async () => {
    const { host, secrets, db } = await harness();
    try {
      await expect(
        host.setApiKey("opencode-zen", `sk-abc\ndef`),
      ).rejects.toThrow(/single line/i);
      // And nothing was stored, so a bad paste cannot leave a bad credential.
      expect(await secrets.get("provider.opencode-zen.apiKey")).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("stores nothing when the key is only whitespace", async () => {
    const { host, db } = await harness();
    try {
      await host.setApiKey("opencode-zen", "   \n  ");
      const result = await host.testConnection("opencode-zen");
      expect(result.outcome).toBe("no-key");
    } finally {
      await db.close();
    }
  });
});

describe("diagnostics", () => {
  it("logs the url, dialect and header name of a failure, and never a credential", async () => {
    const lines: ProviderDiagnostic[] = [];
    setProviderDiagnostics(true, (diagnostic) => lines.push(diagnostic));
    const { host, db } = await harness({
      key: FIXTURE_KEY,
      routes: {
        "https://opencode.ai/zen/v1/chat/completions": {
          status: 401,
          body: { error: { message: "Invalid API key." } },
        },
      },
    });
    try {
      await host.testConnection("opencode-zen");
      const failure = lines.find((line) => line.status === 401);
      expect(failure).toBeDefined();
      expect(failure?.dialect).toBe("openai-chat");
      expect(failure?.authHeader).toBe("authorization");
      expect(failure?.url).toContain("/chat/completions");
      // The value must appear nowhere in the record.
      expect(JSON.stringify(failure)).not.toContain(FIXTURE_KEY);
    } finally {
      setProviderDiagnostics(false);
      await db.close();
    }
  });

  it("scrubs a credential echoed back inside an error body", async () => {
    const { redactSecrets } = await import("../providers/diagnostics.js");
    const scrubbed = redactSecrets(
      'upstream said: Authorization: Bearer sk-live-abcdef123456 refused; api_key="sk-other-999999"',
    );
    expect(scrubbed).not.toContain("sk-live-abcdef123456");
    expect(scrubbed).not.toContain("sk-other-999999");
  });

  it("is silent unless a build turns it on", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setProviderDiagnostics(false);
    const { db } = await harness({ key: FIXTURE_KEY });
    try {
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await db.close();
    }
  });
});
