/**
 * HTTP helper for provider calls.
 *
 * Responsibilities: bearer auth, timeouts, abort propagation, exponential backoff
 * with jitter, and surfacing rate-limit / retry-after information without ever
 * putting the key in an error message.
 */

import { ProviderError, ProviderErrorKind } from "./errors.js";
import { reportProviderFailure } from "./diagnostics.js";

export interface HttpRequestInit {
  // DELETE is here for Ollama's `/api/delete`, which specifies DELETE with a
  // request body -- the only provider call that needs it.
  readonly method?: "GET" | "POST" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  /** Overall request timeout. Streaming responses ignore this after headers. */
  readonly timeoutMs?: number;
  /** Number of retries for retryable failures. */
  readonly retries?: number;
  readonly idempotent?: boolean;
  /**
   * Debug context for a failing call. Header *names* only; values are never
   * accepted here, so it is not possible to log a credential through this path.
   */
  readonly diagnostics?: {
    readonly dialect: string;
    readonly authHeader: string;
  };
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIES = 3;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;

export class HttpClient {
  #fetch: FetchLike;
  #defaultTimeoutMs: number;
  #defaultRetries: number;
  #onRequest?: (info: { providerId: string; url: string }) => void;

  constructor(
    options: {
      fetch?: FetchLike;
      timeoutMs?: number;
      retries?: number;
      onRequest?: (info: { providerId: string; url: string }) => void;
    } = {},
  ) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#defaultRetries = options.retries ?? DEFAULT_RETRIES;
    this.#onRequest = options.onRequest;
  }

  /**
   * Log a failed call, with the body redacted.
   *
   * No-ops unless diagnostics are enabled, which is the case only in
   * development builds -- so a production user never pays for this and never
   * sees a provider's error page in their console.
   */
  async #reportFailure(
    init: HttpRequestInit,
    response: Response,
    providerId: string,
  ): Promise<void> {
    const context = init.diagnostics;
    if (!context) return;
    let body: string | undefined;
    try {
      body = (await response.clone().text()).slice(0, 2048);
    } catch {
      // A body that cannot be read twice is not worth a second failure.
    }
    reportProviderFailure({
      providerId,
      url: redactUrl(init.url),
      method: init.method ?? "GET",
      status: response.status,
      dialect: context.dialect,
      authHeader: context.authHeader,
      ...(body !== undefined ? { body } : {}),
    });
  }

  async request(
    init: HttpRequestInit,
    providerId = "unknown",
  ): Promise<Response> {
    const retries = init.retries ?? this.#defaultRetries;
    const timeoutMs = init.timeoutMs ?? this.#defaultTimeoutMs;
    let lastError: ProviderError | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (init.signal?.aborted) throw abortError();
      try {
        const response = await this.#attempt(init, timeoutMs);
        if (!response.ok) await this.#reportFailure(init, response, providerId);
        if (
          response.status === 429 ||
          (response.status >= 500 && response.status < 600)
        ) {
          const error = await this.#toError(response, init.url, attempt);
          // A 429 without Retry-After is not worth hammering.
          if (
            attempt >= retries ||
            (response.status === 429 && error.retryAfterMs === undefined)
          ) {
            throw error;
          }
          lastError = error;
          await sleep(computeBackoff(attempt, error.retryAfterMs), init.signal);
          continue;
        }
        return response;
      } catch (error) {
        if (error instanceof ProviderError && error.kind === "cancelled")
          throw error;
        if (
          error instanceof ProviderError &&
          error.kind !== "rate-limit" &&
          error.kind !== "server"
        ) {
          throw error;
        }
        lastError =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                ProviderErrorKind.network,
                "network_error",
                retryableMessage(error),
                {
                  cause: error,
                },
              );
        if (attempt >= retries) break;
        await sleep(
          computeBackoff(attempt, lastError.retryAfterMs),
          init.signal,
        );
      }
    }
    throw (
      lastError ??
      new ProviderError(
        ProviderErrorKind.network,
        "network_error",
        "request failed",
      )
    );
  }

  async #attempt(init: HttpRequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("timeout")),
      timeoutMs,
    );

    const url = redactUrl(init.url);
    this.#onRequest?.({ providerId: init.method ?? "unknown", url });

    try {
      const response = await this.#fetch(init.url, {
        method: init.method ?? (init.body ? "POST" : "GET"),
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
        // Providers must never receive cookies from the user's browser session.
        credentials: "omit",
        redirect: "follow",
      });
      return response;
    } catch (error) {
      if (init.signal?.aborted) throw abortError();
      if (controller.signal.aborted) {
        throw new ProviderError(
          ProviderErrorKind.timeout,
          "timeout",
          `Request timed out after ${timeoutMs}ms`,
          {
            cause: error,
          },
        );
      }
      throw new ProviderError(
        ProviderErrorKind.network,
        "network_error",
        retryableMessage(error),
        {
          cause: error,
        },
      );
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  async #toError(
    response: Response,
    url: string,
    attempt: number,
  ): Promise<ProviderError> {
    const body = await safeReadText(response, 2048);
    const kind =
      response.status === 429
        ? ProviderErrorKind.rateLimit
        : response.status === 401 || response.status === 403
          ? ProviderErrorKind.auth
          : response.status === 404
            ? ProviderErrorKind.notFound
            : response.status >= 500
              ? ProviderErrorKind.server
              : ProviderErrorKind.invalidRequest;

    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    const detail =
      extractProviderMessage(body) ??
      `${response.status} ${response.statusText}`;
    return new ProviderError(
      kind,
      `http_${response.status}`,
      `${redactUrl(url)}: ${detail}`,
      { status: response.status, retryAfterMs, attempt, body },
    );
  }
}

/** Throw a normalised error for a non-2xx response. Consumes the body. */
export async function assertOk(
  response: Response,
  url: string,
  attempt = 0,
): Promise<void> {
  if (response.ok) return;
  const body = await safeReadText(response, 4096);
  const status = response.status;
  const kind =
    status === 429
      ? ProviderErrorKind.rateLimit
      : status === 401
        ? ProviderErrorKind.auth
        : status === 403
          ? ProviderErrorKind.forbidden
          : status === 404
            ? ProviderErrorKind.notFound
            : status >= 500
              ? ProviderErrorKind.server
              : ProviderErrorKind.invalidRequest;
  throw new ProviderError(
    kind,
    `http_${status}`,
    extractProviderMessage(body) ?? `${status} ${response.statusText}`,
    {
      status,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      attempt,
      body,
    },
  );
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return Math.min(Math.max(seconds, 0) * 1000, RETRY_MAX_MS);
  const date = Date.parse(value);
  if (Number.isFinite(date))
    return Math.min(Math.max(date - Date.now(), 0), RETRY_MAX_MS);
  return undefined;
}

export function computeBackoff(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, RETRY_MAX_MS);
  const exponential = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

export function abortError(): ProviderError {
  return new ProviderError(
    ProviderErrorKind.cancelled,
    "cancelled",
    "Request cancelled",
  );
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function safeReadText(
  response: Response,
  limit: number,
): Promise<string> {
  try {
    const text = await response.text();
    return text.length > limit ? text.slice(0, limit) : text;
  } catch {
    return "";
  }
}

/** Pull a human message out of the various error envelopes providers use. */
/**
 * Zen returns `{"error": {...}}`, but several of its models proxy other
 * vendors' APIs and the error comes back in that vendor's shape instead, with a
 * console preamble glued to the front of the string. Everything downstream shows
 * this text to the user -- in an error banner, in the Models tab, next to a
 * model marked unusable -- so the preamble is stripped here rather than at each
 * of those call sites.
 */
const CONSOLE_PREAMBLE = /^Error from provider \(Console\):\s*/i;

function cleanMessage(message: string): string {
  const cleaned = message.replace(CONSOLE_PREAMBLE, "").trim();
  // The 401 body has no useful wording of its own beyond what the status already
  // says, so the caller is left to describe it.
  return cleaned === "Invalid API key." ? "" : cleaned;
}

export function extractProviderMessage(body: string): string | undefined {
  if (!body) return undefined;
  let message: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === "string") message = error;
      else if (error && typeof error === "object") {
        const nested = (error as Record<string, unknown>).message;
        if (typeof nested === "string") message = nested;
      }
      if (message === undefined && typeof record.message === "string") {
        message = record.message;
      }
      if (message === undefined && typeof record.detail === "string") {
        message = record.detail;
      }
    }
  } catch {
    // not JSON — fall through
  }
  if (message !== undefined) {
    const cleaned = cleanMessage(message);
    return cleaned || undefined;
  }
  const trimmed = body.trim().replace(CONSOLE_PREAMBLE, "");
  if (!trimmed) return undefined;
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** Strip query strings: some gateways accept a key as a query parameter. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/key|token|secret|auth/i.test(key))
        parsed.searchParams.set(key, "REDACTED");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function retryableMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Redact anything that looks like a credential before the message can be shown
  // in the UI or written to a log.
  if (/key|token|secret|authorization|bearer/i.test(message))
    return "network error";
  // A webview network failure arrives as `TypeError` with an empty message, and
  // an empty message is the worst possible outcome: the run failed and there is
  // nothing to show the user. Say what it was.
  if (!message.trim()) {
    return error instanceof Error && error.name === "TypeError"
      ? "the request could not be completed (network or CORS)"
      : "the request could not be completed";
  }
  return message;
}
