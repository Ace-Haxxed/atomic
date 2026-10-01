/**
 * @vitest-environment jsdom
 *
 * The Ollama address field, driven by real typing and clicks.
 *
 * The failure this is about is the one that looks like a working app. Save an
 * address that is not serving Ollama, and the app reports success; every later
 * failure is then reported against the models, none of which were ever asked,
 * because nothing was listening on the port that was written down. The user
 * loses the thread entirely, and the evidence needed to find the cause -- that
 * the address itself was never valid -- is gone by then.
 *
 * So the behaviour under test is not "a warning appeared". It is *which writes
 * reached the host*, read back from the calls this test records. A rejected
 * address must never become a stored one, no matter how it is rejected, and that
 * is the part worth pinning down.
 */

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import {
  DEFAULT_SETTINGS,
  OLLAMA_DEFAULT_ROOT,
  SettingsSchema,
  mergeDeep,
  type DeepPartial,
  type HostApi,
  type Settings,
} from "@atomic/core";

import { ModelsTab } from "./models-tab.js";
import type { ModelCatalogState } from "../app/use-models.js";

/**
 * A catalog holding a single Ollama section, which is all the address controls
 * need in order to render. The model list is empty on purpose: this file is about
 * where the address goes, and an installed model would only add a delete button
 * to click past.
 */
function ollamaCatalog(reachable = true): ModelCatalogState {
  return {
    models: [],
    sections: [
      {
        providerId: "ollama",
        providerLabel: "Ollama",
        models: [],
        status: reachable ? "connected" : "unreachable",
        error: null,
        fetchedAt: 0,
        stale: false,
        unconfigured: false,
      },
    ],
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

/** Fresh settings carrying `baseUrl` for Ollama, or none if it is undefined. */
/**
 * The stored Ollama address.
 *
 * Takes `Settings | undefined` because `writes[0]` is possibly-absent under
 * `noUncheckedIndexedAccess`. Reading it this way keeps a missing write failing
 * as a wrong address rather than as a crash inside the test.
 */
function ollamaUrl(settings: Settings | undefined): string | undefined {
  return settings?.providers.ollama?.baseUrl;
}

function withOllamaUrl(baseUrl: string | undefined): Settings {
  if (baseUrl === undefined) return DEFAULT_SETTINGS;
  const next: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS) as Record<string, unknown>;
  (next.providers as Record<string, unknown>).ollama = {
    ...((next.providers as Record<string, Record<string, unknown>>).ollama ?? {}),
    baseUrl,
  };
  return SettingsSchema.parse(next);
}

function Harness({
  api,
  reachable,
  savedUrl,
}: {
  readonly api: HostApi;
  readonly reachable: boolean;
  /** The address already in settings, if any. Fresh settings store none. */
  readonly savedUrl?: string;
}) {
  // Round-tripped through the schema rather than spread: the stored form fills
  // in every provider's fields, so a hand-built record is a different shape from
  // the defaults object even though the two look interchangeable in a test.
  const initial: Settings = withOllamaUrl(savedUrl);
  const [settings, setSettings] = useState<Settings>(initial);
  return (
    <ModelsTab
      api={api}
      settings={settings}
      mode="chat"
      catalog={ollamaCatalog(reachable)}
      onSettings={setSettings}
    />
  );
}

/**
 * Records every settings write, so a test can prove what was persisted.
 *
 * `updateSettings` takes a *patch* and returns the whole document, the way
 * `SettingsStore.patch` does. This stand-in used to return the patch verbatim,
 * which broke the contract in a way that read as a product bug: the app stores
 * the returned value as the live settings, so a patch carrying only
 * `providers.ollama` left `models` undefined, and the next render of the models
 * browser threw `Cannot read properties of undefined` from `modelFor`. The real
 * host deep-merges, so this one does too -- via the same `mergeDeep` the store
 * uses, rather than a second implementation of the same rule.
 */
function recordingApi(write: (next: Settings) => Settings = (next) => next) {
  const writes: Settings[] = [];
  const reloads: number[] = [];
  // The document as the host currently holds it, so each patch is applied to
  // what came before rather than to a fixed starting point.
  let current: Settings = DEFAULT_SETTINGS;
  const api = {
    async apiKeySources() {
      return {} as Record<string, "keychain" | "env" | "none">;
    },
    async hasApiKey() {
      return false;
    },
    async setApiKey() {},
    async updateSettings(patch: DeepPartial<Settings>) {
      writes.push(patch as Settings);
      current = SettingsSchema.parse(mergeDeep(current, patch));
      return write(current);
    },
    async ollamaPull(_model: string, onProgress: (u: { status: string }) => void) {
      onProgress({ status: "pulling" });
      return { ok: true as const };
    },
    async ollamaDelete() {
      return { ok: true as const };
    },
    async cancelOllamaPull() {},
  } as unknown as HostApi;
  return { api, writes, reloads };
}

/**
 * Open the Models tab, clear the address field, then type `url` into it.
 *
 * `savedUrl` is what the conversation starts with stored, which is separate from
 * what gets typed: the difference between the two is the only thing that enables
 * Save, so a test that ignores it can pass for the wrong reason.
 */
async function openOllama(url: string, api: HostApi, reachable = true, savedUrl?: string) {
  const user = userEvent.setup();
  render(<Harness api={api} reachable={reachable} savedUrl={savedUrl} />);
  await user.click(screen.getByRole("tab", { name: "Models" }));
  const field = screen.getByLabelText("Ollama server URL");
  await user.clear(field);
  if (url) await user.type(field, url);
  return { user, field };
}

const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Save" }));

describe("the Ollama address field", () => {
  it("rejects an address that is not a URL and never writes it", async () => {
    const { api, writes } = recordingApi();
    const { user } = await openOllama("not a url", api);

    await save(user);

    // The assertion that matters: not merely that an error is on screen, but
    // that the bad address is nowhere near the stored settings.
    expect(writes).toHaveLength(0);
    expect(await screen.findByRole("alert")).toHaveTextContent(/url|address|valid/i);
  });

  it("rejects an address whose scheme cannot serve HTTP", async () => {
    // Passes a naive "does it look like a URL" check and still cannot be talked
    // to. This is the one that used to get saved.
    const { api, writes } = recordingApi();
    const { user } = await openOllama("file:///etc/passwd", api);

    await save(user);

    expect(writes).toHaveLength(0);
  });

  it("saves an address that is a real http endpoint", async () => {
    const { api, writes } = recordingApi();
    const { user } = await openOllama("http://192.168.1.50:11434", api);

    await save(user);

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(ollamaUrl(writes[0])).toBe("http://192.168.1.50:11434");
  });

  it("falls back to the default when a stored address is cleared", async () => {
    // Only reachable once something is stored: with nothing stored, an empty
    // field is not a change and Save stays disabled.
    const { api, writes } = recordingApi();
    const { user } = await openOllama("", api, true, "http://192.168.1.50:11434");

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await save(user);

    await waitFor(() => expect(writes).toHaveLength(1));
    // An empty field means "the usual place", not "the empty string", which
    // would leave every later request aimed at nothing.
    expect(ollamaUrl(writes[0])).toBe(OLLAMA_DEFAULT_ROOT);
  });

  it("offers no way to clear the address back to nothing once one is stored", async () => {
    // The field can only be emptied *towards* the default. Saving an empty
    // string would aim every later request at no host at all, so the reset has
    // to land on a working address rather than on nothing.
    const { api, writes } = recordingApi();
    const { user } = await openOllama("", api, true, "http://192.168.1.50:11434");
    await save(user);

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(ollamaUrl(writes[0])).toBe(OLLAMA_DEFAULT_ROOT);
  });

  it("keeps the saved address when the host rejects the write", async () => {
    // The store now rolls a failed write back, so the field must not end up
    // displaying an address the settings no longer hold.
    const { api, writes } = recordingApi(() => {
      throw new Error("settings file is read-only");
    });
    const { user } = await openOllama("http://127.0.0.1:11434", api);

    await save(user);

    expect(writes).toHaveLength(1);
    expect(await screen.findByRole("alert")).toHaveTextContent(/read-only/i);
    expect(screen.getByLabelText("Ollama server URL")).toHaveValue("http://127.0.0.1:11434");
  });

  it("says plainly when nothing is answering, rather than showing an empty list", async () => {
    // An unreachable Ollama and an Ollama with nothing installed look identical
    // in a bare list, and the second reading sends the user off to pull models
    // that would not have helped.
    const { api } = recordingApi();
    await openOllama("", api, false);

    expect(await screen.findByText(/nothing is answering/i)).toBeInTheDocument();
  });

  it("enables Save only once the field differs from the saved address", async () => {
    const { api } = recordingApi();
    const { user, field } = await openOllama("", api);

    // Nothing typed yet, so the field already matches what is stored.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(field, "9");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});

describe("pulling a model", () => {
  it("will not pull an empty model name", async () => {
    const pull = vi.fn(async () => ({ ok: true as const }));
    const { api } = recordingApi();
    (api as unknown as { ollamaPull: typeof pull }).ollamaPull = pull;
    await openOllama("", api);

    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
    expect(pull).not.toHaveBeenCalled();
  });

  it("reports a pull that fails", async () => {
    const { api } = recordingApi();
    (api as unknown as { ollamaPull: unknown }).ollamaPull = async () => ({
      ok: false as const,
      message: "no space left on device",
    });
    const user = userEvent.setup();
    render(<Harness api={api} reachable />);
    await user.click(screen.getByRole("tab", { name: "Models" }));
    await user.type(screen.getByLabelText("Ollama model to pull"), "qwen3-coder:30b");
    await user.click(screen.getByRole("button", { name: "Pull" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no space left/i);
  });
});
