import { describe, expect, it } from "vitest";
import { detectProviderFromKey, isConfident } from "./detect-key.js";

/** Shape-accurate prefixes. The bodies are fake and carry no real credential. */
const keys = {
  opencode: `oc_sk_${"a".repeat(40)}`,
  anthropic: `sk-ant-api03-${"b".repeat(40)}`,
  openaiProject: `sk-proj-${"c".repeat(40)}`,
  openaiLegacy: `sk-${"d".repeat(48)}`,
  openrouter: `sk-or-v1-${"e".repeat(32)}`,
  groq: `gsk_${"f".repeat(40)}`,
  google: `AIza${"g".repeat(35)}`,
  deepseek: `sk-${"0123456789abcdef".repeat(2)}`,
} as const;

describe("detectProviderFromKey", () => {
  it("recognises an OpenCode key", () => {
    const found = detectProviderFromKey(keys.opencode);

    // The registry id, so the detection lands on a provider Atomic can build.
    expect(found.providerId).toBe("opencode-zen");
    expect(found.envVar).toBe("OPENCODE_API_KEY");
    expect(isConfident(found)).toBe(true);
  });

  it("recognises an Anthropic key", () => {
    expect(detectProviderFromKey(keys.anthropic).providerId).toBe("anthropic");
  });

  it("recognises a Google key", () => {
    expect(detectProviderFromKey(keys.google).providerId).toBe("google");
  });

  it("recognises a Groq key", () => {
    expect(detectProviderFromKey(keys.groq).providerId).toBe("groq");
  });

  it("recognises an OpenRouter key", () => {
    expect(detectProviderFromKey(keys.openrouter).providerId).toBe("openrouter");
  });

  it("prefers the specific OpenAI variant over the bare sk- form", () => {
    // `sk-proj-` and `sk-ant-` both start with `sk-`; ordering is the contract.
    expect(detectProviderFromKey(keys.openaiProject).providerId).toBe("openai");
    expect(detectProviderFromKey(keys.anthropic).providerId).toBe("anthropic");
  });

  it("treats a bare sk- key as only likely, never certain", () => {
    // Many vendors copied OpenAI's format, so switching on it alone would send
    // a credential to the wrong place.
    const found = detectProviderFromKey(keys.openaiLegacy);

    expect(found.providerId).toBe("openai");
    expect(found.confidence).toBe("likely");
    expect(isConfident(found)).toBe(false);
  });

  it("returns unknown rather than guessing", () => {
    for (const candidate of ["", "   ", "hunter2", "not-a-key-at-all", "abc"]) {
      const found = detectProviderFromKey(candidate);

      expect(found.providerId).toBeNull();
      expect(found.confidence).toBe("unknown");
      expect(isConfident(found)).toBe(false);
    }
  });

  it("rejects a key with an interior newline from a bad paste", () => {
    // Trailing whitespace is normal; a newline in the middle means the paste
    // wrapped, and the value the user holds is not the key they think it is.
    expect(detectProviderFromKey(`sk-ant-api03-${"b".repeat(20)}\n${"c".repeat(20)}`).providerId)
      .toBeNull();
  });

  it("trims the whitespace a copy-and-paste leaves behind", () => {
    expect(detectProviderFromKey(`  ${keys.google}  `).providerId).toBe("google");
  });

  it("does not echo the key back in its result", () => {
    // The result is what gets logged and put in a toast.
    const found = detectProviderFromKey(keys.anthropic);

    expect(JSON.stringify(found)).not.toContain("b".repeat(40));
  });
});
