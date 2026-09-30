/**
 * The providers Atomic can talk to.
 *
 * A provider here is just an endpoint and a key format, which is what makes the
 * app "universal" in the sense that matters: one key field, and the shape of the
 * key decides the destination. Nothing about the model list, the wire format or
 * the auth header is hard-coded to a single vendor.
 *
 * Every entry speaks either the OpenAI or the Anthropic dialect, because those
 * two cover effectively every hosted model API and both are served over plain
 * HTTPS. Anything else is better served by a base URL the user supplies.
 */

import type { WireFormat } from "../models/provider.js";
import { ZEN_BASE_URL, ZEN_PROVIDER_ID } from "./zen/catalog.js";

export type ProviderDialect = "openai" | "anthropic";

export interface ProviderDefinition {
  readonly id: string;
  readonly label: string;
  /** API root, without a trailing slash. */
  readonly baseUrl: string;
  /** Environment variable that conventionally holds this provider's key. */
  readonly envVar: string;
  /** Which request dialect this endpoint speaks. */
  readonly dialect: ProviderDialect;
  /** Used when a model id is not recognised by the routing table. */
  readonly defaultWireFormat: WireFormat;
  /**
   * Whether a key of this provider's shape is specific enough to switch to
   * without asking. See `detect-key.ts`.
   */
  readonly selfIdentifying: boolean;
  /**
   * How this provider's model list is fetched, when `<baseUrl>/models` is wrong.
   *
   * Gemini is the case that matters: its OpenAI-compatibility surface serves chat
   * completions but has no `/models` endpoint at all (verified live: the compat
   * path 404s, the native path 403s for want of a key), so the shared
   * implementation's `${baseUrl}/models` can only ever fail. `native-gemini`
   * reads the list from Google's own endpoint while chat stays on the compat
   * path. `null` means the default.
   */
  readonly catalogSource?: CatalogSource | null;
  /** One line for the settings UI. */
  readonly note: string;
}

/** How a provider's model list is fetched. */
export type CatalogSource = "native-gemini";

function openaiCompatible(
  id: string,
  label: string,
  baseUrl: string,
  envVar: string,
  selfIdentifying: boolean,
  note: string,
  defaultWireFormat: WireFormat = "openai-chat",
  catalogSource: CatalogSource | null = null,
): ProviderDefinition {
  return {
    id,
    label,
    baseUrl,
    envVar,
    dialect: "openai",
    defaultWireFormat,
    selfIdentifying,
    ...(catalogSource ? { catalogSource } : {}),
    note,
  };
}

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: ZEN_PROVIDER_ID,
    label: "OpenCode Zen",
    baseUrl: ZEN_BASE_URL,
    envVar: "OPENCODE_API_KEY",
    dialect: "openai",
    // Zen fronts Claude through the OpenAI Responses shape.
    defaultWireFormat: "openai-responses",
    selfIdentifying: true,
    note: "One key, many models. Atomic's default.",
  },
  openaiCompatible(
    "openai",
    "OpenAI",
    "https://api.openai.com/v1",
    "OPENAI_API_KEY",
    true,
    "GPT models, including Codex.",
    "openai-responses",
  ),
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    envVar: "ANTHROPIC_API_KEY",
    dialect: "anthropic",
    defaultWireFormat: "anthropic-messages",
    selfIdentifying: true,
    note: "Claude models.",
  },
  openaiCompatible(
    "openrouter",
    "OpenRouter",
    "https://openrouter.ai/api/v1",
    "OPENROUTER_API_KEY",
    true,
    "Many vendors through one endpoint.",
  ),
  openaiCompatible(
    "groq",
    "Groq",
    "https://api.groq.com/openai/v1",
    "GROQ_API_KEY",
    true,
    "Very fast inference on open models.",
  ),
  openaiCompatible(
    "mistral",
    "Mistral",
    "https://api.mistral.ai/v1",
    "MISTRAL_API_KEY",
    false,
    "Mistral and open-weight models.",
  ),
  openaiCompatible(
    "deepseek",
    "DeepSeek",
    "https://api.deepseek.com/v1",
    "DEEPSEEK_API_KEY",
    false,
    "DeepSeek chat and reasoning models.",
  ),
  {
    id: "google",
    label: "Google Gemini",
    // Google's OpenAI-compatible surface, so one code path covers it. Chat and
    // embeddings live here; the model list does not, so `catalogSource` sends the
    // listing to the native endpoint instead of a URL that always 404s.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envVar: "GEMINI_API_KEY",
    dialect: "openai",
    defaultWireFormat: "openai-chat",
    selfIdentifying: true,
    catalogSource: "native-gemini",
    note: "Gemini models.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    envVar: "OLLAMA_API_KEY",
    dialect: "openai",
    defaultWireFormat: "openai-chat",
    // Nothing to detect: a local server usually takes no key at all.
    selfIdentifying: false,
    note: "Models running on this machine.",
  },
];

const BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

/** Look up a provider, or `null` for an id this build does not know. */
export function providerById(id: string): ProviderDefinition | null {
  return BY_ID.get(id) ?? null;
}

/** The provider used when nothing has been chosen. */
export const DEFAULT_PROVIDER = PROVIDERS[0];
