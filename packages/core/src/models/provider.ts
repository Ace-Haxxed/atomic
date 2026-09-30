/**
 * Provider abstraction.
 *
 * A provider is anything that can list models and stream a completion for a
 * given model. Zen is the first implementation; OpenRouter, Anthropic direct and
 * local Ollama plug in by implementing this interface and registering a factory.
 */

import type { ModelRequest, ModelResponse, StreamEvent, ToolSpec } from "./types.js";

export const WIRE_FORMATS = [
  /** POST {base}/chat/completions — OpenAI Chat Completions. */
  "openai-chat",
  /** POST {base}/responses — OpenAI Responses API. */
  "openai-responses",
  /** POST {base}/messages — Anthropic Messages. */
  "anthropic-messages",
  /** POST {base}/models/{model}:streamGenerateContent — Google Generative Language. */
  "google-generative",
  /** POST {base}/systemone — structured decision model, not a chat model. */
  "systemone",
] as const;

export type WireFormat = (typeof WIRE_FORMATS)[number];

export interface ModelCapabilities {
  readonly tools: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  /** Reasoning effort is settable, as opposed to reasoning always on. */
  readonly reasoningEffort: boolean;
  readonly streaming: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: boolean;
  readonly structuredOutput?: boolean;
  /** `true` when the model id ends in `-free` or is otherwise billed at zero. */
  readonly free?: boolean;
}

export interface ModelInfo {
  readonly id: string;
  /** Display name as reported by the provider, falling back to the id. */
  readonly name: string;
  readonly wireFormat: WireFormat;
  readonly capabilities: ModelCapabilities;
  /** USD per million tokens, when known. */
  readonly cost?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
  /**
   * Pricing as the provider's own documentation publishes it.
   *
   * Separate from `cost` because it is a weaker signal: it is scraped from a
   * docs page and keyed by display name, not by model id. It exists to cover
   * models the machine-readable feed has not priced yet, so it is consulted
   * after `cost` and before the name-suffix heuristic.
   */
  readonly publishedPricing?: {
    readonly free: boolean;
    /** Human-readable origin, shown in the freeness reason. */
    readonly source: string;
    /** ISO timestamp of the fetch, so a stale scrape is visible. */
    readonly fetchedAt: string;
  };
  /**
   * Atomic has called this model and been refused.
   *
   * Learned from traffic, not from a list -- see `atomic-availability.ts`. The
   * reason is the provider's own words, because "this one is broken" is not
   * something a user can act on and "OpenCode reserves this free model for its
   * own app" is.
   */
  readonly unavailableInAtomic?: { readonly reason: string; readonly since: string };
  /**
   * Atomic has been refused once by this model, but not confirmed.
   *
   * The single-refusal state, kept distinct from `unavailableInAtomic` because
   * the UI must be able to say "refused once, worth another try" and offer a
   * retry. A model here is still selectable, and still out of automatic rotation.
   */
  readonly suspectedInAtomic?: {
    readonly reason: string;
    readonly since: string;
    readonly count?: number;
  };
  /**
   * Atomic has completed a real call to this model with no credential.
   *
   * Distinct from being free: free is a claim about price, this is evidence that
   * we can actually use the model. Preferred among equally-ranked free models.
   */
  readonly verifiedReachable?: boolean;
  readonly description?: string;
  readonly releaseDate?: string;
  /** True when Zen routes this model to a first-party API and wants a BYO key. */
  readonly supportsOwnKey?: boolean;
}

export interface ModelCatalog {
  readonly models: readonly ModelInfo[];
  /** When the catalog was fetched, epoch ms. */
  readonly fetchedAt: number;
  /**
   * Where these models actually came from.
   *
   * Factual, and distinct from `stale`: a catalog read from SQLite within its TTL
   * is `cache` but not `stale`, and a catalog that was fetched and cached on the
   * last refresh is `api`. Collapsing the two is what makes a UI either warn
   * about a perfectly fresh list or claim a live one is cached.
   */
  readonly source: "api" | "cache" | "fallback";
  /**
   * True only when a refresh failed and these are the last known good models.
   *
   * The UI marks them stale and keeps them visible; it never hides them, because
   * an empty picker is worse than a slightly old one.
   */
  readonly stale?: boolean;
  /**
   * Why the catalog is a `fallback`, when it is one.
   *
   * The guessed model list is a courtesy, not a result. Carrying the reason
   * means the caller can show it instead of a silently-wrong picker.
   */
  readonly error?: string;
  /**
   * The failure category behind `error`.
   *
   * Carried as a kind rather than parsed back out of the message because the two
   * cases need different advice: a rejected key needs a new key, a dead network
   * needs a retry. Without this, every failure looks like "unreachable" and the
   * user re-enters a perfectly good key.
   */
  readonly errorKind?:
    | "auth"
    | "forbidden"
    | "rate-limit"
    | "network"
    | "timeout"
    | "server"
    | "invalid-request"
    | "not-found"
    | "cancelled"
    | "unsupported-model"
    | "parse"
    | "config"
    | "missing-credential";
}

export interface ProviderCredentials {
  /** API key. Read from the OS keychain; never persisted in SQLite, never logged. */
  readonly apiKey: string | null;
  /** Optional per-provider base URL override. */
  readonly baseUrl?: string | null;
  /** Bring-your-own-key overrides for models the gateway proxies to a first party. */
  readonly ownKeys?: Readonly<Record<string, string>> | undefined;
}

export interface ProviderRequestOptions {
  readonly signal?: AbortSignal;
  /** Overrides the provider's own key for one request (own-key models). */
  readonly ownKey?: string | undefined;
}

/**
 * Result of an authenticated reachability probe.
 *
 * `listModels` cannot answer this: Zen's `/models` is public and returns 200 to
 * anyone, so a catalog fetch "succeeds" with a key that is not a key at all.
 * Testing a credential therefore means spending a request on it, and the result
 * has to distinguish *why* it failed, because the four causes need four
 * different user actions.
 */
export type CredentialCheck =
  | { readonly status: "valid"; readonly model: string; readonly detail: string }
  | { readonly status: "rejected"; readonly model: string; readonly detail: string; readonly httpStatus: number }
  | { readonly status: "model-unavailable"; readonly model: string; readonly detail: string; readonly httpStatus: number }
  | { readonly status: "rate-limited"; readonly model: string; readonly detail: string; readonly retryAfterMs?: number }
  | { readonly status: "network"; readonly model: string; readonly detail: string }
  | { readonly status: "no-key"; readonly model: string; readonly detail: string };

export interface Provider {
  readonly id: string;
  readonly name: string;
  /** Base URL without a trailing slash. */
  readonly baseUrl: string;
  /** Fetch the model list. Should never throw; fall back to a cached/stub list. */
  listModels(signal?: AbortSignal): Promise<ModelCatalog>;
  /** Non-streaming completion. */
  complete(request: ModelRequest, options?: ProviderRequestOptions): Promise<ModelResponse>;
  /** Streaming completion. Yields `StreamEvent`s. */
  stream(request: ModelRequest, options?: ProviderRequestOptions): AsyncIterable<StreamEvent>;
  /** True when the provider can serve this model at all. */
  supportsModel(modelId: string): boolean;
  /**
   * Make one authenticated request to prove the credential works.
   *
   * Optional: a provider with no credential concept (a local Ollama) omits it,
   * and the host treats a missing implementation as "nothing to verify" rather
   * than as a failure.
   */
  verifyCredentials?(signal?: AbortSignal): Promise<CredentialCheck>;
  /**
   * False for a model this provider has already found unusable.
   *
   * Synchronous and in-memory on purpose: it is consulted between fallback
   * attempts, where a catalog fetch would cost more than the request it is
   * trying to avoid. Absent means "nothing learned", which the caller reads as
   * usable -- the safe direction, since a wrong `true` costs one failed request.
   */
  isModelBlocked?(modelId: string): boolean;
}

export interface ProviderFactory {
  (credentials: ProviderCredentials): Provider;
}

export type { ModelRequest, ModelResponse, StreamEvent, ToolSpec };
