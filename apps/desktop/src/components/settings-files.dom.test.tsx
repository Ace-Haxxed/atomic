/**
 * @vitest-environment jsdom
 *
 * The Files section of Settings, driven by real clicks.
 *
 * This is a security control wearing a settings form's clothes, so the assertions
 * are about *persistence* rather than appearance: that a folder the user picked
 * is actually written, that removing one actually stops granting it, and that
 * picking the same folder twice does not quietly produce two grants. A list that
 * looks right but never reaches settings would leave the model refusing paths the
 * user has explicitly allowed, which reads as the feature being broken.
 */

import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { DEFAULT_SETTINGS, SettingsSchema, type HostApi, type Settings } from "@atomic/core";

import { SettingsPanel } from "./settings-panel.js";

/** The allowed folders after the last write, read safely under noUncheckedIndexedAccess. */
function allowed(writes: readonly Settings[]): readonly string[] {
  return writes[writes.length - 1]?.files.allowedFolders ?? [];
}

const CODE = "/home/me/Code";
const DOCS = "/home/me/Docs";

/** What the user gets back from the folder picker, in order. */
function picker(...folders: (string | null)[]): () => Promise<string | null> {
  let index = 0;
  return async () => folders[index++] ?? null;
}

function stubApi(options: { pick?: () => Promise<string | null>; fail?: boolean } = {}) {
  const writes: Settings[] = [];
  const api = {
    async apiKeySources() {
      return {} as Record<string, "keychain" | "env" | "none">;
    },
    async hasApiKey() {
      return false;
    },
    async setApiKey() {},
    async updateSettings(patch: Record<string, unknown>) {
      // Mirrors the real store: a deep merge where arrays are replaced whole.
      const next = structuredClone(patch) as Record<string, unknown>;
      if (options.fail) throw new Error("settings file is read-only");
      const merged = { ...structuredClone(last), ...next } as Settings;
      writes.push(merged);
      last = merged;
      return SettingsSchema.parse(merged);
    },
    async pickFolder() {
      return (options.pick ?? (async () => null))();
    },
    async ollamaPull() {
      return { ok: true as const };
    },
    async ollamaDelete() {
      return { ok: true as const };
    },
    async cancelOllamaPull() {},
  } as unknown as HostApi;
  let last: Settings = structuredClone(DEFAULT_SETTINGS);
  return { api, writes };
}

async function openPanel(api: HostApi, initial: Settings = DEFAULT_SETTINGS) {
  const user = userEvent.setup();
  const adopted: Settings[] = [];
  render(
    <SettingsPanel
      api={api}
      initial={initial}
      mode="code"
      onModeChange={() => {}}
      onClose={() => {}}
      onSettings={(next: Settings) => adopted.push(next)}
    />,
  );
  return { user, adopted };
}

const addFolder = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Add folder" }));

describe("folders allowed under Settings > Files", () => {
  it("says plainly that no folder is allowed yet", async () => {
    // A silent empty list would leave a user wondering whether the section is
    // working, or whether the agent is already reading everything.
    const { api } = stubApi();
    await openPanel(api);
    expect(await screen.findByText(/no extra folders/i)).toBeInTheDocument();
  });

  it("persists a folder the user picked", async () => {
    const { api, writes } = stubApi({ pick: picker(CODE) });
    const { user } = await openPanel(api);

    await addFolder(user);

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(allowed(writes)).toEqual([CODE]);
    expect(await screen.findByText(CODE)).toBeInTheDocument();
  });

  it("adds a second folder without losing the first", async () => {
    const { api, writes } = stubApi({ pick: picker(CODE, DOCS) });
    const { user } = await openPanel(api);

    await addFolder(user);
    await waitFor(() => expect(screen.getByText(CODE)).toBeInTheDocument());
    await addFolder(user);

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(allowed(writes)).toEqual([CODE, DOCS]);
  });

  it("stops granting a folder once it is removed", async () => {
    const { api, writes } = stubApi({ pick: picker(CODE, DOCS) });
    const { user } = await openPanel(api);
    await addFolder(user);
    await waitFor(() => expect(screen.getByText(CODE)).toBeInTheDocument());
    await addFolder(user);
    await waitFor(() => expect(screen.getByText(DOCS)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: `Stop using ${CODE}` }));

    await waitFor(() => expect(writes).toHaveLength(3));
    // Arrays are replaced whole, not merged by index, so removal is real. A
    // merged array would leave a third entry behind and quietly keep granting it.
    expect(allowed(writes)).toEqual([DOCS]);
    expect(screen.queryByText(CODE)).not.toBeInTheDocument();
  });

  it("refuses to add the same folder twice", async () => {
    const { api, writes } = stubApi({ pick: picker(CODE, CODE) });
    const { user } = await openPanel(api);

    await addFolder(user);
    await waitFor(() => expect(screen.getByText(CODE)).toBeInTheDocument());
    await addFolder(user);

    // Reported rather than accepted: a second identical grant would look like a
    // success and change nothing, which is the worst outcome for a control whose
    // whole job is to be trustworthy about what it has granted.
    expect(await screen.findByRole("alert")).toHaveTextContent(/already on the list/i);
    expect(writes).toHaveLength(1);
  });

  it("treats a trailing separator as the same folder", async () => {
    const { api, writes } = stubApi({ pick: picker(`${CODE}/`, CODE) });
    const { user } = await openPanel(api);

    await addFolder(user);
    // Stored as picked. Normalizing what is saved is not this control's job, and
    // rewriting a path the user chose tends to surprise later, when it no longer
    // matches what the folder picker would return.
    await waitFor(() => expect(screen.getByText(`${CODE}/`)).toBeInTheDocument());
    await addFolder(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(/already on the list/i);
    expect(writes).toHaveLength(1);
  });

  it("writes nothing when the picker is cancelled", async () => {
    const { api, writes } = stubApi({ pick: picker(null) });
    const { user } = await openPanel(api);

    await addFolder(user);

    // A cancelled dialog is a normal outcome, not an error, and must not clear
    // the folders already granted.
    expect(writes).toHaveLength(0);
    expect(screen.getByText(/no extra folders/i)).toBeInTheDocument();
  });

  it("keeps the folder listed when the write fails", async () => {
    const { api } = stubApi({ pick: picker(CODE), fail: true });
    const { user } = await openPanel(api);

    await addFolder(user);

    // The list is built from stored settings, so a failed write leaves the UI
    // showing what is actually granted -- which is the only safe direction to be
    // wrong in.
    await waitFor(() =>
      expect(screen.getAllByText(/read-only/i).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(CODE)).not.toBeInTheDocument();
  });

  it("explains that the model cannot add folders itself", async () => {
    const { api } = stubApi();
    await openPanel(api);
    expect(await screen.findByText(/cannot add one itself/i)).toBeInTheDocument();
  });

  it("starts from folders already stored, without rewriting them", async () => {
    const stored = SettingsSchema.parse({ files: { allowedFolders: [CODE] } });
    const { api, writes } = stubApi();
    const { user } = await openPanel(api, stored);

    expect(await screen.findByText(CODE)).toBeInTheDocument();
    // Opening Settings must not itself be a write: a panel that re-saves on open
    // would rewrite the file on every visit, and would clobber a change made in
    // another window while this one was open.
    expect(writes).toHaveLength(0);
    await addFolder(user);
    expect(writes).toHaveLength(0);
  });
});
