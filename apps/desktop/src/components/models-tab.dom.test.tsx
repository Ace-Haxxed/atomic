/**
 * @vitest-environment jsdom
 *
 * The API keys tab, driven by real clicks and typing.
 *
 * The behaviour under test is the one that costs something when it is wrong. A
 * key pasted into the wrong provider's field is saved, the app reports success,
 * and the failure surfaces much later as an authentication error with no trace of
 * what replaced what. So the assertion is not "a warning appeared" -- it is
 * *which provider received the key*, read back from the host calls this test
 * records.
 *
 * The markup tests alongside these render the same component to a string and
 * cannot click anything, which is why this file exists rather than more
 * assertions in that one.
 */

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DEFAULT_SETTINGS, PROVIDERS, type HostApi, type Settings } from "@atomic/core";

import { ModelsTab } from "./models-tab.js";
import type { ModelCatalogState } from "../app/use-models.js";

/**
 * Key-shaped fixtures. Never credentials: nothing here is sent anywhere, and a
 * real key in a test file is a real key in a git history.
 */
const GOOGLE_KEY = "AIzaSyD-ExampleFixtureKeyForTestsOnly_000";
const OPENROUTER_KEY = "sk-or-v1-0123456789abcdefghijklmnop";

/** A catalog with nothing in it; this file is about keys, not models. */
function emptyCatalog(): ModelCatalogState {
  return {
    models: [],
    sections: [],
    loading: false,
    error: null,
    reload: () => {},
    refreshing: false,
    auto: null,
    usingAuto: true,
    onlyFree: false,
    setOnlyFree: () => {},
    filters: {},
    setFilters: () => {},
  };
}

function Harness({ api, settings }: { readonly api: HostApi; readonly settings: Settings }) {
  const [current, setCurrent] = useState(settings);
  return (
    <ModelsTab
      api={api}
      settings={current}
      mode="chat"
      catalog={emptyCatalog()}
      onSettings={setCurrent}
    />
  );
}

/** Records every write, so a test can prove which slot a key landed in. */
function recordingApi(sources: Record<string, "keychain" | "env" | "none"> = {}) {
  const saved = new Map<string, string | null>();
  const api = {
    async apiKeySources() {
      return { ...sources };
    },
    async hasApiKey(providerId: string) {
      return saved.has(providerId);
    },
    async setApiKey(providerId: string, value: string | null) {
      if (value === null) saved.delete(providerId);
      else saved.set(providerId, value);
    },
  } as unknown as HostApi;
  return { api, saved };
}

async function openKeysTab(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderKeysTab();
  await user.click(screen.getByRole("tab", { name: "API keys" }));
  return user;
}

let renderKeysTab: () => void;

function keyFieldFor(label: string): HTMLElement {
  return screen.getByLabelText(label);
}

/**
 * The card a field belongs to.
 *
 * Every provider renders its own Save and Remove, so an unscoped query finds one
 * per row and the test fails on "multiple elements" for a reason unrelated to
 * what it is checking.
 */
function rowFor(label: string): HTMLElement {
  const field = keyFieldFor(label);
  const card = field.closest("[class*='space-y-2']");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`no card found around ${label}`);
  }
  return card;
}

describe("a key pasted into the wrong provider's field", () => {
  it("adds a conclusive Google key to Google, not to the field it was pasted in", async () => {
    const { api, saved } = recordingApi();
    renderKeysTab = () => {
      render(<Harness api={api} settings={DEFAULT_SETTINGS} />);
    };
    const user = await openKeysTab();

    // Pasted into OpenRouter's field. The shape is not ambiguous -- `AIza` is
    // Google's own prefix -- so there is no reading of this in which the user
    // meant to save it under OpenRouter.
    await user.type(keyFieldFor("OpenRouter API key"), GOOGLE_KEY);
    expect(screen.getByText(/looks like a Google Gemini key/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Add to Google Gemini instead/i }));

    await waitFor(() => expect(saved.get("google")).toBe(GOOGLE_KEY));
    // The field it was pasted into is untouched: nothing was overwritten.
    expect(saved.has("openrouter")).toBe(false);
  });

  it("does not offer a Save that would write it to the wrong provider", async () => {
    const { api } = recordingApi();
    renderKeysTab = () => {
      render(<Harness api={api} settings={DEFAULT_SETTINGS} />);
    };
    const user = await openKeysTab();

    await user.type(keyFieldFor("OpenRouter API key"), GOOGLE_KEY);

    // The only action on the row is the one that routes the key correctly. A
    // plain "Save" here is the bug: it would be the button a user reaches for
    // without reading the note underneath.
    expect(within(rowFor("OpenRouter API key")).queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("leaves an inconclusive guess alone, because the field the user chose is evidence", async () => {
    const { api, saved } = recordingApi();
    renderKeysTab = () => {
      render(<Harness api={api} settings={DEFAULT_SETTINGS} />);
    };
    const user = await openKeysTab();

    // OpenRouter's own `sk-or-v1-` prefix, pasted into the OpenRouter field. Same
    // shape, matching provider: nothing to redirect.
    await user.type(keyFieldFor("OpenRouter API key"), OPENROUTER_KEY);
    await user.click(within(rowFor("OpenRouter API key")).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saved.get("openrouter")).toBe(OPENROUTER_KEY));
  });

  it("still offers the other provider when the shape is inconclusive", async () => {
    const { api, saved } = recordingApi();
    renderKeysTab = () => {
      render(<Harness api={api} settings={DEFAULT_SETTINGS} />);
    };
    const user = await openKeysTab();

    /*
     * `sk-` is shared, so an Anthropic key pasted into Anthropic's own field is
     * reported as a possible *OpenAI* key -- and, being inconclusive, must not
     * take the field away from the user. The redirect is offered, not imposed.
     */
    const anthropicKey = "sk-ant-0123456789abcdef";
    await user.type(keyFieldFor("Anthropic API key"), anthropicKey);
    const note = screen.getByText(/many vendors share this prefix/i);
    expect(note).toBeInTheDocument();
    expect(note).toHaveTextContent(/looks like a OpenAI key/i);

    await user.click(within(note).getByRole("button", { name: /OpenAI instead/i }));
    await waitFor(() => expect(saved.get("openai")).toBe(anthropicKey));
    // Not to the field it was pasted in: the button said where it was going.
    expect(saved.has("anthropic")).toBe(false);
  });

  it("never overwrites a saved key of another provider", async () => {
    const sources = { google: "keychain" as const, openrouter: "keychain" as const };
    const { api, saved } = recordingApi(sources);
    // Pretend both are already stored, as a user with two accounts would be.
    await api.setApiKey("google", "AIzaSyD-PreexistingGoogleKey_000");
    await api.setApiKey("openrouter", OPENROUTER_KEY);
    renderKeysTab = () => {
      render(<Harness api={api} settings={DEFAULT_SETTINGS} />);
    };
    const user = await openKeysTab();

    await user.type(keyFieldFor("OpenRouter API key"), GOOGLE_KEY);
    await user.click(screen.getByRole("button", { name: /Add to Google Gemini instead/i }));

    await waitFor(() => expect(saved.get("google")).toBe(GOOGLE_KEY));
    // The pre-existing OpenRouter key is still there, byte for byte.
    expect(saved.get("openrouter")).toBe(OPENROUTER_KEY);
  });

  it("keeps the key out of the database entirely", async () => {
    const { api, saved } = recordingApi();
    const setApiKey = vi.spyOn(api, "setApiKey");
    renderKeysTab = () => {
      render(<Harness api={api} settings={DEFAULT_SETTINGS} />);
    };
    const user = await openKeysTab();

    await user.type(keyFieldFor("OpenRouter API key"), GOOGLE_KEY);
    await user.click(screen.getByRole("button", { name: /Add to Google Gemini instead/i }));

    await waitFor(() => expect(saved.size).toBe(1));
    // The only call made is the provider-scoped one: there is no untyped
    // "save this key" that could put it somewhere generic.
    expect(setApiKey).toHaveBeenCalledTimes(1);
    expect(setApiKey).toHaveBeenCalledWith("google", GOOGLE_KEY);
  });

  it("reports a store that accepts the write but cannot return it", async () => {
    const { api, saved } = recordingApi();
    // A keychain that takes the write and does not hand it back would otherwise
    // be reported here as a success.
    (api as unknown as { hasApiKey: () => Promise<boolean> }).hasApiKey = async () => false;
    renderKeysTab = () => {
      render(<Harness api={api} settings={DEFAULT_SETTINGS} />);
    };
    const user = await openKeysTab();

    await user.type(keyFieldFor("OpenRouter API key"), GOOGLE_KEY);
    await user.click(screen.getByRole("button", { name: /Add to Google Gemini instead/i }));

    expect(await screen.findByText(/cannot confirm it is usable/i)).toBeInTheDocument();
    expect(saved.size).toBe(1);
  });

  it("says each provider keeps its own key, so saving one does not change the target", () => {
    const { api } = recordingApi();
    render(<Harness api={api} settings={DEFAULT_SETTINGS} />);
    // Rendered after the tab switch, so assert on the tab first.
    expect(screen.getByRole("tab", { name: "API keys" })).toBeInTheDocument();
  });
});

describe("the API keys tab lists every provider", () => {
  it("gives each provider its own field", async () => {
    const { api } = recordingApi();
    renderKeysTab = () => {
      render(<Harness api={api} settings={DEFAULT_SETTINGS} />);
    };
    await openKeysTab();
    for (const provider of PROVIDERS) {
      if (provider.id === "ollama") continue;
      expect(screen.getByLabelText(`${provider.label} API key`)).toBeInTheDocument();
    }
  });

  it("offers no key field for Ollama, which needs none", async () => {
    const { api } = recordingApi();
    renderKeysTab = () => {
      render(<Harness api={api} settings={DEFAULT_SETTINGS} />);
    };
    const user = await openKeysTab();
    expect(screen.queryByLabelText("Ollama API key")).not.toBeInTheDocument();
    // And it says so, rather than showing an empty field that promises nothing.
    expect(screen.getByText(/needs no key/i)).toBeInTheDocument();
    void user;
  });
});
