/**
 * Provider call diagnostics, for debugging a failing request.
 *
 * This exists for one job: when a send fails with "your key was rejected", the
 * first question is always *what did we actually send*. Without an answer, a
 * developer is reduced to guessing between a wrong URL, a wrong header name, a
 * mangled credential and a key that is simply bad.
 *
 * The hard rule, enforced below rather than by convention: **no diagnostic may
 * ever contain a credential value.** Callers pass the auth header *name*, never
 * its value, and every body passes through `redactSecrets` before it is logged.
 * `assertProviderDiagnosticSafe` re-checks the finished record, so a future
 * caller that forgets the rule still cannot leak one.
 *
 * Core is compiled with plain `tsc`, so `import.meta.env` does not exist here --
 * the app decides at bootstrap and turns diagnostics on for development builds.
 */

export interface ProviderDiagnostic {
  readonly providerId: string;
  /** Final URL, already run through `redactUrl`. */
  readonly url: string;
  /** Which wire format served this model, e.g. `openai-chat`. */
  readonly dialect: string;
  /** Header NAME only, e.g. `authorization`. Never the value. */
  readonly authHeader: string;
  readonly method: string;
  readonly status: number | null;
  readonly ok: boolean;
  /** Redacted provider response body. */
  readonly body?: string | undefined;
}

type Sink = (diagnostic: ProviderDiagnostic) => void;

let enabled = false;
let sink: Sink = (diagnostic) => {
  // eslint-disable-next-line no-console -- diagnostics are console output by nature
  console.warn(`[provider] ${format(diagnostic)}`);
};

/** Turn diagnostics on or off. The app calls this once at startup. */
export function setProviderDiagnostics(next: boolean, onDiagnostic?: Sink): void {
  enabled = next;
  if (onDiagnostic) sink = onDiagnostic;
}

export function providerDiagnosticsEnabled(): boolean {
  return enabled;
}

/**
 * Report a failed provider call.
 *
 * Returns whether it was reported, so callers can use it in a debug-only branch
 * without also branching on the flag themselves.
 */
export function reportProviderFailure(input: Omit<ProviderDiagnostic, "ok">): boolean {
  if (!enabled) return false;
  sink(assertProviderDiagnosticSafe({ ...input, ok: false }));
  return true;
}

/** Report a successful call. Used to confirm the URL and dialect that worked. */
export function reportProviderSuccess(input: Omit<ProviderDiagnostic, "ok" | "status">): boolean {
  if (!enabled) return false;
  sink(assertProviderDiagnosticSafe({ ...input, status: null, ok: true }));
  return true;
}

/**
 * Scrub anything that looks like a credential out of free text.
 *
 * Applied to response bodies, which routinely echo the request or a stack that
 * contains the header that was sent. Belt and braces: the body is the one field
 * a provider fully controls, so it is the one field that cannot be trusted to be
 * safe.
 */
export function redactSecrets(text: string): string {
  return text
    // `Authorization: Bearer <token>` in any casing, and bare bearer tokens.
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 REDACTED")
    // Anything that names itself a key, in JSON or in prose.
    .replace(
      /("?(?:api[_-]?key|apikey|authorization|token|secret|password)"?\s*[:=]\s*"?)([^"',\s}]{4,})/gi,
      "$1REDACTED",
    )
    // Provider-issued key shapes, in case they appear with no label at all.
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-REDACTED")
    .replace(/\bk-(?:or|sk)-[A-Za-z0-9]{8,}/g, "REDACTED");
}

/**
 * Final gate before logging.
 *
 * Cheaper to be paranoid than to explain a leaked key to a user: this throws
 * rather than logs anything carrying a `Bearer` value or a `sk-` prefix.
 */
export function assertProviderDiagnosticSafe(diagnostic: ProviderDiagnostic): ProviderDiagnostic {
  const body = diagnostic.body ? redactSecrets(diagnostic.body) : undefined;
  const checked: ProviderDiagnostic = { ...diagnostic, ...(body !== undefined ? { body } : {}) };
  const serialized = JSON.stringify(checked);
  if (/\bbearer\s+[A-Za-z0-9._~+/=-]{4,}/i.test(serialized) || /\bsk-[A-Za-z0-9_-]{8,}/.test(serialized)) {
    throw new Error("Refusing to emit a provider diagnostic: it appears to contain a credential.");
  }
  return checked;
}

/** One line, for a console. Header names only -- there are no values in here. */
export function format(diagnostic: ProviderDiagnostic): string {
  const status = diagnostic.status === null ? "(no response)" : `HTTP ${diagnostic.status}`;
  const auth = diagnostic.authHeader ? ` auth-header=${diagnostic.authHeader}` : "";
  const body = diagnostic.body ? ` body=${diagnostic.body.slice(0, 300)}` : "";
  return `${diagnostic.method} ${diagnostic.url} dialect=${diagnostic.dialect}${auth} -> ${status}${body}`;
}
