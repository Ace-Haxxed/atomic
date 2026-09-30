/**
 * A key that was never saved, or was saved broken, must not reach the wire.
 *
 * Two separate failures, both of which reached the user as the same opaque
 * "Your API key was rejected. Check it in Settings → Models.":
 *
 * 1. No key at all. A guard did exist and did stop the request before the
 *    network, but it threw with the `auth` error kind -- whose user-facing text
 *    says the provider *refused* the key. Nothing was sent, so nothing could be
 *    refused, and the advice given (re-paste a key that was never entered) could
 *    not possibly work.
 *
 *    That guard has since been relaxed, because the live API says a missing key
 *    is not always fatal: `space-bunny-free` streams a complete reply with no
 *    credential at all. What is now guaranteed is that no empty credential is
 *    ever sent, and that a 401 is reported as the missing key it really is.
 * 2. A mangled key. A soft-wrapped paste leaves a newline in the middle. The
 *    save path was fixed, but every key already in the keychain was written
 *    before that fix existed, so read-time validation is the only thing that
 *    reaches them.
 *
 * No key value appears in this file, and no test reads a real keychain. The
 * one value any test does put on the wire is a literal fixture, and the header
 * assertions check presence and shape -- never content.
 */

import { describe, expect, it, vi } from "vitest";

import { LocalHost } from "./local.js";
import { SettingsStore } from "../settings/store.js";
import {
  MemorySecretStore,
  SecretKeys,
  withProvider,
} from "../secrets/secret-store.js";
import { migratedTestDatabase } from "../storage/sqlite.test-support.js";
import { ZenProvider } from "../providers/zen/provider.js";
import { ProviderErrorKind } from "../providers/errors.js";
import type { HostServices } from "./ports.js";
import type { ModelRequest } from "../models/types.js";

const CATALOG = { data: [{ id: "big-pickle" }, { id: "space-bunny-free" }] };
const MODELS_DEV = {
  opencode: {
    models: {
      "big-pickle": {
        id: "big-pickle",
        name: "Big Pickle",
        cost: { input: 0, output: 0 },
        tool_call: true,
      },
      "space-bunny-free": {
        id: "space-bunny-free",
        name: "Space Bunny Free",
        cost: { input: 0, output: 0 },
      },
    },
  },
};

const REQUEST: ModelRequest = {
  providerId: "opencode-zen",
  model: "big-pickle",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxOutputTokens: 1,
};

interface WireCall {
  readonly url: string;
  /** Whether a credential was attached. Never the value. */
  readonly hadAuthHeader: boolean;
}

/**
 * A stand-in for the network that records what was sent.
 *
 * Recording the *presence* of the Authorization header rather than its value is
 * deliberate: a test that held the header could print it, and these tests exist
 * precisely so nobody has to.
 */
function recordingFetch(): { fetch: typeof fetch; sent: WireCall[] } {
  const sent: WireCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    sent.push({
      url,
      hadAuthHeader: new Headers(init?.headers).has("authorization"),
    });
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
    if (url.includes("/docs/zen")) {
      return new Response("<html>no pricing table here</html>");
    }
    return new Response(
      JSON.stringify({
        id: "r1",
        model: "big-pickle",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, sent };
}

async function makeHost(seedKey?: string) {
  const db = await migratedTestDatabase();
  const secrets = new MemorySecretStore();
  if (seedKey !== undefined) await secrets.set(SecretKeys.zen, seedKey);
  const settings = new SettingsStore(db, { providerId: "opencode-zen" });
  const { fetch, sent } = recordingFetch();
  const services = { env: {}, ownKeys: {}, fetch } as unknown as HostServices;
  return {
    db,
    secrets,
    sent,
    instance: new LocalHost({ db, secrets, settings, services }),
  };
}

/** A provider wired to the recording network, so nothing reaches the internet. */
function offlineProvider(
  credentials: ConstructorParameters<typeof ZenProvider>[0],
) {
  const { fetch, sent } = recordingFetch();
  return { provider: new ZenProvider(credentials, { fetch }), sent };
}

/**
 * A network that fails the completions call the way Zen does, so the error
 * mapping can be exercised against a real status code.
 */
function rejectingFetch(status: number, body: unknown) {
  const { fetch, sent } = recordingFetch();
  const wrapped = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    sent.push({
      url,
      hadAuthHeader: new Headers(init?.headers).has("authorization"),
    });
    if (url.includes("/chat/completions")) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return fetch(input, init);
  }) as unknown as typeof fetch;
  return { fetch: wrapped, sent };
}

describe("a provider with no key never claims a credential it does not have", () => {
  it("sends no Authorization header at all, rather than an empty one", async () => {
    // An empty `Bearer ` asserts a token and supplies none. Verified live: Zen
    // does not need the header for some models, and sends nothing useful for
    // others -- so omitting it is both honest and harmless.
    const { fetch, sent } = recordingFetch();
    const provider = new ZenProvider({ apiKey: null }, { fetch });
    await provider.complete(REQUEST);
    const completions = sent.filter((call) =>
      call.url.includes("/chat/completions"),
    );
    expect(completions).toHaveLength(1);
    expect(completions[0].hadAuthHeader).toBe(false);
  });

  it("still works for a model that needs no credential", async () => {
    // Verified live: `space-bunny-free` returns a full 200 completion with no
    // key. A provider that refused to try would lock the user out of it for no
    // reason, so the request is made and the answer is believed.
    const { provider, sent } = offlineProvider({ apiKey: null });
    const response = await provider.complete(REQUEST);
    expect(JSON.stringify(response.message)).toContain("hi");
    expect(sent.filter((call) => call.hadAuthHeader)).toEqual([]);
  });

  it("reports a 401 as a missing key, not as a rejected one", async () => {
    // The bug, from the other side. `auth` renders as "Your API key was
    // rejected. Check it in Settings" -- wrong, because no key was ever sent.
    const { fetch, sent } = rejectingFetch(401, {
      type: "error",
      error: { type: "AuthError", message: "Missing API key." },
    });
    const provider = new ZenProvider({ apiKey: null }, { fetch });
    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      kind: ProviderErrorKind.missingCredential,
      message:
        "No API key saved for OpenCode Zen. Add one in Settings → Models.",
    });
    // It really was a 401 on the wire; only the label changed.
    expect(
      sent.filter((call) => call.url.includes("/chat/completions")),
    ).toHaveLength(1);
  });

  it("keeps calling a genuinely rejected key 'rejected'", async () => {
    // The mirror image, and the reason the mapping cannot just always say
    // "missing": a key that *was* sent and *was* refused stays `auth`.
    const { fetch } = rejectingFetch(401, {
      type: "error",
      error: { type: "AuthError", message: "Invalid API key." },
    });
    const provider = new ZenProvider(
      { apiKey: "fixture-rejected-key" },
      { fetch },
    );
    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      kind: ProviderErrorKind.auth,
    });
  });

  it("re-labels a 401 on the streaming path before any event is shown", async () => {
    const { fetch } = rejectingFetch(401, {
      type: "error",
      error: { type: "AuthError", message: "Missing API key." },
    });
    const provider = new ZenProvider({ apiKey: null }, { fetch });
    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of provider.stream(REQUEST)) events.push(event);
      })(),
    ).rejects.toThrow(/No API key saved/);
    // Nothing partial reaches the transcript.
    expect(events).toEqual([]);
  });
});

describe("a provider with a bring-your-own key still works", () => {
  it("still works for a model Zen proxies, using a bring-your-own key", async () => {
    // A BYO key is the credential for those models, so demanding a Zen key on
    // top of it would be wrong.
    const { provider, sent } = offlineProvider({
      apiKey: null,
      ownKeys: { "big-pickle": "fixture-byo-key" },
    });
    const response = await provider.complete(REQUEST);
    expect(JSON.stringify(response.message)).toContain("hi");
    const completions = sent.filter((call) =>
      call.url.includes("/chat/completions"),
    );
    expect(completions).toHaveLength(1);
    expect(completions[0].hadAuthHeader).toBe(true);
  });
});

describe("a key already in the keychain is validated on the way out", () => {
  it("rejects a stored key with interior whitespace, naming it as malformed", () => {
    // A soft-wrapped paste. The save path rejects it now, but every key already
    // stored was written before that check existed, so it has to be caught here
    // too or those users keep 401ing with no explanation.
    expect(() => new ZenProvider({ apiKey: "sk-abc\ndef" })).toThrow(
      /Saved key looks malformed; re-paste it/,
    );
  });

  it("accepts a stored key with only surrounding whitespace", async () => {
    // A trailing newline is the common, harmless case and must keep working.
    const { provider, sent } = offlineProvider({
      apiKey: "  sk-fixture-ok  \n",
    });
    await provider.complete(REQUEST);
    expect(
      sent.filter((call) => call.url.includes("/chat/completions")),
    ).toHaveLength(1);
  });

  it("refuses a mangled key that came from the environment too", () => {
    expect(
      () =>
        new ZenProvider(
          { apiKey: null },
          { env: { OPENCODE_API_KEY: "sk-abc\ndef" } },
        ),
    ).toThrow(/Saved key looks malformed; re-paste it/);
  });
});

describe("a key is read from the slot it was written to", () => {
  it("round-trips a save for the Zen provider", async () => {
    // A save that wrote to a different slot than the read uses would leave the
    // app saying "no key" immediately after a successful save. Proved through
    // the public API, which is the only observable a user would notice.
    const { db, instance } = await makeHost();
    try {
      expect((await instance.testConnection("opencode-zen")).outcome).toBe(
        "no-key",
      );
      await instance.setApiKey("opencode-zen", "sk-round-trip");
      expect((await instance.testConnection("opencode-zen")).outcome).not.toBe(
        "no-key",
      );
    } finally {
      await db.close();
    }
  });

  it("clears the same slot it wrote, so clearing cannot miss", async () => {
    const { db, instance } = await makeHost();
    try {
      await instance.setApiKey("opencode-zen", "sk-round-trip");
      await instance.setApiKey("opencode-zen", null);
      expect((await instance.testConnection("opencode-zen")).outcome).toBe(
        "no-key",
      );
    } finally {
      await db.close();
    }
  });

  it("derives every declared slot from one naming scheme", () => {
    // The invariant that makes a read/write split impossible: a slot either
    // comes from SecretKeys or from the shared template, and the template
    // produces exactly the declared strings.
    for (const slot of Object.values(SecretKeys)) {
      expect(slot.endsWith(".apiKey")).toBe(true);
    }
    expect(withProvider("opencode-zen")).toBe(SecretKeys.zen);
    expect(withProvider("anthropic")).toBe(SecretKeys.anthropic);
    expect(withProvider("openrouter")).toBe(SecretKeys.openrouter);
    expect(withProvider("ollama")).toBe(SecretKeys.ollama);
  });

  it("gives each provider its own slot rather than a shared one", async () => {
    const db = await migratedTestDatabase();
    const secrets = new MemorySecretStore();
    const settings = new SettingsStore(db, { providerId: "opencode-zen" });
    const services = {
      env: {},
      ownKeys: {},
      fetch: vi.fn(),
    } as unknown as HostServices;
    const instance = new LocalHost({ db, secrets, settings, services });
    try {
      await instance.setApiKey("google", "AIza-example");
      await instance.setApiKey("opencode-zen", "sk-y");
      // Two providers must not collide on one slot.
      expect(await secrets.get(withProvider("google"))).toBe("AIza-example");
      expect(await secrets.get(SecretKeys.zen)).toBe("sk-y");
    } finally {
      await db.close();
    }
  });

  it("refuses to store a key for a provider this build does not have", async () => {
    // Writing one used to succeed, which parked a credential in a slot nothing
    // would ever read and left the user believing they had saved it.
    const db = await migratedTestDatabase();
    const secrets = new MemorySecretStore();
    const settings = new SettingsStore(db, { providerId: "opencode-zen" });
    const services = {
      env: {},
      ownKeys: {},
      fetch: vi.fn(),
    } as unknown as HostServices;
    const instance = new LocalHost({ db, secrets, settings, services });
    try {
      await expect(
        instance.setApiKey("some-new-provider", "sk-x"),
      ).rejects.toThrow();
      expect(await secrets.get(withProvider("some-new-provider"))).toBeNull();
    } finally {
      await db.close();
    }
  });
});
