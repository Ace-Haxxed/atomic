/**
 * Port for secret storage.
 *
 * Implemented in the desktop app on top of the OS keychain
 * (macOS Keychain / Windows Credential Manager / Linux Secret Service).
 * Values are opaque strings; the interface deliberately has no "list" method so
 * secrets cannot be bulk-dumped.
 */

export interface SecretStore {
  /** Returns null when the secret is absent. Never throws for "not found". */
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Cheap availability probe, e.g. Secret Service running on Linux. */
  isAvailable(): Promise<boolean>;
  /**
   * Whether an environment variable holds a credential, with no value.
   *
   * Optional: a host that injects `HostServices.env` directly has nothing to
   * ask. Kept separate from `get` so the UI can render "reached by environment"
   * without any value entering its process.
   */
  hasEnv?(name: string): Promise<boolean>;
  /**
   * One environment variable's value, read on demand.
   *
   * Never called with a user-supplied name in a way the host cannot check: the
   * desktop implementation refuses anything outside its own allowlist, because
   * `apiKeyEnvVar` is editable and an unchecked read here would be a general
   * environment-variable exfiltration primitive.
   */
  readEnv?(name: string): Promise<string | null>;
}

/** In-memory fallback used by tests and headless mode. Never used in production. */
export class MemorySecretStore implements SecretStore {
  #values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.#values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** Namespaced so several providers can hold keys without colliding. */
export const SecretKeys = {
  zen: "provider.opencode-zen.apiKey",
  anthropic: "provider.anthropic.apiKey",
  openrouter: "provider.openrouter.apiKey",
  ollama: "provider.ollama.apiKey",
} as const;

/**
 * Where a provider's credential comes from.
 *
 * Three states the UI genuinely has to tell apart, none of which need a value:
 * a key in the OS keychain, a key in an environment variable the app can read,
 * and no key at all. Collapsing "env" into "saved" is what made the app look
 * misconfigured when it was working.
 */
export type ApiKeySource = "keychain" | "env" | "none";

/**
 * Build a keychain slot name.
 *
 * The single definition of the naming scheme, so a read and a write of the same
 * provider id cannot disagree about where the key lives.
 */
export function withProvider(providerId: string): string {
  return `provider.${providerId}.apiKey`;
}

/**
 * Provider ids Atomic has shipped under, and the slot an old build used.
 *
 * A key is written to the slot its *current* id names, so renaming a provider
 * silently orphans the one the user already saved: the field reads empty, they
 * paste the key again, and the old credential is stranded in the keychain where
 * nothing will ever look for it. Each entry here is read as a fallback and
 * adopted into the canonical slot, then removed.
 *
 * `google` is the live case in this tree: the provider is called Gemini in
 * `detect-key.ts` and Google everywhere else, so a build that shipped under
 * `gemini` wrote `provider.gemini.apiKey`.
 */
export const LEGACY_PROVIDER_IDS: Readonly<Record<string, readonly string[]>> = {
  google: ["gemini"],
  "opencode-zen": ["zen", "opencode"],
  anthropic: ["claude"],
};

/**
 * The canonical slot for a provider, plus any slot an earlier build used.
 *
 * Canonical first, so a freshly written key always wins over an adopted one.
 */
export function secretSlotsFor(providerId: string): readonly [string, ...string[]] {
  const canonical = withProvider(providerId);
  const legacy = (LEGACY_PROVIDER_IDS[providerId] ?? []).map((id) => withProvider(id));
  return [canonical, ...legacy.filter((slot) => slot !== canonical)];
}

/** Mask a secret for display: keeps a short prefix/suffix only. */
export function maskSecret(value: string | null): string {
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(8);
  return `${value.slice(0, 3)}${"•".repeat(Math.max(8, value.length - 7))}${value.slice(-4)}`;
}
