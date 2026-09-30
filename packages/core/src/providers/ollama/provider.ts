/**
 * The Ollama provider.
 *
 * Ollama is the one provider that needs no credential, which is why it gets its
 * own class rather than a `ZenProvider` configured differently: its model
 * listing is not an OpenAI `/models` response, its details live behind a second
 * per-model endpoint, and it has management operations -- pull, delete -- that
 * no hosted provider offers.
 *
 * Completions still go through Ollama's OpenAI-compatible surface, so the agent
 * loop's `openai-chat` path and the rest of the app's provider-aware routing are
 * unchanged. Only the listing and the management calls are native.
 *
 * The key is never required, never read and never sent: there is nothing to read
 * it from.
 */

import { HttpClient, assertOk } from "../http.js";
import { ProviderError, ProviderErrorKind, toProviderError } from "../errors.js";
import { completeChat, streamChatCompletions, type OpenAiChatOptions } from "../wire/openai-chat.js";
import type {
  ModelCatalog,
  ModelInfo,
  Provider,
  ProviderCredentials,
  ProviderRequestOptions,
  WireFormat,
} from "../../models/provider.js";
import type { ModelRequest, ModelResponse, StreamEvent } from "../../models/types.js";
import type { Database } from "../../storage/database.js";
import {
  OLLAMA_DEFAULT_ROOT,
  OLLAMA_PROVIDER_ID as OLLAMA_ID,
  formatBytes,
  OllamaUrlError,
  ollamaRootFrom,
  parsePullLine,
  parseShow,
  parseTags,
  toModelInfo,
  type OllamaModelDetail,
  type OllamaPullProgress,
} from "./catalog.js";

/** Installed models change on a pull or a delete, not on a schedule. */
const TAGS_TTL_MS = 60_000;
/** Per-model detail, keyed by model id. */
const SHOW_TTL_MS = 24 * 60 * 60 * 1000;

const TAGS_CACHE_KEY = "ollama.tags";
const showCacheKey = (id: string) => `ollama.show.${id}`;

export interface OllamaProviderDeps {
  readonly db?: Database | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly now?: () => number;
  readonly defaultWireFormat?: WireFormat | undefined;
  /**
   * Called with each line of a pull's progress stream. Invoked from the host, so
   * the UI can show a live progress bar without polling.
   */
  readonly onPullProgress?: ((progress: OllamaPullProgress) => void) | undefined;
}

export class OllamaProvider implements Provider {
  readonly id = OLLAMA_ID;
  readonly name = "Ollama (local)";
  /** OpenAI-compatible root, e.g. `http://localhost:11434/v1`. */
  readonly baseUrl: string;
  /** Native API root, e.g. `http://localhost:11434`. */
  readonly root: string;

  #http: HttpClient;
  #db: Database | undefined;
  #now: () => number;
  #wireFormat: WireFormat;
  #onPullProgress: OllamaProviderDeps["onPullProgress"] | undefined;
  #fetch: typeof fetch | undefined;

  #catalog: ModelCatalog | undefined;
  /** Set by `invalidateCatalog`; makes the next load ignore the tags TTL. */
  #forceNext = false;
  /** In-flight `/api/show` requests, so N rows do not fire N duplicate calls. */
  #showInFlight = new Map<string, Promise<OllamaModelDetail | undefined>>();

  constructor(credentials: Partial<ProviderCredentials> = {}, deps: OllamaProviderDeps = {}) {
    const configured = credentials.baseUrl?.trim() || OLLAMA_DEFAULT_ROOT;
    /*
     * A bad address is a configuration error, so it is raised as one. Left as a
     * raw parse failure it reached the user through whichever generic path
     * happened to catch it, which is how a typo in one Settings field became
     * "Ollama isn't running" -- advice about the one thing that was not wrong.
     */
    try {
      this.root = ollamaRootFrom(configured);
    } catch (error) {
      if (error instanceof OllamaUrlError) {
        throw new ProviderError(
          ProviderErrorKind.config,
          "ollama_bad_url",
          error.message,
          { cause: error, userMessage: error.message },
        );
      }
      throw error;
    }
    this.baseUrl = `${this.root}/v1`;
    this.#db = deps.db;
    this.#now = deps.now ?? (() => Date.now());
    this.#wireFormat = deps.defaultWireFormat ?? "openai-chat";
    this.#onPullProgress = deps.onPullProgress;
    this.#fetch = deps.fetch;
    this.#http = new HttpClient({
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      // A local server that is not running should fail immediately and visibly,
      // not after three retries with exponential backoff: the user is looking at
      // "Ollama isn't running", and a 30-second wait to be told so is the bug.
      retries: 0,
      // Loopback, so the default 120s timeout is a hang, not a safety net.
      timeoutMs: 5_000,
    });
  }

  get hasApiKey(): boolean {
    // Always true, and deliberately not a lie: a local provider is "configured"
    // by existing, which is what the Models tab keys off.
    return true;
  }

  supportsModel(modelId: string): boolean {
    if (!this.#catalog || this.#catalog.models.length === 0) return true;
    return this.#catalog.models.some((model) => model.id === modelId);
  }

  /**
   * Forget the catalog and ignore the tags TTL once.
   *
   * Without the flag, a pull followed immediately by Refresh would report the
   * pre-pull list, because the previous answer is still inside its 60s window.
   */
  invalidateCatalog(): void {
    this.#catalog = undefined;
    this.#forceNext = true;
  }

  /**
   * Installed models.
   *
   * Never throws. A server that is not running is a state the user needs to see
   * described, not an exception: the Models tab shows the reason inline and keeps
   * whatever it had cached, and the header dropdown shows a retry rather than
   * pretending the machine has no local models.
   */
  async listModels(signal?: AbortSignal): Promise<ModelCatalog> {
    if (this.#catalog) return this.#catalog;
    const force = this.#forceNext;
    this.#forceNext = false;
    const cached = await this.#readCache<{ models: unknown; fetchedAt: number }>(TAGS_CACHE_KEY);
    const fresh =
      !force && cached && this.#now() - cached.fetchedAt < TAGS_TTL_MS ? cached : undefined;

    try {
      const summaries = await this.#fetchTags(signal);
      const details = await Promise.all(
        summaries.map((summary) => this.#detailFor(summary.id, signal)),
      );
      const models = summaries.map((summary, index) =>
        toModelInfo(summary, details[index], this.#wireFormat),
      );
      const catalog: ModelCatalog = { models, fetchedAt: this.#now(), source: "api" };
      this.#catalog = catalog;
      await this.#writeCache(TAGS_CACHE_KEY, { models, fetchedAt: catalog.fetchedAt });
      return catalog;
    } catch (error) {
      if (cached) {
        // Stale, and labelled stale: the models are real, but they may no longer
        // be what is installed.
        return {
          models: (cached as { models: readonly ModelInfo[] }).models,
          fetchedAt: cached.fetchedAt,
          source: "cache",
          stale: true,
          error: this.#describe(error),
          errorKind: toProviderError(error).kind,
        };
      }
      return {
        models: [],
        fetchedAt: this.#now(),
        source: "fallback",
        error: this.#describe(error),
        errorKind: toProviderError(error).kind,
      };
    }
  }

  /**
   * Whether the server answered at all.
   *
   * Separate from `listModels` because "not running" and "nothing installed" need
   * different empty states, and a `listModels` fallback cannot tell them apart.
   */
  async probe(signal?: AbortSignal): Promise<{ readonly reachable: boolean; readonly url: string; readonly message?: string }> {
    try {
      const response = await this.#http.request({ url: `${this.root}/api/tags`, signal }, this.id);
      if (!response.ok) await assertOk(response, `${this.root}/api/tags`);
      return { reachable: true, url: this.root };
    } catch (error) {
      return { reachable: false, url: this.root, message: this.#describe(error) };
    }
  }

  // ---- management ------------------------------------------------------

  /**
   * Download a model, reporting progress as it goes.
   *
   * `stream: true` is what makes this a progress bar instead of a spinner that
   * sits there for four minutes. The response is newline-delimited JSON, read
   * incrementally; a line that fails to parse is skipped rather than fatal, so
   * one bad line does not throw away a download that is nearly done.
   */
  async pull(
    model: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    const target = model.trim();
    if (!target) return { ok: false, message: "Enter a model to pull." };

    const fetchImpl = this.#fetch;
    if (!fetchImpl) {
      return { ok: false, message: "Pulling models needs the app's HTTP transport." };
    }

    try {
      const response = await fetchImpl(`${this.root}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: target, stream: true }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) await assertOk(response, `${this.root}/api/pull`);

      const body = response.body;
      if (!body) {
        // No readable stream: the pull still ran, there is just nothing to show.
        this.#onPullProgress?.({ status: "success", done: true });
        this.invalidateCatalog();
        return { ok: true };
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawSuccess = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Ollama separates status objects with newlines, and a chunk boundary can
        // fall mid-line, so only complete lines are consumed.
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const progress = parsePullLine(line);
          if (progress) {
            if (progress.done) sawSuccess = true;
            this.#onPullProgress?.(progress);
          }
          newline = buffer.indexOf("\n");
        }
      }

      const tail = parsePullLine(buffer);
      if (tail) {
        if (tail.done) sawSuccess = true;
        this.#onPullProgress?.(tail);
      }

      if (!sawSuccess) {
        return {
          ok: false,
          message: `Ollama ended the pull of ${target} without reporting success.`,
        };
      }
      this.invalidateCatalog();
      return { ok: true };
    } catch (error) {
      if (isAbort(error)) return { ok: false, message: "Pull cancelled." };
      return { ok: false, message: this.#describe(error) };
    }
  }

  /** Remove an installed model. */
  async delete(model: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    const target = model.trim();
    if (!target) return { ok: false, message: "No model selected." };
    try {
      const response = await this.#http.request(
        {
          // DELETE, per the Ollama API. POST returns 405 on current servers.
          method: "DELETE",
          url: `${this.root}/api/delete`,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: target }),
        },
        this.id,
      );
      if (!response.ok) await assertOk(response, `${this.root}/api/delete`);
      this.invalidateCatalog();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: this.#describe(error) };
    }
  }

  // ---- completions -----------------------------------------------------

  async complete(request: ModelRequest, options?: ProviderRequestOptions): Promise<ModelResponse> {
    return completeChat(this.#chatOptions(), withSignal(request, options));
  }

  stream(request: ModelRequest, options?: ProviderRequestOptions): AsyncIterable<StreamEvent> {
    return streamChatCompletions(this.#chatOptions(), withSignal(request, options));
  }

  #chatOptions(): OpenAiChatOptions {
    return {
      baseUrl: this.baseUrl,
      // Ollama ignores the bearer token, but the OpenAI-shaped transport requires
      // the field, and sending an empty string is not a secret.
      apiKey: "",
      http: this.#http,
      providerId: this.id,
    };
  }

  // ---- internals -------------------------------------------------------

  async #fetchTags(signal?: AbortSignal) {
    const response = await this.#http.request({ url: `${this.root}/api/tags`, signal }, this.id);
    if (!response.ok) await assertOk(response, `${this.root}/api/tags`);
    return parseTags(await response.json());
  }

  /**
   * One model's details, from cache when possible.
   *
   * Deduped on the in-flight map as well as the cache: the Models tab renders
   * every installed model at once, and a machine with a dozen models would
   * otherwise fire a dozen identical `/api/show` requests for whichever ones were
   * cached but in flight.
   */
  async #detailFor(id: string, signal?: AbortSignal): Promise<OllamaModelDetail | undefined> {
    const key = showCacheKey(id);
    const cached = await this.#readCache<OllamaModelDetail & { fetchedAt: number }>(key);
    if (cached && this.#now() - cached.fetchedAt < SHOW_TTL_MS) {
      return { contextWindow: cached.contextWindow, capabilities: cached.capabilities };
    }

    const existing = this.#showInFlight.get(id);
    if (existing) return existing;

    const request = (async (): Promise<OllamaModelDetail | undefined> => {
      try {
        const response = await this.#http.request(
          {
            method: "POST",
            url: `${this.root}/api/show`,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: id }),
            signal,
          },
          this.id,
        );
        if (!response.ok) await assertOk(response, `${this.root}/api/show`);
        const detail = parseShow(await response.json());
        await this.#writeCache(key, { ...detail, fetchedAt: this.#now() });
        return detail;
      } catch {
        // Details are an enrichment, not a requirement. A model with no detail
        // still appears in the list, just without a context window or badges.
        return undefined;
      }
    })().finally(() => this.#showInFlight.delete(id));

    this.#showInFlight.set(id, request);
    return request;
  }

  #describe(error: unknown): string {
    const providerError = error instanceof ProviderError ? error : null;
    const base = providerError?.userMessage ?? (error instanceof Error ? error.message : String(error));

    // The one error worth rewriting. A refused connection is overwhelmingly
    // "the server is not running", and saying "network error" there sends people
    // to check their firewall instead of starting Ollama.
    if (providerError?.kind === ProviderErrorKind.network) {
      return `Ollama isn't running at ${this.root}. Start it with \`ollama serve\`, then retry.`;
    }
    return base;
  }

  async #readCache<T>(key: string): Promise<T | undefined> {
    if (!this.#db) return undefined;
    try {
      const rows = await this.#db.select<{ payload: string }>(
        "SELECT payload FROM model_cache WHERE provider_id = ?",
        [key],
      );
      return rows[0] ? (JSON.parse(rows[0].payload) as T) : undefined;
    } catch {
      return undefined;
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
      // Best-effort.
    }
  }
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof ProviderError && error.kind === ProviderErrorKind.cancelled)
  );
}

function withSignal(request: ModelRequest, options: ProviderRequestOptions | undefined): ModelRequest {
  const signal = options?.signal ?? request.signal;
  return signal ? { ...request, signal } : request;
}

export { OLLAMA_ID as OLLAMA_PROVIDER_ID, formatBytes };
