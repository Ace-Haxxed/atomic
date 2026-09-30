/**
 * Recognising which service an API key belongs to.
 *
 * The provider list lives in `registry.ts`; this file only knows key shapes.
 *
 * Users do not think in providers. They have a key that an installer, a script
 * or a colleague printed at them, and they paste it. Asking them to first pick
 * "Anthropic" and then discover they pasted a Groq key is the friction that
 * makes the app look broken.
 *
 * So the key is the input and the provider is inferred. Detection is a pure
 * function over the string, it never logs or stores the key, and it returns
 * `null` whenever the evidence is weak — a wrong guess silently sends a
 * credential to the wrong vendor, which is worse than asking.
 */

/** How sure we are, which decides whether the UI is allowed to act on it. */
import { providerById } from "./registry.js";

export type KeyConfidence = "certain" | "likely" | "unknown";

export interface KeyDetection {
  /** Provider id to switch to, or `null` when nothing matched. */
  readonly providerId: string | null;
  /** Human name, for the confirmation line. */
  readonly label: string | null;
  readonly confidence: KeyConfidence;
  /** Environment variable that holds this provider's key, if it has one. */
  readonly envVar: string | null;
}

interface Pattern {
  readonly providerId: string;
  readonly label: string;
  readonly envVar: string;
  /** Matched against the key as-is. Order matters: first hit wins. */
  readonly test: RegExp;
  /** A pattern may declare itself inconclusive and never trigger a switch. */
  readonly confidence: KeyConfidence;
}

/**
 * Ordered most-specific first.
 *
 * OpenAI and Anthropic both start with `sk-`, so anything that extends those
 * prefixes has to be tested before them. `gsk_` and `AIza` are unambiguous and
 * therefore `certain`.
 */
const PATTERNS: readonly Pattern[] = [
  {
    // OpenCode's own key. Unambiguous prefix.
    providerId: "opencode-zen",
    label: "OpenCode Zen",
    envVar: "OPENCODE_API_KEY",
    test: /^oc_sk_[A-Za-z0-9_-]{8,}$/,
    confidence: "certain",
  },
  {
    providerId: "anthropic",
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    test: /^sk-ant-(api\d{2}-)?[A-Za-z0-9_-]{20,}$/,
    confidence: "certain",
  },
  {
    providerId: "openrouter",
    label: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    test: /^sk-or-v1-[A-Za-z0-9]{16,}$/,
    confidence: "certain",
  },
  {
    providerId: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    // `sk-proj-` and `sk-svcacct-` are OpenAI-specific; a bare `sk-` is not
    // conclusive, so it is only "likely".
    test: /^sk-(proj|svcacct)-[A-Za-z0-9_-]{20,}$/,
    confidence: "certain",
  },
  {
    providerId: "groq",
    label: "Groq",
    envVar: "GROQ_API_KEY",
    test: /^gsk_[A-Za-z0-9]{20,}$/,
    confidence: "certain",
  },
  {
    providerId: "google",
    label: "Google Gemini",
    envVar: "GEMINI_API_KEY",
    test: /^AIza[A-Za-z0-9_-]{30,}$/,
    confidence: "certain",
  },
  {
    providerId: "deepseek",
    label: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    test: /^sk-[a-f0-9]{32}$/,
    confidence: "likely",
  },
  {
    providerId: "mistral",
    label: "Mistral",
    envVar: "MISTRAL_API_KEY",
    test: /^[A-Za-z0-9]{32,48}$/,
    confidence: "unknown",
  },
  // Bare `sk-`. OpenAI's classic format, but plenty of vendors copied it.
  {
    providerId: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    test: /^sk-[A-Za-z0-9_-]{20,}$/,
    confidence: "likely",
  },
];

const UNKNOWN: KeyDetection = {
  providerId: null,
  label: null,
  confidence: "unknown",
  envVar: null,
};

/**
 * Identify the provider for a key, or `unknown`.
 *
 * Only the shape is examined. The key is never logged, never included in the
 * return value, and never compared against anything but these patterns.
 */
export function detectProviderFromKey(rawKey: string): KeyDetection {
  const key = rawKey.trim();
  // Long enough to be a real key, short enough to be a paste accident.
  if (key.length < 8 || key.length > 512) return UNKNOWN;
  // Whitespace inside a key means a bad paste; matching on a mangled value
  // would send it somewhere wrong.
  if (/\s/.test(key)) return UNKNOWN;

  for (const pattern of PATTERNS) {
    if (pattern.test.test(key)) {
      // A shape that maps to a provider Atomic cannot build is not a detection.
      if (providerById(pattern.providerId) === null) return UNKNOWN;
      return {
        providerId: pattern.providerId,
        label: pattern.label,
        // A pattern declared `unknown` is only a hint for the UI to show; it
        // never drives an automatic switch.
        confidence: pattern.confidence,
        envVar: pattern.envVar,
      };
    }
  }
  return UNKNOWN;
}

/** True when the UI may switch providers without asking first. */
export function isConfident(detection: KeyDetection): boolean {
  return detection.providerId !== null && detection.confidence === "certain";
}

/**
 * A detection that names a provider this build does not know would put the app
 * in a state it cannot recover from, so unknown ids are reported as unknown.
 */
export function isDetectableProvider(providerId: string | null): boolean {
  return providerId !== null && providerById(providerId) !== null;
}
