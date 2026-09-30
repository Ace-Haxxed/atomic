/**
 * Provider errors.
 *
 * Every error surfaced to the UI goes through `ProviderError` so the UI can
 * render an actionable message ("check your key", "you're rate limited, retrying
 * in 20s") instead of a stack trace. Messages are scrubbed of secrets.
 */

export const ProviderErrorKind = {
  auth: "auth",
  forbidden: "forbidden",
  rateLimit: "rate-limit",
  network: "network",
  timeout: "timeout",
  server: "server",
  invalidRequest: "invalid-request",
  notFound: "not-found",
  cancelled: "cancelled",
  unsupportedModel: "unsupported-model",
  parse: "parse",
  config: "config",
  /**
   * No credential exists at all.
   *
   * Distinct from `auth` on purpose. `auth` means "the provider looked at your
   * key and said no", which points at the key. This means "nothing was sent",
   * which points at Settings. Reusing `auth` here sent users to re-paste a key
   * they had never saved.
   */
  missingCredential: "missing-credential",
} as const;

export type ProviderErrorKind =
  (typeof ProviderErrorKind)[keyof typeof ProviderErrorKind];

export const PROVIDER_ERROR_KINDS = Object.values(ProviderErrorKind);

export interface ProviderErrorDetails {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly attempt?: number;
  readonly body?: string;
  readonly cause?: unknown;
  /**
   * Guidance to show instead of the wording for this `kind`.
   *
   * The `kind` decides the *category* -- a refusal, a network failure, a
   * misconfiguration -- and the generic wording for a category is often wrong
   * for a particular provider. `config` is the clear case: it reads "add your
   * API key", which is nonsense for Ollama, where no key exists and the address
   * is the thing to fix. Matching on the message text inside `userMessage` also
   * works and is what the Zen and Google branches above do, but it couples the
   * copy to a string a provider might reword.
   */
  readonly userMessage?: string;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly attempt?: number;
  readonly body?: string;
  /** Overrides the `userMessage` wording for this kind. See the details field. */
  readonly #userMessage: string | undefined;

  constructor(
    kind: ProviderErrorKind,
    code: string,
    message: string,
    details: ProviderErrorDetails = {},
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "ProviderError";
    this.kind = kind;
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
    if (details.retryAfterMs !== undefined)
      this.retryAfterMs = details.retryAfterMs;
    if (details.attempt !== undefined) this.attempt = details.attempt;
    if (details.body !== undefined) this.body = details.body;
    if (details.userMessage !== undefined) this.#userMessage = details.userMessage;
  }

  /** True when another attempt could plausibly succeed. */
  get retryable(): boolean {
    return (
      this.kind === "rate-limit" ||
      this.kind === "network" ||
      this.kind === "timeout" ||
      this.kind === "server"
    );
  }

  /** Short, non-technical guidance for the user. */
  get userMessage(): string {
    if (this.#userMessage !== undefined) return this.#userMessage;
    switch (this.kind) {
      case "auth":
        return "Your API key was rejected. Check it in Settings → Models.";
      // 403 is not a bad key. Zen uses it for a model the workspace has
      // disabled, which is fixed in the Zen dashboard and not by re-pasting the
      // key -- so telling the user to check their key sends them the wrong way.
      case "forbidden":
        // Verified live: Zen answers 403 with a `FreeTierError` for models its
        // own client is entitled to and other clients are not. That is not a
        // permissions problem -- no key and no admin setting fixes it, and
        // telling the user to pick another model or ask an admin would send
        // them to do something that cannot possibly work.
        if (
          /free tier can only be used from within OpenCode/i.test(this.message)
        ) {
          return "OpenCode reserves this free model for its own app. Atomic cannot use it -- pick one of the other free models.";
        }
        // Google's 403 is the same status with a different cause: the key is
        // valid and the Generative Language API is simply not enabled for the
        // project. That is fixed in Google Cloud, never by re-pasting the key, so
        // both the Zen wording and the "check your key" wording send the user
        // somewhere that cannot help.
        if (/generativelanguage|not enabled for this project/i.test(this.message)) {
          return "Google rejected the request because the Generative Language API is not enabled for this project. Enable it in Google AI Studio, then refresh. Your key itself is fine.";
        }
        return "This key is not allowed to use that model. Pick another model, or ask an OpenCode Zen workspace admin to enable it.";
      case "rate-limit":
        return this.retryAfterMs
          ? `Rate limited. Retrying in ${Math.ceil(this.retryAfterMs / 1000)}s.`
          : "Rate limited by the provider. Retrying shortly.";
      case "missing-credential":
        return (
          this.message ||
          "No API key saved for this provider. Add one in Settings → Models."
        );
      case "network":
        return "Could not reach the provider. Check your connection or proxy settings.";
      case "timeout":
        return "The provider took too long to respond.";
      case "server":
        return "OpenCode Zen had an internal error. This is usually temporary -- try again in a moment.";
      case "unsupported-model":
        return "That model is not available on this provider. Pick another one.";
      case "not-found":
        return "The provider does not offer that model any more. Pick another one, or refresh the model list.";
      case "config":
        return "Atomic is not configured yet. Add your API key in Settings.";
      case "cancelled":
        return "Cancelled.";
      default:
        return this.message;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      status: this.status,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

export function isAbort(error: unknown): boolean {
  if (isProviderError(error)) return error.kind === "cancelled";
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "Aborted")
  );
}

export function toProviderError(
  error: unknown,
  fallback: ProviderErrorKind = "network",
): ProviderError {
  if (isProviderError(error)) return error;
  if (isAbort(error))
    return new ProviderError("cancelled", "cancelled", "Cancelled");
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(fallback, "unknown", message, { cause: error });
}
