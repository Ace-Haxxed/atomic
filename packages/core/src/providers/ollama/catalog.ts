/**
 * The Ollama API, as data.
 *
 * Everything here is a pure function over a parsed JSON body, with no network,
 * no key handling and no model ids baked in. That is what lets the real
 * response shapes be tested from recorded fixtures, and it keeps the parsing
 * decisions -- especially the ones about what Ollama does *not* tell us --
 * reviewable in one place.
 *
 * Two shapes matter:
 *  - `GET /api/tags`    what is installed: name, size, family, quantisation
 *  - `POST /api/show`  what one model can do: context length, capabilities
 *
 * `show` is a separate call per model, so it is fetched lazily and cached. The
 * registry exposes `ollama` as an OpenAI-compatible provider for completions, but
 * the model listing is only available on the native API, so both roots are kept.
 */

import type { ModelCapabilities, ModelInfo, WireFormat } from "../../models/provider.js";

export const OLLAMA_PROVIDER_ID = "ollama";

/** Where Ollama listens unless the user moved it. */
export const OLLAMA_DEFAULT_ROOT = "http://localhost:11434";

/**
 * Why a configured Ollama URL cannot be used.
 *
 * Named rather than a bare string because each case has a different fix, and the
 * generic failure for all of them is a fetch error about protocol or DNS that
 * points at neither.
 */
export class OllamaUrlError extends Error {
  readonly input: string;

  constructor(input: string, message: string) {
    super(message);
    this.name = "OllamaUrlError";
    this.input = input;
  }
}

/**
 * The native API root, derived from a base URL that may be the OpenAI-compatible
 * one.
 *
 * The registry points completions at `<root>/v1` because that is the shape
 * `openai-chat` speaks, but `/api/tags` lives at the root. Deriving one from the
 * other means a user who edits the URL in Settings only edits it once.
 *
 * A URL that is present but unusable is rejected rather than replaced with the
 * default. Silently falling back meant a typo in the address field -- `htp://`,
 * a missing scheme, a stray path -- produced "Ollama isn't running at
 * localhost:11434", which is both untrue and points at the one thing that was
 * not wrong.
 */
export function ollamaRootFrom(baseUrl: string | null | undefined): string {
  const trimmed = (baseUrl ?? "").trim();
  // Unset is a legitimate state: Ollama runs with no configuration at all.
  if (!trimmed) return OLLAMA_DEFAULT_ROOT;
  const withoutSlash = trimmed.replace(/\/+$/, "");
  const root = withoutSlash.replace(/\/v\d+$/, "");
  if (!root) return OLLAMA_DEFAULT_ROOT;
  validateOllamaUrl(root, trimmed);
  return root;
}

/**
 * Reject a URL that cannot reach Ollama, saying which part is wrong.
 *
 * The checks are only the ones with a different remedy each: a missing scheme,
 * a scheme that is not http(s), a host that is not a hostname or address, and a
 * path where a base URL should end. Everything else is left to the request,
 * which reports it better than a regex can.
 */
function validateOllamaUrl(root: string, original: string): void {
  /*
   * Checked before parsing because `new URL` does not reject it: given
   * `localhost:11434` it reads "localhost" as the scheme and "11434" as the
   * path, so the mistake would be reported as a nonsense protocol rather than
   * as the missing `http://` that it actually is. A scheme is always followed by
   * `//`, so its absence is unambiguous.
   */
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(root)) {
    throw new OllamaUrlError(
      original,
      `\`${original}\` is not a usable Ollama address. It needs a scheme, as in http://localhost:11434.`,
    );
  }

  let url: URL;
  try {
    url = new URL(root);
  } catch {
    // The overwhelmingly common shape of this is a host with no scheme, which
    // `new URL` rejects and `fetch` would treat as a relative path.
    throw new OllamaUrlError(
      original,
      `\`${original}\` is not a usable Ollama address. It needs a scheme, as in http://localhost:11434.`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OllamaUrlError(
      original,
      `\`${original}\` uses ${url.protocol.replace(":", "")}, which cannot reach Ollama. Use http, or https if you have put it behind a TLS proxy.`,
    );
  }

  if (!url.hostname) {
    throw new OllamaUrlError(original, `\`${original}\` has no host in it.`);
  }

  // A path means the address is probably a completions URL, a proxied mount
  // point, or a copy of the wrong field. Either way `/api/tags` will not be there.
  const path = url.pathname.replace(/\/+$/, "");
  if (path) {
    throw new OllamaUrlError(
      original,
      `\`${original}\` should be Ollama's base address with no path after the host -- for example http://localhost:11434. Found \`${path}\`.`,
    );
  }
}

export interface OllamaModelSummary {
  /** Fully qualified name including the tag, e.g. `namespace/model:tag`. */
  readonly id: string;
  /** Bytes on disk. */
  readonly size: number;
  /** Parameter size as Ollama reports it, e.g. `3.2B`. Display only. */
  readonly parameterSize?: string;
  readonly quantization?: string;
  readonly family?: string;
  /** When the model was last written, ISO 8601. */
  readonly modifiedAt?: string;
}

export interface OllamaModelDetail {
  /** Omitted when Ollama does not report one. */
  readonly contextWindow?: number;
  readonly capabilities: readonly string[];
}

export class OllamaParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OllamaParseError";
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OllamaParseError(`Expected ${what} to be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Parse `GET /api/tags`.
 *
 * An empty `models` array is a valid, meaningful answer -- Ollama is running and
 * has nothing installed -- so it returns an empty list rather than throwing. Only
 * a body that is not the documented shape is a parse error, and the caller turns
 * that into a visible message rather than an empty list, because "no models" and
 * "could not read the response" are different problems for the user.
 */
export function parseTags(payload: unknown): readonly OllamaModelSummary[] {
  const root = asRecord(payload, "the /api/tags response");
  const models = root.models;
  if (!Array.isArray(models)) {
    throw new OllamaParseError("The /api/tags response has no `models` array.");
  }

  return models.map((entry) => {
    const model = asRecord(entry, "an entry in /api/tags");
    // `name` is the documented field; `model` is the alias older builds used.
    const id = nonEmptyString(model.name) ?? nonEmptyString(model.model);
    if (!id) throw new OllamaParseError("A model in /api/tags has no name.");

    const details =
      typeof model.details === "object" && model.details !== null
        ? (model.details as Record<string, unknown>)
        : {};

    const summary: OllamaModelSummary = {
      id,
      size: finiteNumber(model.size) ?? 0,
      ...(nonEmptyString(details.parameter_size)
        ? { parameterSize: nonEmptyString(details.parameter_size)! }
        : {}),
      ...(nonEmptyString(details.quantization_level)
        ? { quantization: nonEmptyString(details.quantization_level)! }
        : {}),
      ...(nonEmptyString(details.family) ? { family: nonEmptyString(details.family)! } : {}),
      ...(nonEmptyString(model.modified_at) ? { modifiedAt: nonEmptyString(model.modified_at)! } : {}),
    };
    return summary;
  });
}

/**
 * Parse `POST /api/show`.
 *
 * The context length is the interesting part, because Ollama does not put it in
 * one place. `model_info` is keyed by architecture (`llama.context_length`,
 * `gemma3.context_length`, `bert.context_length`, …), so it is read as
 * "*anything* ending in `.context_length`" rather than by naming architectures.
 * A hardcoded architecture list would silently report no context window for
 * every model family released after it was written.
 */
export function parseShow(payload: unknown): OllamaModelDetail {
  const root = asRecord(payload, "the /api/show response");

  const rawCapabilities = root.capabilities;
  const capabilities = Array.isArray(rawCapabilities)
    ? rawCapabilities.filter((entry): entry is string => typeof entry === "string")
    : [];

  let contextWindow: number | undefined;
  const info = root.model_info;
  if (typeof info === "object" && info !== null) {
    for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
      if (!key.endsWith(".context_length")) continue;
      const length = finiteNumber(value);
      // A model can report several; the largest is the one the user can use.
      if (length && length > 0) {
        contextWindow = Math.max(contextWindow ?? 0, length);
      }
    }
  }

  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    capabilities,
  };
}

/**
 * Capabilities Ollama did not report are left `false`.
 *
 * An older build of Ollama has no `capabilities` field at all. Guessing from the
 * model family would mean telling the user a model can call tools when it cannot,
 * and the failure then shows up as a broken agent run rather than a wrong badge.
 * Unknown stays unknown; the badge simply does not appear.
 */
export function capabilitiesFromShow(detail: OllamaModelDetail): ModelCapabilities {
  const has = (capability: string) => detail.capabilities.includes(capability);
  return {
    tools: has("tools"),
    vision: has("vision"),
    // Ollama's capability list contains "completion" for *every* completion
    // model, so reading reasoning from it would badge the entire library. The
    // reasoning capability is specifically `thinking`.
    reasoning: has("thinking"),
    reasoningEffort: false,
    streaming: true,
    ...(detail.contextWindow !== undefined ? { contextWindow: detail.contextWindow } : {}),
  };
}

/**
 * Build the model entry the rest of the app uses.
 *
 * Completion goes through Ollama's OpenAI-compatible surface, so the wire format
 * is `openai-chat` and the id sent on a request is the fully qualified tag --
 * dropping the tag would make a request ambiguous the moment two tags of the
 * same model are installed.
 */
export function toModelInfo(
  summary: OllamaModelSummary,
  detail: OllamaModelDetail | undefined,
  wireFormat: WireFormat = "openai-chat",
): ModelInfo {
  const parts = [summary.parameterSize, summary.quantization].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  const family = summary.family ? summary.family : null;

  return {
    id: summary.id,
    name: summary.id,
    wireFormat,
    capabilities: detail
      ? capabilitiesFromShow(detail)
      : { tools: false, vision: false, reasoning: false, reasoningEffort: false, streaming: true },
    // Nothing to report rather than a made-up price: a local model costs the
    // user nothing, and `freenessFor` is what decides that from the provider.
    ...(family || parts.length > 0
      ? { description: [family, ...parts].filter(Boolean).join(" · ") }
      : {}),
  };
}

// ---- /api/pull progress ---------------------------------------------------

export interface OllamaPullProgress {
  /** Ollama's own status line, e.g. `pulling manifest`. */
  readonly status: string;
  /** Bytes moved so far, when the status is a layer download. */
  readonly completed?: number;
  /** Bytes expected, when known. */
  readonly total?: number;
  readonly done: boolean;
}

export type PullOutcome = { readonly kind: "progress"; readonly progress: OllamaPullProgress } | { readonly kind: "done" } | { readonly kind: "error"; readonly message: string };

/**
 * Parse one NDJSON line of a `/api/pull` stream.
 *
 * Ollama answers a pull with newline-delimited JSON, one object per status
 * change, and ends with `{"status":"success"}`. A line that is not an object is
 * skipped by the caller rather than thrown on, because a single malformed line
 * should not abandon a multi-gigabyte download that is otherwise going fine.
 */
export function parsePullLine(line: string): OllamaPullProgress | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const status = nonEmptyString(record.status);
  if (!status) return null;

  const progress: OllamaPullProgress = {
    status,
    ...(finiteNumber(record.completed) !== undefined
      ? { completed: finiteNumber(record.completed)! }
      : {}),
    ...(finiteNumber(record.total) !== undefined ? { total: finiteNumber(record.total)! } : {}),
    done: status === "success",
  };
  return progress;
}

/** Split a byte count for display, without pretending to more precision. */
export function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
