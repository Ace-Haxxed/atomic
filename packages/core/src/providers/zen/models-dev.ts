/**
 * models.dev metadata reader.
 *
 * `https://models.dev/api.json` is the registry OpenCode uses. It gives us, per
 * model: context window, cost, modalities, and — critically for Zen — the AI SDK
 * package, which maps directly to a wire format. It is a *supplement*, not a
 * source of truth: the model list always comes from Zen's own `/models` endpoint.
 */

import type {
  ModelCapabilities,
  ModelInfo,
  WireFormat,
} from "../../models/provider.js";

export const MODELS_DEV_URL = "https://models.dev/api.json";

const NPM_TO_WIRE: Readonly<Record<string, WireFormat>> = {
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/openai-compatible": "openai-chat",
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/google": "google-generative",
  "@ai-sdk/google-vertex": "google-generative",
};

export function modelsDevNpmToWire(npm: string): WireFormat | undefined {
  return NPM_TO_WIRE[npm];
}

export interface ZenModelMetadata {
  readonly name?: string;
  readonly description?: string;
  readonly releaseDate?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  readonly capabilities?: ModelCapabilities;
  readonly npm?: string;
}

type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/** Pull the `opencode` provider block out of a models.dev payload. */
export function extractOpencodeProvider(payload: unknown): Json | undefined {
  const root = asRecord(payload);
  const provider = root ? asRecord(root.opencode) : undefined;
  return provider;
}

export function readModelMetadata(
  provider: Json | undefined,
  modelId: string,
  wireFormat: WireFormat,
): ZenModelMetadata {
  const models = asRecord(provider?.models);
  const entry = asRecord(models?.[modelId]);
  if (!entry) return {};

  const limit = asRecord(entry.limit);
  const cost = asRecord(entry.cost);
  const modalities = asRecord(entry.modalities);
  const inputModalities = Array.isArray(modalities?.input)
    ? (modalities!.input as string[])
    : [];
  const providerBlock = asRecord(entry.provider);
  const reasoningOptions = Array.isArray(entry.reasoning_options)
    ? entry.reasoning_options
    : [];

  const capabilities: ModelCapabilities = {
    tools: entry.tool_call === true,
    vision: entry.attachment === true || inputModalities.includes("image"),
    reasoning: entry.reasoning === true,
    reasoningEffort: reasoningOptions.some(
      (option) =>
        asRecord(option)?.type === "effort" ||
        asRecord(option)?.type === "toggle",
    ),
    streaming: true,
    contextWindow: num(limit?.context) || undefined,
    maxOutputTokens: num(limit?.output) || undefined,
    temperature: entry.temperature === true,
    structuredOutput: entry.structured_output === true,
    // Only a *reported* zero means free. `num()` returns 0 for a missing or
    // null field, so comparing against it directly labelled every unpriced
    // model as free -- and a model with no pricing is not free, it is unknown.
    free: hasPrice(cost) && num(cost!.input) === 0 && num(cost!.output) === 0,
  };

  return {
    ...(typeof entry.name === "string" ? { name: entry.name } : {}),
    ...(typeof entry.description === "string"
      ? { description: entry.description }
      : {}),
    ...(typeof entry.release_date === "string"
      ? { releaseDate: entry.release_date }
      : {}),
    contextWindow: capabilities.contextWindow,
    maxOutputTokens: capabilities.maxOutputTokens,
    // A reported price is emitted even when it is 0/0. The previous
    // `||`-guarded version dropped a genuine zero price, which erased the only
    // authoritative free signal we have: models.dev knows Big Pickle is free
    // even though its id has no "-free" in it, and throwing that number away
    // left 34 correctly-priced free models sitting in `unknown`.
    cost: hasPrice(cost)
      ? {
          input: num(cost!.input),
          output: num(cost!.output),
          ...(num(cost!.cache_read)
            ? { cacheRead: num(cost!.cache_read) }
            : {}),
          ...(num(cost!.cache_write)
            ? { cacheWrite: num(cost!.cache_write) }
            : {}),
        }
      : undefined,
    capabilities,
    npm: typeof providerBlock?.npm === "string" ? providerBlock.npm : undefined,
  };
}

/** Build the final `ModelInfo` for a Zen model id. */
export function buildModelInfo(
  modelId: string,
  wireFormat: WireFormat,
  metadata: ZenModelMetadata = {},
): ModelInfo {
  return {
    id: modelId,
    name: metadata.name ?? modelId,
    wireFormat,
    capabilities: metadata.capabilities ?? {
      tools: true,
      vision: false,
      reasoning: false,
      reasoningEffort: false,
      streaming: true,
    },
    ...(metadata.cost ? { cost: metadata.cost } : {}),
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.releaseDate ? { releaseDate: metadata.releaseDate } : {}),
    supportsOwnKey:
      wireFormat === "anthropic-messages" || wireFormat === "openai-responses",
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * True when the registry actually reported prices for this model.
 *
 * A `cost` object whose fields are all null/absent is the same as no cost
 * object at all: the provider is saying nothing, not saying zero.
 */
function hasPrice(cost: Json | null | undefined): boolean {
  if (!cost) return false;
  // Strict equality on purpose: `null === 0` is false, so a null field does not
  // count as a reported price, while a real numeric 0 does.
  return typeof cost.input === "number" || typeof cost.output === "number";
}
