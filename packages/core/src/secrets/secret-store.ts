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
 * Build a keychain slot name.
 *
 * The single definition of the naming scheme, so a read and a write of the same
 * provider id cannot disagree about where the key lives.
 */
export function withProvider(providerId: string): string {
  return `provider.${providerId}.apiKey`;
}

/** Mask a secret for display: keeps a short prefix/suffix only. */
export function maskSecret(value: string | null): string {
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(8);
  return `${value.slice(0, 3)}${"•".repeat(Math.max(8, value.length - 7))}${value.slice(-4)}`;
}
