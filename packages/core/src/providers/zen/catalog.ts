/**
 * OpenCode Zen catalog.
 *
 * The model list is fetched from `GET {base}/models` and never hardcoded. What
 * *is* encoded here is the routing table: which of Zen's four wire formats a
 * given model id speaks. `models.dev` (the registry OpenCode itself uses) also
 * publishes this, and is used as the preferred source; `resolveWireFormat`
 * falls back to a conservative name heuristic and finally to `openai-chat`.
 *
 * Wire formats on Zen, per https://opencode.ai/docs/zen:
 *   openai-responses   -> /responses      (GPT, Grok, Muse Spark)
 *   anthropic-messages -> /messages       (Claude, some Qwen)
 *   google-generative  -> /models/{m}     (Gemini)
 *   openai-chat        -> /chat/completions (everything else)
 */

import type { ModelInfo, WireFormat } from "../../models/provider.js";
import { modelsDevNpmToWire } from "./models-dev.js";

export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const ZEN_PROVIDER_ID = "opencode-zen";
export const ZEN_MODELS_URL = `${ZEN_BASE_URL}/models`;
export const ZEN_DOCS_URL = "https://opencode.ai/docs/zen";
export const ZEN_AUTH_URL = "https://opencode.ai/auth";

/** Exact id -> wire format, taken from the Zen docs endpoint table. */
const EXACT_ROUTING: Readonly<Record<string, WireFormat>> = {
  "gpt-6-astra": "openai-responses",
  "gpt-6-sol": "openai-responses",
  "gpt-6-luna": "openai-responses",
  "gpt-5.6-sol": "openai-responses",
  "gpt-5.6-terra": "openai-responses",
  "gpt-5.6-luna": "openai-responses",
  "gpt-5.5": "openai-responses",
  "gpt-5.5-pro": "openai-responses",
  "gpt-5.4": "openai-responses",
  "gpt-5.4-pro": "openai-responses",
  "gpt-5.4-mini": "openai-responses",
  "gpt-5.4-nano": "openai-responses",
  "gpt-5.3-codex": "openai-responses",
  "gpt-5.3-codex-spark": "openai-responses",
  "gpt-5.2": "openai-responses",
  "gpt-5.2-codex": "openai-responses",
  "gpt-5.1": "openai-responses",
  "gpt-5.1-codex": "openai-responses",
  "gpt-5.1-codex-max": "openai-responses",
  "gpt-5.1-codex-mini": "openai-responses",
  "gpt-5": "openai-responses",
  "gpt-5-codex": "openai-responses",
  "gpt-5-nano": "openai-responses",
  "grok-4.7": "openai-responses",
  "grok-4.6": "openai-responses",
  "grok-4.5": "openai-responses",
  "grok-build-0.1": "openai-responses",
  "muse-spark-1.2": "openai-responses",
  "muse-spark-1.3": "openai-responses",
  "muse-spark-1.3-contributor-free": "openai-responses",

  "claude-fable-5-1": "anthropic-messages",
  "claude-fable-5": "anthropic-messages",
  "claude-opus-5-5": "anthropic-messages",
  "claude-opus-5": "anthropic-messages",
  "claude-opus-4-8": "anthropic-messages",
  "claude-opus-4-7": "anthropic-messages",
  "claude-opus-4-6": "anthropic-messages",
  "claude-opus-4-5": "anthropic-messages",
  "claude-sonnet-5": "anthropic-messages",
  "claude-sonnet-4-6": "anthropic-messages",
  "claude-sonnet-4-5": "anthropic-messages",
  "claude-sonnet-4": "anthropic-messages",
  "claude-haiku-4-5": "anthropic-messages",
  "qwen3.8-flash": "anthropic-messages",
  "qwen3.7-max": "anthropic-messages",
  "qwen3.7-plus": "anthropic-messages",
  "qwen3.6-plus": "anthropic-messages",
  "qwen3.5-plus": "anthropic-messages",

  "qwen3.8-max": "openai-chat",
  "deepseek-v4.1-flash": "openai-chat",
  "deepseek-v4-pro": "openai-chat",
  "deepseek-v4-flash": "openai-chat",
  "deepseek-v4-flash-vision-exp": "openai-chat",
  "minimax-m3": "openai-chat",
  "minimax-m2.7": "openai-chat",
  "minimax-m2.5": "openai-chat",
  "glm-5.3-flash": "openai-chat",
  "glm-5.3": "openai-chat",
  "glm-5.2": "openai-chat",
  "glm-5.1": "openai-chat",
  "glm-5": "openai-chat",
  "kimi-k3": "openai-chat",
  "kimi-k2.7-code": "openai-chat",
  "kimi-k2.6": "openai-chat",
  "kimi-k2.5": "openai-chat",
  "big-pickle": "openai-chat",
  "space-bunny-free": "openai-chat",
  "longcat-2.5-preview-free": "openai-chat",
  "mimo-v2.6-flash-free": "openai-chat",
  "mimo-v2.5-free": "openai-chat",
  "ling-3.0-flash-fin-free": "openai-chat",
  "nemotron-3-ultra-free": "openai-responses",
  "nemotron-3.5-lightning-free": "openai-responses",
};

/**
 * Model ids that are not chat models. Requesting one as a chat model is a
 * configuration error, not a network error.
 */
const NON_CHAT_PREFIXES = ["jev-"] as const;

export function isNonChatModel(id: string): boolean {
  return NON_CHAT_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Decide which wire format a model speaks.
 * Order: explicit table -> models.dev metadata -> name heuristic -> chat.
 */
export function resolveWireFormat(
  modelId: string,
  npmHint?: string | undefined,
): WireFormat {
  const exact = EXACT_ROUTING[modelId];
  if (exact) return exact;
  if (npmHint) {
    const fromRegistry = modelsDevNpmToWire(npmHint);
    if (fromRegistry) return fromRegistry;
  }
  return heuristicWireFormat(modelId);
}

/** Fallback for a model that appeared after this build. */
export function heuristicWireFormat(modelId: string): WireFormat {
  const id = modelId.toLowerCase();
  if (id.startsWith("claude")) return "anthropic-messages";
  if (id.startsWith("gemini")) return "google-generative";
  if (
    id.startsWith("gpt") ||
    id.startsWith("grok") ||
    id.startsWith("muse-spark")
  ) {
    return "openai-responses";
  }
  if (id.startsWith("qwen") && /-(plus|flash)$/.test(id))
    return "anthropic-messages";
  return "openai-chat";
}

/** Base URL for a model: Gemini lives under its own path segment. */
export function baseUrlForWireFormat(
  baseUrl: string,
  modelId: string,
  wireFormat: WireFormat,
): string {
  if (wireFormat !== "google-generative") return baseUrl;
  // Google adapters append `/models/{model}:streamGenerateContent` themselves.
  return baseUrl;
}

/** Suggest a starting model per mode. Only used for first-run defaults. */
export const SUGGESTED_MODELS = {
  chat: "claude-sonnet-5",
  cowork: "claude-sonnet-5",
  code: "gpt-5.3-codex",
} as const;

/** Families that reliably support tool calling; used to rank the model picker. */
export const CODING_FAMILIES = [
  "codex",
  "claude",
  "kimi-k2.7-code",
  "qwen3.8-max",
  "glm",
] as const;
