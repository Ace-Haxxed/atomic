/**
 * Google's native model listing, for a provider that is otherwise OpenAI-shaped.
 *
 * Gemini's OpenAI-compatibility surface exists for chat completions and
 * embeddings, and it is genuinely useful -- one request path covers every hosted
 * provider in this app. It does **not** serve a model listing. Verified against
 * Google's live API on 2026-09-29:
 *
 *   GET  /v1beta/openai/models   -> 404 "Requested entity was not found."
 *   GET  /v1beta/models          -> 403 PERMISSION_DENIED  (exists, needs a key)
 *
 * A 403 next to a 404 is the whole diagnosis: the compat path has no `/models` at
 * all, so appending `/models` to the base URL -- which is what the shared
 * implementation does -- returns 404 for every key, always. That is a structural
 * failure, not a bad key, and no amount of re-entering the key changes it. It is
 * also the reason a Gemini section could look like a *different provider's* list:
 * the listing failed, and the unscoped cache row was still there to be served.
 *
 * So listing comes from the native endpoint and chat stays on the compat path.
 * Both are the same API and the same key; only the URL differs.
 *
 * Shape, from `GET /v1beta/models` (ai.google.dev/api/models):
 *
 *   { "models": [ { "name": "models/gemini-3.7-flash",
 *                   "baseModelId": "gemini-3.7-flash",
 *                   "version": "001",
 *                   "displayName": "Gemini 3.7 Flash",
 *                   "inputTokenLimit": 1048576,
 *                   "outputTokenLimit": 65536,
 *                   "supportedGenerationMethods": ["generateContent", ...],
 *                   "thinking": true } ],
 *     "nextPageToken": "..." }
 *
 * Only `generateContent` models are chat models. The same listing also returns
 * image, audio, TTS and embedding models, which this app cannot drive over a
 * chat-completions request, so including them produced a picker full of entries
 * that 400 on Send.
 */

import { ProviderError, ProviderErrorKind } from "../errors.js";

/** Google's native listing, which is the base URL's parent plus `/models`. */
export const GEMINI_NATIVE_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * How many pages to walk.
 *
 * Google's list is paginated and the first page is not the whole catalogue.
 * Two is a compromise: enough to reach the flash-tier models people actually
 * pick, bounded so a pathological `nextPageToken` chain cannot stall a refresh.
 */
const MAX_PAGES = 3;

interface NativeModel {
  readonly name?: string;
  readonly baseModelId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly inputTokenLimit?: number;
  readonly outputTokenLimit?: number;
  readonly supportedGenerationMethods?: string[];
  readonly thinking?: boolean;
}

export interface GeminiNativeModel {
  /** The id to send as `model`, e.g. `gemini-3.7-flash`. */
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly reasoning: boolean;
}

/**
 * Walk the native listing and return the models this app can talk to.
 *
 * `request` is the caller's already-configured HTTP client, so the provider's
 * timeout, retry and redaction behaviour apply unchanged.
 */
export async function fetchGeminiNativeModels(
  request: (url: string, signal?: AbortSignal) => Promise<Response>,
  providerId: string,
  signal?: AbortSignal,
): Promise<readonly GeminiNativeModel[]> {
  const out: GeminiNativeModel[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = pageToken
      ? `${GEMINI_NATIVE_MODELS_URL}?pageToken=${encodeURIComponent(pageToken)}`
      : GEMINI_NATIVE_MODELS_URL;
    const response = await request(url, signal);
    if (!response.ok) {
      throw providerListError(response, providerId);
    }
    const payload = (await response.json()) as {
      models?: NativeModel[];
      nextPageToken?: string;
    };
    for (const model of payload.models ?? []) {
      const parsed = toNativeModel(model);
      // Duplicates across pages are normal: a model appears once per version.
      if (!parsed || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      out.push(parsed);
    }
    pageToken = payload.nextPageToken;
    if (!pageToken) break;
  }

  if (out.length === 0) {
    throw new ProviderError(
      ProviderErrorKind.parse,
      "empty_catalog",
      `Google returned no chat models for "${providerId}". The key was accepted, but the account can see no generativelanguage models.`,
    );
  }
  return out;
}

/**
 * A native listing entry, or `null` when it is not something chat can drive.
 *
 * `name` is a resource path (`models/gemini-3.7-flash`); the id a chat request
 * wants is the last segment. `baseModelId` is preferred where present because it
 * is the unversioned id that keeps working when Google retires a `-preview`
 * suffix.
 */
function toNativeModel(model: NativeModel): GeminiNativeModel | null {
  const methods = model.supportedGenerationMethods;
  // A model that cannot generate content is not a chat model, whatever it is
  // called. Absent metadata is treated as chat-capable, because some responses
  // omit the field entirely and dropping the whole catalogue would be worse.
  if (Array.isArray(methods) && !methods.includes("generateContent")) return null;

  const id = model.baseModelId?.trim() || (model.name ?? "").replace(/^models\//, "");
  if (!id) return null;
  // TTS, image and live models are reachable through their own APIs, and the
  // chat-completions path rejects them with a 400 that reads like a bad model id.
  if (/(^|[-_.])(tts|image|imagen|veo|lyria|embedding|live|computer-use)([-_.]|$)/i.test(id)) {
    return null;
  }
  return {
    id,
    name: model.displayName?.trim() || id,
    ...(model.description ? { description: model.description } : {}),
    ...(typeof model.inputTokenLimit === "number" && model.inputTokenLimit > 0
      ? { contextWindow: model.inputTokenLimit }
      : {}),
    ...(typeof model.outputTokenLimit === "number" && model.outputTokenLimit > 0
      ? { maxOutput: model.outputTokenLimit }
      : {}),
    reasoning: model.thinking === true,
  };
}

/**
 * Google's own words for a listing failure, without quoting a credential.
 *
 * A 403 here is an auth or quota problem and needs a different action from the
 * compat path's permanent 404, so the two are not allowed to collapse into one
 * "Gemini is broken" string.
 */
function providerListError(response: Response, providerId: string): ProviderError {
  const status = response.status;
  if (status === 401) {
    return new ProviderError(
      ProviderErrorKind.auth,
      "gemini_unauthorized",
      `Google rejected the ${providerId} key (401). The key is missing, wrong, or revoked.`,
    );
  }
  if (status === 403) {
    // Google's 403 means the key was accepted and the *project* is not set up
    // for this API. Verified live: an unauthenticated listing request returns
    // PERMISSION_DENIED rather than 401, so a 403 here is an enablement problem
    // and telling the user to re-check their key sends them the wrong way.
    return new ProviderError(
      ProviderErrorKind.forbidden,
      "gemini_api_not_enabled",
      `Google returned PERMISSION_DENIED for the ${providerId} model listing, which means the Generative Language API is not enabled for this project.`,
    );
  }
  if (status === 404) {
    return new ProviderError(
      ProviderErrorKind.parse,
      "gemini_listing_missing",
      `Google returned 404 for the model listing at ${GEMINI_NATIVE_MODELS_URL}. That endpoint moved; this build's URL needs updating.`,
    );
  }
  if (status === 429) {
    return new ProviderError(
      ProviderErrorKind.rateLimit,
      "gemini_rate_limited",
      `Google rate-limited the model listing for ${providerId}. Wait a moment and refresh.`,
    );
  }
  return new ProviderError(
    ProviderErrorKind.network,
    "gemini_listing_failed",
    `Google returned ${status} while listing models for ${providerId}.`,
  );
}
