/**
 * Key storage: one key per provider, saved without moving the app, and confirmed
 * by reading the credential store back.
 *
 * The bugs these lock down, all reported as the same symptom -- "every other
 * provider ends up using one or two keys":
 *
 *  - The "API keys" tab rendered `null`, so the only key field lived in Settings
 *    bound to the app's *current* provider. Storing a second key meant switching
 *    the app's provider first, which is what made the app look like it could hold
 *    one or two credentials at most.
 *  - Saving a key re-pointed the whole app at the provider the key's shape
 *    implied, moving the active provider out from under the running chat.
 *  - "Saved" was reported from the length of what was typed, never from the
 *    credential store, so a store that accepted a write and could not return it
 *    looked identical to a working one.
 *  - `env_provider_keys` handed the webview every provider key's *value* at
 *    startup, which put eleven live credentials in reach of any renderer bug.
 *
 * No key value appears in this file and none is asserted on. The fixtures are key
 * *shapes*; they are never sent anywhere real. The readback tests assert on
 * presence, which is the only thing the UI is allowed to learn.
 */

import { describe, expect, it } from "vitest";

import { LocalHost } from "./local.js";
import { SettingsStore } from "../settings/store.js";
import {
  MemorySecretStore,
  secretSlotsFor,
  withProvider,
  type SecretStore,
} from "../secrets/secret-store.js";
import { migratedTestDatabase } from "../storage/sqlite.test-support.js";
import type { HostServices } from "./ports.js";

/**
 * Key-shaped fixtures, one per provider whose prefix is unambiguous.
 *
 * Shaped so `detect-key.ts` recognises them, which matters: the point is that a
 * correctly-detected key still does not move the app.
 */
const ZEN_KEY = "oc_sk_00000000000000000000";
const GOOGLE_KEY = `AIza${"0".repeat(35)}`;
const OPENROUTER_KEY = `sk-or-v1-${"a".repeat(32)}`;

function services(env: Record<string, string> = {}): HostServices {
  return { env, ownKeys: {} } as unknown as HostServices;
}

async function harness(
  options: {
    secrets?: SecretStore;
    env?: Record<string, string>;
    providerId?: string;
  } = {},
) {
  const db = await migratedTestDatabase();
  const secrets = options.secrets ?? new MemorySecretStore();
  const settings = new SettingsStore(db, {
    providerId: options.providerId ?? "opencode-zen",
  });
  return {
    db,
    secrets,
    settings,
    host: new LocalHost({ db, secrets, settings, services: services(options.env) }),
  };
}

/** Records every slot touched, so "wrote here" is assertable without a value. */
class RecordingSecretStore extends MemorySecretStore {
  readonly writes: string[] = [];
  readonly deletes: string[] = [];
  override async set(key: string, value: string): Promise<void> {
    this.writes.push(key);
    await super.set(key, value);
  }
  override async delete(key: string): Promise<void> {
    this.deletes.push(key);
    await super.delete(key);
  }
}

/**
 * A store that reports success and loses the value.
 *
 * This is the Linux-without-a-Secret-Service shape the readback exists to catch,
 * and the reason "saved" cannot be inferred from the input.
 */
class LossySecretStore extends MemorySecretStore {
  override async set(): Promise<void> {
    // Accepted, discarded.
  }
}

describe("keys are scoped to a provider", () => {
  it("saves a second provider's key without touching the app's provider", async () => {
    const { host, settings } = await harness();
    const before = settings.get().providerId;

    await host.setApiKey("openrouter", OPENROUTER_KEY);
    await host.setApiKey("google", GOOGLE_KEY);

    // Three keys, three providers, and the app still points where it did.
    expect(await host.hasApiKey("opencode-zen")).toBe(false);
    expect(await host.hasApiKey("openrouter")).toBe(true);
    expect(await host.hasApiKey("google")).toBe(true);
    expect(settings.get().providerId).toBe(before);
  });

  it("keeps two providers' keys in two different slots", async () => {
    const { host, secrets } = await harness();
    await host.setApiKey("google", GOOGLE_KEY);
    await host.setApiKey("openrouter", OPENROUTER_KEY);

    expect(await secrets.get(withProvider("google"))).not.toBeNull();
    expect(await secrets.get(withProvider("openrouter"))).not.toBeNull();
    expect(secretSlotsFor("google")[0]).not.toBe(secretSlotsFor("openrouter")[0]);
  });

  it("clears one provider's key without disturbing another's", async () => {
    const { host, secrets } = await harness();
    await host.setApiKey("google", GOOGLE_KEY);
    await host.setApiKey("openrouter", OPENROUTER_KEY);

    await host.setApiKey("google", null);

    expect(await secrets.get(withProvider("google"))).toBeNull();
    expect(await secrets.get(withProvider("openrouter"))).not.toBeNull();
    expect(await host.hasApiKey("google")).toBe(false);
    expect(await host.hasApiKey("openrouter")).toBe(true);
  });

  it("refuses a key saved for a provider that is not in the registry", async () => {
    const { host, secrets } = await harness();
    // Not a silent success into a slot nothing will read.
    await expect(host.setApiKey("not-a-provider", ZEN_KEY)).rejects.toThrow();
    expect(await secrets.get(withProvider("not-a-provider"))).toBeNull();
  });
});

describe("a save is confirmed by reading the store back", () => {
  it("reports an unconfirmed write as a failure", async () => {
    const { host } = await harness({ secrets: new LossySecretStore() });
    await expect(host.setApiKey("google", GOOGLE_KEY)).rejects.toThrow(
      /credential store accepted the write but did not return it/i,
    );
  });

  it("reports an unavailable credential store instead of claiming a save", async () => {
    const secrets = new MemorySecretStore();
    secrets.isAvailable = async () => false;
    const { host } = await harness({ secrets });

    await expect(host.setApiKey("google", GOOGLE_KEY)).rejects.toThrow(
      /credential store is not available/i,
    );
    // Nothing written, so a later successful attempt is not fighting a ghost.
    expect(await host.hasApiKey("google")).toBe(false);
  });

  it("reports a delete that did not happen", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(withProvider("google"), GOOGLE_KEY);
    secrets.delete = async () => undefined;
    const { host } = await harness({ secrets });

    await expect(host.setApiKey("google", null)).rejects.toThrow(/did not clear/i);
  });

  it("hasApiKey answers from the store, not from the last write", async () => {
    const { host, secrets } = await harness();
    await host.setApiKey("google", GOOGLE_KEY);
    expect(await host.hasApiKey("google")).toBe(true);

    // Something else cleared the slot behind the app's back.
    await secrets.delete(withProvider("google"));
    expect(await host.hasApiKey("google")).toBe(false);
  });
});

describe("legacy slots are adopted, not orphaned", () => {
  it("reads a key from a provider's former slot and moves it forward", async () => {
    const secrets = new MemorySecretStore();
    // A build that shipped before the provider was renamed.
    await secrets.set(withProvider("gemini"), GOOGLE_KEY);
    const { host } = await harness({ secrets });

    expect(await host.hasApiKey("google")).toBe(true);
    // Adopted forward and cleaned up, so the key is not left in two places.
    expect(await secrets.get(withProvider("google"))).not.toBeNull();
    expect(await secrets.get(withProvider("gemini"))).toBeNull();
  });

  it("prefers the current slot over a legacy one", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(withProvider("gemini"), "AIza" + "1".repeat(35));
    await secrets.set(withProvider("google"), GOOGLE_KEY);
    const { host } = await harness({ secrets });

    await host.setApiKey("google", GOOGLE_KEY);
    expect(await secrets.get(withProvider("google"))).toBe(GOOGLE_KEY);
  });

  it("adopts once, so a second read does not depend on the migration", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(withProvider("gemini"), GOOGLE_KEY);
    const { host } = await harness({ secrets });

    expect(await host.hasApiKey("google")).toBe(true);
    expect(await host.hasApiKey("google")).toBe(true);
  });

  it("a write to the current slot never lands in a legacy one", async () => {
    const store = new RecordingSecretStore();
    const { host } = await harness({ secrets: store });

    await host.setApiKey("google", GOOGLE_KEY);

    expect(store.writes).toEqual([withProvider("google")]);
    expect(store.deletes).not.toContain(withProvider("gemini"));
  });
});

describe("apiKeySources separates keychain, environment and nothing", () => {
  it("distinguishes a saved key from an environment key from neither", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(withProvider("google"), GOOGLE_KEY);
    const { host } = await harness({ secrets, env: { OPENROUTER_API_KEY: "x" } });

    const sources = await host.apiKeySources();

    expect(sources.google).toBe("keychain");
    expect(sources.openrouter).toBe("env");
    expect(sources.anthropic).toBe("none");
  });

  it("treats a keyless local provider as needing nothing", async () => {
    const { host } = await harness();
    expect((await host.apiKeySources()).ollama).toBe("none");
  });

  it("never returns a value, only the three states", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(withProvider("google"), GOOGLE_KEY);
    const { host } = await harness({ secrets });

    const sources = await host.apiKeySources();

    for (const value of Object.values(sources)) {
      expect(["keychain", "env", "none"]).toContain(value);
    }
    // The whole record is JSON-safe, so nothing can hide a credential in it.
    expect(JSON.stringify(sources)).not.toContain(GOOGLE_KEY);
  });

  it("counts a keyless provider as reachable in providerKeyStatus", async () => {
    const { host } = await harness();
    const keys = await host.providerKeyStatus();
    expect(keys.ollama).toBe(true);
    expect(keys.google).toBe(false);
  });
});

describe("environment credentials are read on demand", () => {
  it("prefers the store's presence answer over an injected env map", async () => {
    const secrets = new MemorySecretStore();
    secrets.hasEnv = async (name) => name === "MISTRAL_API_KEY";
    secrets.readEnv = async (name) => (name === "MISTRAL_API_KEY" ? "from-store" : null);
    const { host } = await harness({ secrets, env: { MISTRAL_API_KEY: "from-map" } });

    expect((await host.apiKeySources()).mistral).toBe("env");
  });

  it("falls back to the injected env map when the store cannot answer", async () => {
    const { host } = await harness({ env: { DEEPSEEK_API_KEY: "x" } });
    expect((await host.apiKeySources()).deepseek).toBe("env");
  });
});
