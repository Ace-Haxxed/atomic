/**
 * Per-provider model listing, as the Models tab sees it.
 *
 * These run against a real SQLite database and the real host, because the
 * behaviour under test is mostly about *not* lying: which providers appear, what a
 * provider with no key says, and whether a failure ever becomes an empty list.
 *
 * The network is a fake `fetch` keyed by URL, so every response here is recorded
 * or deliberately refused. No test in this file performs a real request, and none
 * of them contains a key: the fake one below is a fixture shape, and there is a
 * test that asserts a rejected key never reaches an error message.
 */

import { describe, expect, it } from "vitest";

import { LocalHost } from "./local.js";
import { SettingsStore } from "../settings/store.js";
import { MemorySecretStore } from "../secrets/secret-store.js";
import { migratedTestDatabase } from "../storage/sqlite.test-support.js";
import type { Database } from "../storage/database.js";
import type { HostServices } from "./ports.js";
import { OLLAMA_PROVIDER_ID } from "../providers/ollama/catalog.js";

/** A key-shaped fixture. Not a credential: it is never sent anywhere. */
const FIXTURE_KEY = "sk-test-0000000000000000000000000000";

interface Stub {
  readonly status?: number;
  readonly body?: unknown;
  /** Reject the request the way a refused loopback connection does. */
  readonly refuse?: boolean;
}

type Routes = Readonly<Record<string, Stub>>;

function fakeFetch(routes: Routes): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = Object.entries(routes).find(([prefix]) =>
      url.startsWith(prefix),
    );
    if (!match) {
      return new Response("not found", { status: 404 });
    }
    const [prefix, stub] = match;
    void prefix;
    if (stub.refuse) {
      // What better-sqlite3-free browsers and the Tauri plugin both surface for
      // "nothing is listening on that port".
      throw new TypeError("fetch failed: ECONNREFUSED");
    }
    const status = stub.status ?? 200;
    return new Response(
      stub.body === undefined ? "" : JSON.stringify(stub.body),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
}

const TAGS_OK = {
  models: [
    {
      name: "local-coder:8b",
      model: "local-coder:8b",
      size: 4_900_000_000,
      modified_at: "2026-03-01T10:00:00.000000Z",
      details: {
        family: "qwen3",
        parameter_size: "8.2B",
        quantization_level: "Q4_K_M",
      },
    },
  ],
};

const SHOW_OK = {
  model_info: { "qwen3.context_length": 32_768 },
  capabilities: ["completion", "tools"],
};

const OPENROUTER_MODELS = {
  data: [
    { id: "some/model-a:free", name: "Model A" },
    {
      id: "some/model-b",
      name: "Model B",
      pricing: { prompt: "0.000002", completion: "0.000002" },
    },
  ],
};

async function harness(options: {
  routes: Routes;
  providerId?: string;
  keys?: readonly string[];
  env?: Record<string, string>;
  /** Reuse an existing database, to test what a cache survives. */
  reuse?: Database;
}) {
  const db: Database = options.reuse ?? (await migratedTestDatabase());
  const secrets = new MemorySecretStore();
  for (const providerId of options.keys ?? []) {
    await secrets.set(`provider.${providerId}.apiKey`, FIXTURE_KEY);
  }
  const settings = new SettingsStore(db, {
    providerId: options.providerId ?? "opencode-zen",
  });
  const services = {
    env: options.env ?? {},
    ownKeys: {},
    fetch: fakeFetch(options.routes),
  } as unknown as HostServices;

  return {
    db,
    host: new LocalHost({ db, secrets, settings, services }),
    secrets,
    settings,
  };
}

/** The hosted endpoints these tests stand in for. */
const HOSTED_ROUTES: Routes = {
  "https://openrouter.ai/api/v1/models": { body: OPENROUTER_MODELS },
  "https://models.dev": { body: {} },
  "http://localhost:11434/api/tags": { body: TAGS_OK },
  "http://localhost:11434/api/show": { body: SHOW_OK },
};

const sectionFor = <T extends { provider: { id: string } }>(
  sections: readonly T[],
  id: string,
) => sections.find((section) => section.provider.id === id);

describe("which providers appear", () => {
  it("shows a provider with a saved key, and Ollama, and nothing else", async () => {
    const { host, db } = await harness({
      routes: {
        "http://localhost:11434": { body: TAGS_OK },
        "http://localhost:11434/api/show": { body: SHOW_OK },
      },
      keys: ["openrouter"],
    });
    const sections = await host.listProviderModels();
    const ids = sections.map((section) => section.provider.id);

    expect(ids).toContain("openrouter");
    expect(ids).toContain(OLLAMA_PROVIDER_ID);
    // No key, not the active provider: absent entirely, so the tab is not a wall
    // of "add a key" prompts.
    expect(ids).not.toContain("anthropic");
    expect(ids).not.toContain("groq");
    await db.close();
  });

  it("includes the active provider even with no key, so its prompt is visible", async () => {
    // The user has just pointed the app at a provider they have not keyed yet.
    const { host, db } = await harness({
      routes: { "http://localhost:11434": { refuse: true } },
      providerId: "groq",
    });
    const sections = await host.listProviderModels();
    expect(sectionFor(sections, "groq")?.status).toBe("unconfigured");
    await db.close();
  });

  it("treats an env-var key as configured without touching the keychain", async () => {
    const { host, db } = await harness({
      routes: {
        "https://openrouter.ai": { body: OPENROUTER_MODELS },
        "http://localhost:11434": { refuse: true },
      },
      env: { OPENROUTER_API_KEY: FIXTURE_KEY },
    });
    const keys = await host.providerKeyStatus();
    expect(keys.openrouter).toBe(true);
    expect(keys.groq).toBe(false);
    await db.close();
  });
});

describe("a provider with no key", () => {
  it("is reported unconfigured with no models, not as an empty catalog", async () => {
    const { host, db } = await harness({
      routes: { "http://localhost:11434": { refuse: true } },
      providerId: "anthropic",
    });
    const section = sectionFor(await host.listProviderModels(), "anthropic");
    expect(section?.status).toBe("unconfigured");
    expect(section?.models).toEqual([]);
    // The reason is null so the UI shows the "Add key" prompt rather than an
    // error paragraph about a provider the user never asked for.
    expect(section?.error).toBeNull();
    await db.close();
  });
});

describe("Ollama states", () => {
  it("reports 'isn't running' with the URL and a start hint when unreachable", async () => {
    const { host, db } = await harness({
      routes: { "http://localhost:11434": { refuse: true } },
    });
    const section = sectionFor(
      await host.listProviderModels(),
      OLLAMA_PROVIDER_ID,
    );

    expect(section?.status).toBe("unreachable");
    expect(section?.error).toContain("isn't running");
    // The URL, because the user may have moved Ollama to another port.
    expect(section?.error).toContain("http://localhost:11434");
    expect(section?.error).toContain("ollama serve");
    await db.close();
  });

  it("reports connected with zero models when nothing is installed", async () => {
    // The state that needs the pull prompt, and it must not look like a failure.
    const { host, db } = await harness({
      routes: { "http://localhost:11434": { body: { models: [] } } },
    });
    const section = sectionFor(
      await host.listProviderModels(),
      OLLAMA_PROVIDER_ID,
    );

    expect(section?.status).toBe("connected");
    expect(section?.models).toEqual([]);
    expect(section?.error).toBeNull();
    await db.close();
  });

  it("lists installed models with their context window and capabilities", async () => {
    const { host, db } = await harness({
      routes: {
        "http://localhost:11434/api/tags": { body: TAGS_OK },
        "http://localhost:11434/api/show": { body: SHOW_OK },
      },
    });
    const section = sectionFor(
      await host.listProviderModels(),
      OLLAMA_PROVIDER_ID,
    );

    expect(section?.status).toBe("connected");
    expect(section?.models).toHaveLength(1);
    expect(section?.models[0]?.id).toBe("local-coder:8b");
    expect(section?.models[0]?.capabilities.contextWindow).toBe(32_768);
    expect(section?.models[0]?.capabilities.tools).toBe(true);
    await db.close();
  });

  it("keeps a model listed even when /api/show fails for it", async () => {
    const { host, db } = await harness({
      routes: {
        "http://localhost:11434/api/tags": { body: TAGS_OK },
        "http://localhost:11434/api/show": {
          status: 500,
          body: { error: "boom" },
        },
      },
    });
    const section = sectionFor(
      await host.listProviderModels(),
      OLLAMA_PROVIDER_ID,
    );

    // Details are an enrichment. Losing the model over them would be worse than
    // showing it without badges.
    expect(section?.models).toHaveLength(1);
    expect(section?.models[0]?.capabilities.contextWindow).toBeUndefined();
    await db.close();
  });

  it("honours a custom URL from settings for both listing and probes", async () => {
    const { host, db, settings } = await harness({
      routes: { "http://192.168.1.50:22434": { body: TAGS_OK } },
    });
    await settings.setProvider(OLLAMA_PROVIDER_ID, {
      baseUrl: "http://192.168.1.50:22434/v1",
    });

    const section = sectionFor(
      await host.listProviderModels(true),
      OLLAMA_PROVIDER_ID,
    );
    expect(section?.status).toBe("connected");
    expect(section?.models).toHaveLength(1);
    await db.close();
  });
});

describe("a provider that rejects the key", () => {
  it("surfaces an auth error, and never echoes the key", async () => {
    const { host, db } = await harness({
      routes: {
        "https://openrouter.ai": {
          status: 401,
          body: { error: { message: "No auth credentials found" } },
        },
        "http://localhost:11434": { refuse: true },
      },
      providerId: "openrouter",
      keys: ["openrouter"],
    });
    const section = sectionFor(await host.listProviderModels(), "openrouter");

    // `error` rather than `unreachable`: the fix is a different key, not a retry.
    expect(section?.status).toBe("error");
    expect(section?.error).toBeTruthy();
    expect(section?.error).not.toContain(FIXTURE_KEY);
    expect(JSON.stringify(section)).not.toContain(FIXTURE_KEY);
    await db.close();
  });

  it("keeps cached models visible and marked stale when a refresh fails", async () => {
    const { host, db } = await harness({
      routes: {
        "https://openrouter.ai/api/v1/models": { body: OPENROUTER_MODELS },
        "http://localhost:11434": { refuse: true },
      },
      providerId: "openrouter",
      keys: ["openrouter"],
    });

    const first = sectionFor(await host.listProviderModels(), "openrouter");
    expect(first?.status).toBe("connected");
    expect(first?.models.length).toBeGreaterThan(0);

    // The network then fails on the next forced refresh.
    // A second host with the same key but a network that now rejects it. The key
    // has to be present, or the provider is `unconfigured` and never issues the
    // request that is supposed to fail.
    const secondSecrets = new MemorySecretStore();
    await secondSecrets.set("provider.openrouter.apiKey", FIXTURE_KEY);
    const failing = new LocalHost({
      db,
      secrets: secondSecrets,
      settings: new SettingsStore(db, { providerId: "openrouter" }),
      services: {
        env: {},
        ownKeys: {},
        fetch: fakeFetch({
          "https://openrouter.ai": { status: 401, body: {} },
        }),
      } as unknown as HostServices,
    });
    const second = sectionFor(
      await failing.listProviderModels(true),
      "openrouter",
    );

    // The point of the cache: the user still has a usable picker rather than an
    // empty dropdown, and the failure is not hidden.
    expect(second?.source).toBe("cache");
    expect(second?.stale).toBe(true);
    expect(second?.models.length).toBeGreaterThan(0);
    expect(second?.error).toBeTruthy();
    await db.close();
  });
});

describe("refreshing", () => {
  it("bypasses the in-memory catalog so the button does something", async () => {
    let calls = 0;
    const counting: typeof fetch = (async (input: string | URL | Request) => {
      calls += 1;
      void input;
      return new Response(JSON.stringify(TAGS_OK), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const db: Database = await migratedTestDatabase();
    const host = new LocalHost({
      db,
      secrets: new MemorySecretStore(),
      settings: new SettingsStore(db),
      services: {
        env: {},
        ownKeys: {},
        fetch: counting,
      } as unknown as HostServices,
    });

    await host.listProviderModels();
    const afterFirst = calls;
    await host.listProviderModels(true);
    // Without invalidation the second call is served from the in-memory catalog
    // and the Refresh button is a no-op.
    expect(calls).toBeGreaterThan(afterFirst);
    await db.close();
  });
});

describe("routing a choice to the provider that serves it", () => {
  it("records the provider alongside the model", async () => {
    const { db, host } = await harness({
      routes: HOSTED_ROUTES,
      keys: ["openrouter"],
    });
    try {
      // The whole reason this exists: a bare id cannot say where to send it.
      const next = await host.setModelForMode(
        "code",
        "local-coder:8b",
        "ollama",
      );
      expect(next.models.code).toBe("local-coder:8b");
      expect(next.models.providers.code).toBe("ollama");
    } finally {
      await db.close();
    }
  });

  it("finds the provider for a bare model id", async () => {
    const { db, host } = await harness({
      routes: HOSTED_ROUTES,
      keys: ["openrouter"],
    });
    try {
      const providerId = await host.providerForModel("some/model-a:free");
      expect(providerId).toBe("openrouter");
    } finally {
      await db.close();
    }
  });

  it("falls back to the active provider for an unknown id", async () => {
    const { db, host } = await harness({
      routes: HOSTED_ROUTES,
      keys: ["openrouter"],
    });
    try {
      // Better than failing here: the send path reports the real problem, with
      // the provider it actually tried.
      expect(await host.providerForModel("no-such-model")).toBe("opencode-zen");
    } finally {
      await db.close();
    }
  });

  it("reports nothing missing when the pinned model is present", async () => {
    const { db, host } = await harness({
      routes: HOSTED_ROUTES,
      keys: ["openrouter"],
    });
    try {
      await host.setModelForMode("chat", "some/model-a:free", "openrouter");
      expect(await host.selectionNotices()).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("reports a pinned model that vanished, with the replacement", async () => {
    const { db, host } = await harness({
      routes: HOSTED_ROUTES,
      keys: ["openrouter"],
    });
    try {
      await host.setModelForMode("chat", "some/model-b", "openrouter");
      // A model id that is genuinely absent from every configured catalog.
      await host.setModelForMode("code", "some/model-removed", "openrouter");
      const notices = await host.selectionNotices();
      expect(notices.map((entry) => entry.mode)).toEqual(["code"]);
      expect(notices[0]?.notice).toContain("some/model-removed");
      // The point: something is named, so nothing was swapped silently.
      expect(notices[0]?.effective).not.toBe("some/model-removed");
    } finally {
      await db.close();
    }
  });
});

describe("Ollama stopped, which is the state that must not lose the list", () => {
  it("keeps the cached models and says they are cached", async () => {
    // One database across both, the way a restart looks: the cache is the only
    // thing carried over.
    const running = await harness({ routes: { ...HOSTED_ROUTES } });
    const first = sectionFor(
      await running.host.listProviderModels(true),
      "ollama",
    );
    expect(first?.models.length).toBeGreaterThan(0);

    // A fresh host reading the same database, and a server no longer answering.
    // `refuse` is the real shape of a stopped Ollama: nothing on the port.
    const stopped = await harness({
      routes: { "http://localhost:11434": { refuse: true } },
      reuse: running.db,
    });
    try {
      const section = sectionFor(
        await stopped.host.listProviderModels(true),
        "ollama",
      );
      expect(section?.status).toBe("unreachable");
      // The whole point: an outage does not empty the picker.
      expect(section?.models.length).toBeGreaterThan(0);
      expect(section?.stale).toBe(true);
      // And the reason is the one that tells the user what to do about it.
      expect(section?.error).toMatch(/isn't running|ollama serve/i);
    } finally {
      await stopped.db.close();
    }
  });

  it("keeps the cache when a refresh is forced and the server is down", async () => {
    const running = await harness({ routes: { ...HOSTED_ROUTES } });
    await running.host.listProviderModels(true);

    const stopped = await harness({
      routes: { "http://localhost:11434": { refuse: true } },
      reuse: running.db,
    });
    try {
      const section = sectionFor(
        await stopped.host.listProviderModels(true),
        "ollama",
      );
      // Refresh must not be a way to throw away what the user is looking at.
      expect(section?.models.length).toBeGreaterThan(0);
    } finally {
      await stopped.db.close();
    }
  });
});

describe("a mode pinned to another provider's model", () => {
  it("records that provider on the conversation, not the global one", async () => {
    // The global provider is deliberately *not* the one the mode is pinned to,
    // otherwise the two would agree and the test would prove nothing.
    const { host, db, settings } = await harness({
      routes: { ...HOSTED_ROUTES },
      keys: ["openrouter"],
      providerId: "openrouter",
    });
    try {
      await settings.setModelForMode("chat", "some-zen-model", "opencode-zen");

      const conversation = await host.createConversation({ mode: "chat" });

      // Sends prefer the conversation's provider, so recording the global one
      // here would pin this conversation to the wrong provider for its whole
      // life -- every later send would go to OpenRouter with a Zen model id.
      expect(conversation.providerId).toBe("opencode-zen");
    } finally {
      await db.close();
    }
  });

  it("falls back to the global provider for a mode that was never pinned", async () => {
    const { host, db, settings } = await harness({
      routes: { ...HOSTED_ROUTES },
      keys: ["openrouter"],
      providerId: "openrouter",
    });
    try {
      const conversation = await host.createConversation({ mode: "chat" });
      expect(conversation.providerId).toBe("openrouter");
    } finally {
      await db.close();
    }
  });
});

describe("sections arriving independently", () => {
  it("reports each provider as it settles rather than all at the end", async () => {
    const { host, db } = await harness({
      routes: { ...HOSTED_ROUTES },
      keys: ["openrouter"],
    });
    try {
      const seen: string[] = [];
      const sections = await host.listProviderModels(false, (section) =>
        seen.push(section.provider.id),
      );

      // One call per provider, and the final array still agrees with it: a
      // caller that wants everything is not left with a partial list.
      expect(new Set(seen)).toEqual(
        new Set(sections.map((section) => section.provider.id)),
      );
      expect(seen.length).toBe(sections.length);
    } finally {
      await db.close();
    }
  });
});
