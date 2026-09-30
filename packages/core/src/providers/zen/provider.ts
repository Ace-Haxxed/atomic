/**
 * The OpenCode Zen provider.
 *
 * Responsibilities:
 *  - fetch the model list dynamically (Zen `/models`), enriched with models.dev
 *    metadata, cached in SQLite so the picker works offline
 *  - route each model to the right wire format
 *  - stream, with retries and rate-limit backoff handled by `HttpClient`
 *  - never log, never persist, never expose the API key
 */

import {
  ProviderError,
  ProviderErrorKind,
  toProviderError,
} from "../errors.js";
import { HttpClient, assertOk, redactUrl } from "../http.js";
import type {
  CredentialCheck,
  ModelCatalog,
  ModelInfo,
  Provider,
  ProviderCredentials,
  ProviderRequestOptions,
  WireFormat,
} from "../../models/provider.js";
import type {
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "../../models/types.js";
import {
  completeChat,
  streamChatCompletions,
  type OpenAiChatOptions,
} from "../wire/openai-chat.js";
import {
  completeResponsesApi,
  streamResponsesApi,
  type OpenAiResponsesOptions,
} from "../wire/openai-responses.js";
import {
  completeAnthropicMessages,
  streamAnthropicMessages,
  type AnthropicOptions,
} from "../wire/anthropic-messages.js";
import {
  completeGoogleGenerate,
  streamGoogleGenerate,
  type GoogleOptions,
} from "../wire/google-generative.js";
import {
  SUGGESTED_MODELS,
  ZEN_BASE_URL,
  ZEN_PROVIDER_ID,
  isNonChatModel,
  resolveWireFormat,
} from "./catalog.js";
import {
  MODELS_DEV_URL,
  buildModelInfo,
  extractOpencodeProvider,
  readModelMetadata,
  type ZenModelMetadata,
} from "./models-dev.js";
import {
  ZEN_PRICING_SOURCE,
  ZEN_PRICING_URL,
  normalizeModelName,
  parseZenPricing,
} from "./published-pricing.js";
import {
  EMPTY_AVAILABILITY,
  applyAvailability,
  invalidateAtomicAvailability,
  normalizeAvailability,
  isAtomicGated,
  markSuspect,
  markReachable,
  type AtomicAvailability,
} from "./atomic-availability.js";
import type { Database } from "../../storage/database.js";

/** Metadata refresh interval. The model list changes rarely. */
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;

const CATALOG_CACHE_KEY = "zen.catalog";
const MODELS_DEV_CACHE_KEY = "zen.modelsdev";

/** Second-priority pricing signal: Zen's own published table. */
const PUBLISHED_PRICING_CACHE_KEY = "zen.publishedpricing";

/** What Atomic has learned from real calls about which models it can reach. */
const AVAILABILITY_CACHE_KEY = "zen.atomicavailability";

/**
 * How many models to try before giving up on the probe.
 *
 * Enough to walk past a disabled model or two, few enough that testing a key
 * cannot turn into a burst of billable requests.
 */
const MAX_PROBE_CANDIDATES = 4;

/**
 * How long a scrape of the docs page stays good.
 *
 * Longer than the machine-readable feed, because the docs change by hand and
 * far less often than the feed does.
 */
const PUBLISHED_PRICING_TTL_MS = 24 * 60 * 60 * 1000;

export interface ZenProviderDeps {
  /**
   * How to route a model id this provider serves.
   *
   * Zen publishes a model table, so it uses it. Any other endpoint means the
   * same id is served differently there, so the provider's own dialect wins.
   */
  readonly defaultWireFormat?: WireFormat | undefined;
  /**
   * Whether this provider publishes Zen's model routing table. Defaults to true
   * because this *is* the Zen provider; a caller serving another endpoint opts
   * out explicitly, so the Zen path never needs to know it is the default.
   */
  readonly hasRoutingTable?: boolean | undefined;
  readonly db?: Database | undefined;
  readonly fetch?: typeof fetch | undefined;
  /**
   * Retry policy for retryable responses.
   *
   * Exposed so a caller can bound the cost of a request. Left unset, the HTTP
   * client retries 429 and 5xx with backoff, which is right in production and
   * wrong in a test that deliberately makes a dozen failing calls.
   */
  readonly retries?: number | undefined;
  /** Environment variables, for BYO-key models and env-based auth. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly onUsage?: (usage: {
    model: string;
    input: number;
    output: number;
  }) => void;
}

export class ZenProvider implements Provider {
  readonly id = ZEN_PROVIDER_ID;
  readonly name = "OpenCode Zen";
  readonly baseUrl: string;

  /** Where to list models. Defaults to `<baseUrl>/models`. */
  #modelsUrl: string;
  #http: HttpClient;
  #defaultWireFormat: WireFormat;
  #hasRoutingTable: boolean;
  #db: Database | undefined;
  #env: Readonly<Record<string, string | undefined>>;
  #now: () => number;
  #onUsage: ZenProviderDeps["onUsage"];
  #apiKey: string | null;
  #ownKeys: Readonly<Record<string, string>>;

  #catalog: ModelCatalog | undefined;
  #catalogInFlight: Promise<ModelCatalog> | undefined;
  /**
   * Set by `invalidateCatalog`, consumed by the next load.
   *
   * Clearing the in-memory field alone is not a refresh: the SQLite copy is
   * served for another six hours, so the Refresh button would look broken for
   * most of a session. This is what makes it actually re-request.
   */
  #forceNext = false;
  #modelsDev: { provider: unknown; fetchedAt: number } | undefined;
  #availability: AtomicAvailability = EMPTY_AVAILABILITY;

  constructor(credentials: ProviderCredentials, deps: ZenProviderDeps = {}) {
    this.baseUrl = trimSlash(credentials.baseUrl?.trim() || ZEN_BASE_URL);
    // The catalog endpoint follows the base URL. Hard-coding Zen's made the
    // provider unusable for anyone else's key, which is the whole point of
    // letting a pasted key pick the provider.
    this.#modelsUrl = `${this.baseUrl}/models`;
    this.#defaultWireFormat = deps.defaultWireFormat ?? "openai-chat";
    this.#hasRoutingTable = deps.hasRoutingTable ?? true;
    this.#apiKey = resolveApiKey(credentials.apiKey, deps.env, this.name);
    this.#ownKeys = credentials.ownKeys ?? {};
    this.#db = deps.db;
    this.#env = deps.env ?? {};
    this.#now = deps.now ?? (() => Date.now());
    this.#onUsage = deps.onUsage;
    this.#http = new HttpClient({
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.retries !== undefined ? { retries: deps.retries } : {}),
      onRequest: ({ url }) => {
        // Only the redacted URL is ever surfaced.
        void redactUrl(url);
      },
    });
  }

  /**
   * Whether a real call has already proved this model unusable from here.
   *
   * Read from the loaded record only. A miss is not a clean bill of health --
   * it means nobody has tried -- so this is consulted to avoid a known-bad
   * request, never to promise a good one.
   */
  isModelBlocked(modelId: string): boolean {
    return modelId in this.#availability.blocked;
  }

  get hasApiKey(): boolean {
    return Boolean(this.#apiKey) || Object.keys(this.#ownKeys).length > 0;
  }

  /** Model ids, most capable first, for the model picker. */
  supportsModel(modelId: string): boolean {
    if (isNonChatModel(modelId)) return false;
    const catalog = this.#catalog;
    if (!catalog) return true; // unknown until the list arrives; let the request decide
    return catalog.models.some((model) => model.id === modelId);
  }

  async listModels(signal?: AbortSignal): Promise<ModelCatalog> {
    if (this.#catalog) return this.#catalog;
    if (!this.#catalogInFlight) {
      this.#catalogInFlight = this.#loadCatalog(signal).finally(() => {
        this.#catalogInFlight = undefined;
      });
    }
    this.#catalog = await this.#catalogInFlight;
    return this.#catalog;
  }

  /**
   * Forget the catalog, including the SQLite copy, so the next `listModels`
   * really re-requests it rather than serving a cache that is still within TTL.
   */
  invalidateCatalog(): void {
    this.#catalog = undefined;
    this.#forceNext = true;
  }

  async #loadCatalog(signal?: AbortSignal): Promise<ModelCatalog> {
    const force = this.#forceNext;
    this.#forceNext = false;
    // A forced refresh is the user asking to check the world again, which
    // includes re-testing the models we had written off.
    await this.#loadAvailability(force);
    const cached = await this.#readCache<ModelCatalog>(CATALOG_CACHE_KEY);
    if (!force && cached && this.#now() - cached.fetchedAt < CATALOG_TTL_MS) {
      // Served from SQLite, so reported as a cache read. It is not `stale`: it is
      // within its TTL, and `fetchedAt` is what the UI shows as "last refreshed".
      return {
        ...cached,
        models: this.#stamp(cached.models),
        source: "cache",
        stale: false,
      };
    }

    try {
      const ids = await this.#fetchModelIds(signal);
      const metadata = await this.#fetchModelsDev(signal);
      const published = await this.#fetchPublishedPricing(signal);
      const models = ids
        .filter((id) => !isNonChatModel(id))
        .map((id) => {
          const npm = metadata?.models?.[id]?.npm;
          const wireFormat = this.#routeWireFormat(id, npm);
          const modelMetadata = readModelMetadata(
            metadata?.provider,
            id,
            wireFormat,
          );
          const info = buildModelInfo(id, wireFormat, modelMetadata);
          const priced = this.#publishedPriceFor(published, info.name, id);
          return priced ? { ...info, publishedPricing: priced } : info;
        });
      // What Zen serves, kept separate from what Atomic has learned about it.
      // Persisting the marks would make them impossible to take back: a stale
      // read would keep serving a model the user has just refreshed away.
      const catalog: ModelCatalog = {
        models: rankModels(models),
        fetchedAt: this.#now(),
        source: "api",
      };
      await this.#writeCache(CATALOG_CACHE_KEY, catalog);
      return { ...catalog, models: this.#stamp(catalog.models) };
    } catch (error) {
      // A stale cache is better than nothing, but say so.
      if (cached) {
        return {
          ...cached,
          models: this.#stamp(cached.models),
          source: "cache",
          stale: true,
          error: describeFailure(error),
          errorKind: toProviderError(error).kind,
        };
      }
      // Offline with no cache: still give the user a usable picker. The reason
      // rides along so the UI can explain that these are guesses, not results.
      const fallback = rankModels(
        Object.entries(SUGGESTED_MODELS).map(([mode, id]) =>
          buildModelInfo(id, this.#routeWireFormat(id)),
        ),
      ).filter(
        (model, index, all) =>
          all.findIndex((m) => m.id === model.id) === index,
      );
      return {
        models: this.#stamp(fallback),
        fetchedAt: this.#now(),
        source: "fallback",
        error: describeFailure(error),
        errorKind: toProviderError(error).kind,
      };
    }
  }

  async #fetchModelIds(signal?: AbortSignal): Promise<string[]> {
    const response = await this.#http.request(
      { url: this.#modelsUrl, signal, retries: 2 },
      this.id,
    );
    if (!response.ok) {
      // A custom base URL may not serve /models; fall back to models.dev.
      await assertOk(response, this.#modelsUrl);
    }
    const payload = (await response.json()) as
      { data?: { id?: string }[] } | { id?: string }[];
    const rows = Array.isArray(payload) ? payload : (payload.data ?? []);
    const ids = rows
      .map((row) => (typeof row === "string" ? row : row.id))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0)
      throw new ProviderError(
        ProviderErrorKind.parse,
        "empty_catalog",
        "No models returned",
      );
    return ids;
  }

  async #fetchModelsDev(
    signal?: AbortSignal,
  ): Promise<ModelsDevIndex | undefined> {
    const cached = await this.#readCache<{
      provider: unknown;
      fetchedAt: number;
    }>(MODELS_DEV_CACHE_KEY);
    const payload =
      cached && this.#now() - cached.fetchedAt < MODELS_DEV_TTL_MS
        ? cached
        : undefined;
    const source = payload?.provider ?? (await this.#tryFetchModelsDev(signal));
    if (!source) return undefined;
    await this.#writeCache(MODELS_DEV_CACHE_KEY, {
      provider: source,
      fetchedAt: this.#now(),
    });
    const provider = extractOpencodeProvider(source);
    if (!provider) return undefined;
    return { provider, models: this.#indexNpm(provider) };
  }

  /**
   * Load what we previously learned, once per refresh cycle.
   *
   * `recheck` means the user asked us to find out again, so it discards rather
   * than loads -- re-reading here would undo the invalidation in the same breath
   * and leave the model blocked by an observation the user just asked to
   * retest.
   */
  async #loadAvailability(recheck = false): Promise<void> {
    if (recheck) {
      this.#availability = invalidateAtomicAvailability();
      // The stored copy has to go too. Clearing only this instance would make
      // a refresh look like it worked right up until the next launch, which
      // then resurrected exactly the model the user just asked to try again --
      // and the retry would fail for a reason that is now invisible.
      await this.#deleteCache(AVAILABILITY_CACHE_KEY);
      return;
    }
    if (this.#availability !== EMPTY_AVAILABILITY) return;
    const cached = await this.#readCache<AtomicAvailability>(
      AVAILABILITY_CACHE_KEY,
    );
    // Normalised on read, not trusted as-is. The `suspect` map was added after
    // rows were already being written, and a row without it would be adopted
    // whole -- so `availability.suspect[modelId]` would throw on the first
    // refusal seen after an upgrade, taking the send down with it.
    if (cached?.blocked) this.#availability = normalizeAvailability(cached);
  }

  /** Attach the learned facts to each model. */
  #stamp(models: readonly ModelInfo[]): ModelInfo[] {
    return models.map((model) => applyAvailability(model, this.#availability));
  }

  /**
   * Record one observation, and persist it so the next launch knows too.
   *
   * The in-memory catalog is dropped as well. `listModels` memoises it, so
   * without this a model blocked halfway through a session would keep being
   * offered for the rest of it -- the note would only appear after a restart,
   * which is exactly when the user has stopped looking for it. The next read
   * comes from SQLite, which is cheap.
   */
  async #observe(next: AtomicAvailability): Promise<void> {
    this.#availability = next;
    this.#catalog = undefined;
    await this.#writeCache(AVAILABILITY_CACHE_KEY, next);
  }

  /**
   * Learn from a real call.
   *
   * `unauthenticated` matters: a success only proves the model needs no
   * credential if none was sent. The same model succeeding with a key on file
   * says nothing about whether Atomic can reach it without one.
   */
  async #record(
    modelId: string,
    outcome: { refused: string } | { reachable: true },
  ): Promise<void> {
    const current = this.#availability;
    const next =
      "refused" in outcome
        ? markSuspect(
            current,
            modelId,
            outcome.refused,
            new Date(this.#now()).toISOString(),
          )
        : markReachable(current, modelId);
    if (next === current) return;
    await this.#observe(next);
  }

  /**
   * Fetch Zen's published pricing table, cached and entirely best-effort.
   *
   * Runs in parallel with nothing else on purpose: it is the weakest signal, so
   * it must never be able to slow down or fail a catalog load. A failure yields
   * `undefined`, which leaves every model on the two stronger signals.
   */
  async #fetchPublishedPricing(
    signal?: AbortSignal,
  ): Promise<
    | ReadonlyMap<string, { free: boolean; input?: number; output?: number }>
    | undefined
  > {
    const cached = await this.#readCache<{
      prices: Record<
        string,
        { free: boolean; input?: number; output?: number }
      >;
      fetchedAt: number;
    }>(PUBLISHED_PRICING_CACHE_KEY);
    const fresh =
      cached && this.#now() - cached.fetchedAt < PUBLISHED_PRICING_TTL_MS;
    if (fresh) return new Map(Object.entries(cached!.prices));

    const parsed = await this.#tryFetchPublishedPricing(signal);
    if (!parsed)
      return cached ? new Map(Object.entries(cached.prices)) : undefined;
    await this.#writeCache(PUBLISHED_PRICING_CACHE_KEY, {
      prices: Object.fromEntries(parsed.prices),
      fetchedAt: this.#now(),
    });
    return parsed.prices;
  }

  async #tryFetchPublishedPricing(
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof parseZenPricing>> {
    try {
      const response = await this.#http.request(
        { url: ZEN_PRICING_URL, signal, retries: 1, timeoutMs: 15_000 },
        this.id,
      );
      if (!response.ok) return null;
      return parseZenPricing(await response.text());
    } catch {
      return null;
    }
  }

  /**
   * Match a catalog entry to a row in the published table.
   *
   * The table is keyed by display name, so the name is the primary join. The
   * normalised id is tried as a fallback because a few rows are labelled with
   * something closer to the id than to the feed's display name.
   */
  #publishedPriceFor(
    prices:
      | ReadonlyMap<string, { free: boolean; input?: number; output?: number }>
      | undefined,
    name: string,
    id: string,
  ):
    | {
        readonly free: boolean;
        readonly source: string;
        readonly fetchedAt: string;
      }
    | undefined {
    if (!prices) return undefined;
    const price =
      prices.get(normalizeModelName(name)) ??
      prices.get(normalizeModelName(id));
    if (!price) return undefined;
    return {
      free: price.free,
      source: ZEN_PRICING_SOURCE,
      fetchedAt: new Date(this.#now()).toISOString(),
    };
  }

  async #tryFetchModelsDev(
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.#http.request(
        { url: MODELS_DEV_URL, signal, retries: 1, timeoutMs: 15_000 },
        this.id,
      );
      if (!response.ok) return undefined;
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  #indexNpm(provider: unknown): Record<string, { npm?: string }> {
    const models =
      (provider as { models?: Record<string, { provider?: { npm?: string } }> })
        ?.models ?? {};
    const out: Record<string, { npm?: string }> = {};
    for (const [id, entry] of Object.entries(models)) {
      const npm = entry?.provider?.npm;
      out[id] = npm ? { npm } : {};
    }
    return out;
  }

  async #readCache<T>(key: string): Promise<T | undefined> {
    if (!this.#db) return undefined;
    try {
      const rows = await this.#db.select<{ payload: string }>(
        "SELECT payload FROM model_cache WHERE provider_id = ?",
        [key],
      );
      const row = rows[0];
      return row ? (JSON.parse(row.payload) as T) : undefined;
    } catch {
      return undefined;
    }
  }

  async #deleteCache(key: string): Promise<void> {
    if (!this.#db) return;
    try {
      await this.#db.execute("DELETE FROM model_cache WHERE provider_id = ?", [
        key,
      ]);
    } catch {
      // Caching is best-effort; a stale block is recoverable, a failed refresh
      // of the catalog itself is not, and that is handled elsewhere.
    }
  }

  async #writeCache(key: string, value: unknown): Promise<void> {
    if (!this.#db) return;
    try {
      await this.#db.execute(
        `INSERT INTO model_cache (provider_id, payload, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT (provider_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
        [key, JSON.stringify(value), this.#now()],
      );
    } catch {
      // Caching is best-effort.
    }
  }

  /**
   * Which endpoint this model goes to.
   *
   * `EXACT_ROUTING` is Zen's own routing table, so it only applies to Zen. On a
   * different provider the same id means something else -- OpenRouter fronts
   * `gpt-*` through one endpoint -- and trusting the table there produces a 404
   * on an otherwise valid key. So: the table for Zen, the provider's declared
   * dialect for everyone else, with the name heuristic only as a tie-break.
   */
  /**
   * One place that decides the endpoint, so the picker and the request path
   * cannot drift apart and disagree about where a model lives.
   */
  #routeWireFormat(modelId: string, npmHint?: string | undefined): WireFormat {
    return this.#hasRoutingTable
      ? resolveWireFormat(modelId, npmHint)
      : this.#defaultWireFormat;
  }

  async #resolveWireFormatFor(modelId: string): Promise<WireFormat> {
    if (this.#catalog?.models.some((model) => model.id === modelId)) {
      const found = this.#catalog.models.find((model) => model.id === modelId);
      if (found) return found.wireFormat;
    }
    const index = await this.#fetchModelsDev();
    return this.#routeWireFormat(modelId, index?.models?.[modelId]?.npm);
  }

  /**
   * The bring-your-own key for a model, if one is configured.
   *
   * A missing key is deliberately *not* an error here. Verified against the live
   * API: several Zen free models -- `space-bunny-free` among them -- return a
   * complete 200 stream with no credential at all, while others return 401
   * "Missing API key." and one (`big-pickle`) is gated to OpenCode's own client
   * with a 403. The app cannot know which is which before it asks, so refusing
   * to ask would lock the user out of models that work perfectly well.
   *
   * What it will not do is *invent* a credential. With no key the auth header is
   * omitted rather than sent as an empty `Bearer `, and if the provider does
   * reject the request, `#rethrow` re-labels the failure as a missing key --
   * which is then true, and which the user can act on.
   */
  async #resolveOwnKey(
    modelId: string,
    options: ProviderRequestOptions | undefined,
  ): Promise<string | undefined> {
    return options?.ownKey ?? this.#ownKeys[modelId];
  }

  /** Whether this request actually carries a credential. */
  #sentCredential(ownKey: string | undefined): boolean {
    return Boolean(this.#apiKey || ownKey);
  }

  /**
   * Turn a refusal into something learned about this model, when it is the kind
   * of refusal that will not change by itself.
   *
   * Only the free-tier gate is counted. Everything else describes the request or
   * the moment rather than the model, and recording those is how a working model
   * ends up greyed out: a 401 is a key, a 429 is a rate limit, a 5xx or a
   * timeout is the network, and a generic one-off 403 is a gateway having a
   * moment. None of those are evidence about the model, and none of them are
   * written down.
   *
   * Even the gate is not a fact on first contact. It is counted; see
   * `REFUSALS_TO_CONFIRM`. `space-bunny-free` was written off by one such 403 and
   * then answered a real request minutes later.
   */
  async #learnFrom(
    error: unknown,
    modelId: string,
    ownKey: string | undefined,
  ): Promise<void> {
    const failure = toProviderError(error);
    if (isAtomicGated(failure)) {
      await this.#record(modelId, { refused: failure.message });
    }
  }

  /**
   * Turn a 401 into the truth about what was sent.
   *
   * A 401 only means "your key was refused" if a key was sent. When none was,
   * it means no key was saved -- and "check your key in Settings" is advice for
   * a key that does not exist. This is the whole reason a missing key used to be
   * reported as a rejected one.
   */
  #rethrow(error: unknown, ownKey: string | undefined): never {
    const failure = toProviderError(error);
    if (failure.status === 401 && !this.#sentCredential(ownKey)) {
      throw new ProviderError(
        ProviderErrorKind.missingCredential,
        "no_api_key",
        `No API key saved for ${this.name}. Add one in Settings → Models.`,
      );
    }
    throw failure;
  }

  /**
   * Prove the key works, by spending one real request on it.
   *
   * `GET /models` is public on Zen -- it answers 200 to an anonymous caller --
   * so a successful catalog fetch says nothing about the credential. This sends
   * the smallest possible authenticated completion instead.
   *
   * Candidates are tried cheapest-first and a model-specific refusal moves on to
   * the next one, because a workspace can disable individual models: a 403 on
   * the first candidate must not be reported as a bad key. Only a 401 is taken
   * as proof about the key, and only after a 404/403 on every candidate is the
   * problem reported as "this model is unavailable".
   */
  async verifyCredentials(signal?: AbortSignal): Promise<CredentialCheck> {
    if (!this.hasApiKey) {
      return {
        status: "no-key",
        model: "",
        detail:
          "No OpenCode Zen API key saved yet. Add one in Settings \u2192 Models.",
      };
    }

    const { models: candidates, unavailable } = await this.#probeCandidates();
    // A catalog that failed is a stronger fact than anything a probe against a
    // guessed model list could tell us. An offline machine must not be told its
    // key is bad, so this reports the catalog failure instead of guessing.
    if (unavailable) {
      const failure = toProviderError(
        new ProviderError(
          (unavailable.errorKind ?? "network") as ProviderErrorKind,
          "catalog_unavailable",
          unavailable.error ?? "The model list could not be read.",
        ),
      );
      if (failure.kind === "auth") {
        return {
          status: "rejected",
          model: "",
          detail: failure.message,
          httpStatus: failure.status ?? 401,
        };
      }
      if (failure.kind === "rate-limit") {
        return { status: "rate-limited", model: "", detail: failure.message };
      }
      return {
        status: "network",
        model: "",
        detail: `Could not reach ${redactUrl(this.baseUrl)} to test the key. ${failure.message}`,
      };
    }

    const probeModel = candidates[0]?.id ?? "";
    if (candidates.length === 0) {
      return {
        status: "model-unavailable",
        model: probeModel,
        detail:
          "The model list came back empty, so there was no model to test the key with.",
        httpStatus: 0,
      };
    }

    let lastRefusal: CredentialCheck | null = null;
    for (const model of candidates) {
      const outcome = await this.#probeOnce(model, signal);
      if (outcome.status === "continue") {
        lastRefusal = {
          status: "model-unavailable",
          model: model.id,
          detail: `${model.name} is not available to this key.`,
          httpStatus: outcome.httpStatus,
        };
        continue;
      }
      return outcome.check;
    }
    return (
      lastRefusal ?? {
        status: "model-unavailable",
        model: probeModel,
        detail: "No model on this provider is available to this key.",
        httpStatus: 0,
      }
    );
  }

  /**
   * Cheapest-first probe candidates: free models first, then anything else.
   *
   * Also reports a catalog that could not be read, because a catalog serving a
   * guessed fallback list has said nothing about the key -- probing a model id
   * we invented would produce a confident, wrong answer.
   */
  async #probeCandidates(): Promise<{
    models: readonly ModelInfo[];
    unavailable: ModelCatalog | null;
  }> {
    let catalog: ModelCatalog;
    try {
      catalog = await this.listModels();
    } catch {
      return { models: [], unavailable: null };
    }
    // A cached-but-stale list is still evidence about which models exist, so it
    // stays usable. A `fallback` list is a guess and a guess must not decide
    // whether a key is good.
    if (catalog.source === "fallback")
      return { models: [], unavailable: catalog };
    const free = catalog.models.filter(
      (model) => model.capabilities?.free === true,
    );
    const rest = catalog.models.filter(
      (model) => model.capabilities?.free !== true,
    );
    return {
      models: [...free, ...rest].slice(0, MAX_PROBE_CANDIDATES),
      unavailable: null,
    };
  }

  async #probeOnce(
    model: ModelInfo,
    signal: AbortSignal | undefined,
  ): Promise<
    | { status: "continue"; httpStatus: number }
    | { status: "done"; check: CredentialCheck }
  > {
    const request: ModelRequest = {
      providerId: this.id,
      model: model.id,
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
      maxOutputTokens: 1,
      ...(signal ? { signal } : {}),
    };
    try {
      await this.complete(request);
      return {
        status: "done",
        check: {
          status: "valid",
          model: model.id,
          detail: `Key accepted. Verified with ${model.name}.`,
        },
      };
    } catch (error) {
      const failure = toProviderError(error);
      // 403 and 404 are both about the model, not the key: a workspace admin can
      // disable a model, and a catalog can list one the key cannot reach. Try
      // the next candidate rather than accusing the user of a bad key.
      if (
        failure.status === 403 ||
        failure.status === 404 ||
        failure.kind === "unsupported-model"
      ) {
        return { status: "continue", httpStatus: failure.status ?? 0 };
      }
      if (failure.status === 401 || failure.kind === "auth") {
        return {
          status: "done",
          check: {
            status: "rejected",
            model: model.id,
            detail: failure.message || "The provider rejected this API key.",
            httpStatus: failure.status ?? 401,
          },
        };
      }
      if (failure.status === 429 || failure.kind === "rate-limit") {
        return {
          status: "done",
          check: {
            status: "rate-limited",
            model: model.id,
            detail:
              "The key is being rate limited right now. Wait a moment and test again.",
            ...(failure.retryAfterMs !== undefined
              ? { retryAfterMs: failure.retryAfterMs }
              : {}),
          },
        };
      }
      if (failure.kind === "network" || failure.kind === "timeout") {
        return {
          status: "done",
          check: {
            status: "network",
            model: model.id,
            detail: `Could not reach ${redactUrl(this.baseUrl)}. Check your connection or proxy settings.`,
          },
        };
      }
      return {
        status: "done",
        check: {
          status: "rejected",
          model: model.id,
          detail: failure.userMessage,
          httpStatus: failure.status ?? 0,
        },
      };
    }
  }

  async complete(
    request: ModelRequest,
    options?: ProviderRequestOptions,
  ): Promise<ModelResponse> {
    const wireFormat = await this.#resolveWireFormatFor(request.model);
    const ownKey = await this.#resolveOwnKey(request.model, options);
    const withSignal = withSignalFrom(request, options);
    let response: ModelResponse;
    try {
      switch (wireFormat) {
        case "openai-responses":
          response = await completeResponsesApi(
            this.#responsesOptions(ownKey),
            withSignal,
          );
          break;
        case "anthropic-messages":
          response = await completeAnthropicMessages(
            this.#anthropicOptions(ownKey),
            withSignal,
          );
          break;
        case "google-generative":
          response = await completeGoogleGenerate(
            this.#googleOptions(ownKey),
            withSignal,
          );
          break;
        default:
          response = await completeChat(this.#chatOptions(ownKey), withSignal);
      }
    } catch (error) {
      await this.#learnFrom(error, request.model, ownKey);
      this.#rethrow(error, ownKey);
    }
    // A success only teaches us something when no credential was sent.
    if (!this.#sentCredential(ownKey)) {
      await this.#record(request.model, { reachable: true });
    }
    this.#onUsage?.({
      model: request.model,
      input: response.usage.inputTokens,
      output: response.usage.outputTokens,
    });
    return response;
  }

  stream(
    request: ModelRequest,
    options?: ProviderRequestOptions,
  ): AsyncIterable<StreamEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const wireFormat = await self.#resolveWireFormatFor(request.model);
        const ownKey = await self.#resolveOwnKey(request.model, options);
        const withSignal = withSignalFrom(request, options);
        let iterator: AsyncIterator<StreamEvent>;
        try {
          // The opening chunk is pulled here rather than left to the loop below,
          // so a 401 on the first response is re-labelled before any event --
          // including an empty "started" one -- reaches the transcript.
          iterator = self
            .#streamWith(wireFormat, ownKey, withSignal)
            [Symbol.asyncIterator]();
          const first = await iterator.next();
          if (first.done) return;
          if (!self.#sentCredential(ownKey)) {
            await self.#record(request.model, { reachable: true });
          }
          yield first.value;
        } catch (error) {
          await self.#learnFrom(error, request.model, ownKey);
          // Rethrows; `#rethrow` is total. The `throw` keeps the control flow
          // obvious to a reader and to the compiler.
          self.#rethrow(error, ownKey);
          throw error;
        }
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          if (next.value.type === "done") {
            self.#onUsage?.({
              model: request.model,
              input: next.value.usage.inputTokens,
              output: next.value.usage.outputTokens,
            });
          }
          yield next.value;
        }
      },
    };
  }

  #streamWith(
    wireFormat: WireFormat,
    ownKey: string | undefined,
    request: ModelRequest,
  ): AsyncGenerator<StreamEvent> {
    switch (wireFormat) {
      case "openai-responses":
        return streamResponsesApi(this.#responsesOptions(ownKey), request);
      case "anthropic-messages":
        return streamAnthropicMessages(this.#anthropicOptions(ownKey), request);
      case "google-generative":
        return streamGoogleGenerate(this.#googleOptions(ownKey), request);
      case "systemone":
        throw unsupportedStructuredModel(request.model);
      default:
        return streamChatCompletions(this.#chatOptions(ownKey), request);
    }
  }

  #chatOptions(ownKey: string | undefined): OpenAiChatOptions {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.#apiKey ?? "",
      http: this.#http,
      providerId: this.id,
      ownKey,
    };
  }

  #responsesOptions(ownKey: string | undefined): OpenAiResponsesOptions {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.#apiKey ?? "",
      http: this.#http,
      providerId: this.id,
      ownKey,
    };
  }

  #anthropicOptions(ownKey: string | undefined): AnthropicOptions {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.#apiKey ?? "",
      http: this.#http,
      providerId: this.id,
      ownKey,
    };
  }

  #googleOptions(ownKey: string | undefined): GoogleOptions {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.#apiKey ?? "",
      http: this.#http,
      providerId: this.id,
      ownKey,
    };
  }
}

function unsupportedStructuredModel(modelId: string): ProviderError {
  return new ProviderError(
    "unsupported-model",
    "unsupported_model",
    `${modelId} is a structured-decision model and cannot be used as a chat model.`,
  );
}

function withSignalFrom(
  request: ModelRequest,
  options: ProviderRequestOptions | undefined,
): ModelRequest {
  const signal = options?.signal ?? request.signal;
  return signal && signal !== request.signal ? { ...request, signal } : request;
}

interface ModelsDevIndex {
  readonly provider: Record<string, unknown> | undefined;
  readonly models: Record<string, { npm?: string }>;
}

/** A/B for ranking the model picker. */
const FAMILY_RANK: Readonly<Record<string, number>> = {
  "claude-opus": 0,
  "gpt-5.3-codex": 1,
  "gpt-6": 2,
  "claude-sonnet": 3,
  "gpt-5.6": 4,
  "gpt-5.5": 5,
  "gpt-5.4": 6,
  "gpt-5.1-codex-max": 7,
  grok: 8,
  gemini: 9,
  kimi: 10,
  glm: 11,
  deepseek: 12,
  qwen: 13,
  minimax: 14,
};

function rankModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    const byFamily = familyRank(a.id) - familyRank(b.id);
    if (byFamily !== 0) return byFamily;
    if (a.cost?.input !== b.cost?.input)
      return (b.cost?.input ?? 0) - (a.cost?.input ?? 0);
    return a.id.localeCompare(b.id);
  });
}

/**
 * A one-line, redaction-safe reason for why the catalog could not be fetched.
 *
 * `ProviderError` messages are already written to avoid quoting a key, so the
 * message is safe to show. A bare `TypeError` from `fetch` ("Load failed") is not
 * useful on its own, so it gets the kind and code alongside it.
 */
function describeFailure(error: unknown): string {
  if (error instanceof ProviderError) {
    const status = error.status ? ` (HTTP ${error.status})` : "";
    return `${error.message}${status} [${error.code}]`;
  }
  if (error instanceof Error) {
    // A TypeError with no message is a webview network failure: the classic
    // CORS-shaped error, and the one that made this look like "no models".
    const detail = error.message.trim();
    return detail
      ? `${error.name}: ${detail}`
      : `${error.name}: the request could not be completed (network or CORS).`;
  }
  return "The request could not be completed.";
}

function familyRank(id: string): number {
  const lower = id.toLowerCase();
  for (const [prefix, rank] of Object.entries(FAMILY_RANK)) {
    if (lower.startsWith(prefix)) return rank;
  }
  return 50;
}

/**
 * Pick the key to send, from the keychain or the environment.
 *
 * Whitespace is checked again here, not only when the key was saved, because
 * the key already in the keychain was written before the save-time check
 * existed. Repairing it only on the next save would leave every already-broken
 * key 401ing with no way for the user to tell why.
 *
 * Interior whitespace is refused rather than stripped. A newline in the middle
 * of a credential means the paste was mangled -- a soft-wrapped line, two keys
 * pasted together -- and deleting the whitespace would produce a key that looks
 * completely plausible and can only ever be rejected. The provider name is
 * threaded in so the message can be specific.
 */
function resolveApiKey(
  provided: string | null | undefined,
  env: Readonly<Record<string, string | undefined>> | undefined,
  providerLabel: string,
): string | null {
  const trimmed = provided?.trim();
  if (trimmed) {
    if (/\s/.test(trimmed)) {
      throw new ProviderError(
        ProviderErrorKind.config,
        "api_key_interior_whitespace",
        `Saved key looks malformed; re-paste it. (${providerLabel})`,
      );
    }
    return trimmed;
  }
  const fromEnv = env?.OPENCODE_API_KEY?.trim();
  if (fromEnv && /\s/.test(fromEnv)) {
    throw new ProviderError(
      ProviderErrorKind.config,
      "api_key_interior_whitespace",
      "Saved key looks malformed; re-paste it.",
    );
  }
  return fromEnv || null;
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export { resolveWireFormat, isNonChatModel };
export type { ZenModelMetadata };
