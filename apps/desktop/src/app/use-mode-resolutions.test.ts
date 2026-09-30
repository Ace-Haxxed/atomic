/**
 * Startup has to survive a model it cannot resolve.
 *
 * The cases below are the ways a mode ends up unusable while the app is still
 * perfectly fine to open: the catalog is unreachable, the provider is not
 * configured, the selected model was removed, the list came back empty. None of
 * them is a reason to show an error page, and the difference between a banner
 * and a crash is the difference between a user who picks another model and a user
 * who cannot start the app at all.
 */

import { describe, expect, it } from "vitest";
import { AUTO_MODEL, SettingsSchema, type Mode, type Settings } from "@atomic/core";

import { toModeResolutions } from "./use-models.js";

const settings = (models: Partial<Record<Mode, string>> = {}) =>
  SettingsSchema.parse({
    models: { chat: AUTO_MODEL, cowork: AUTO_MODEL, code: AUTO_MODEL, ...models },
  });

const ALL: readonly Mode[] = ["chat", "cowork", "code"];

const empty = Object.fromEntries(ALL.map((mode) => [mode, AUTO_MODEL])) as Record<
  Mode,
  string
>;

describe("toModeResolutions", () => {
  it("reports nothing missing when every mode is on a real model", () => {
    const rows = toModeResolutions(
      settings({ chat: "b", cowork: "c", code: "d" }),
      { chat: "b", cowork: "c", code: "d" },
      [],
    );
    expect(rows.every((row) => row.notice === null)).toBe(true);
    expect(rows.every((row) => !row.unresolvable)).toBe(true);
  });

  it("flags an Auto that resolved to nothing", () => {
    // Every provider offline, or an empty catalog. The sentinel is what send
    // will actually meet, so it must not be reported as a working model.
    const rows = toModeResolutions(settings(), empty, []);
    expect(rows.every((row) => row.unresolvable)).toBe(true);
  });

  it("does not flag Auto that resolved to a model", () => {
    const rows = toModeResolutions(
      settings(),
      { chat: "space-bunny-free", cowork: "space-bunny-free", code: "space-bunny-free" },
      [],
    );
    expect(rows.every((row) => !row.unresolvable)).toBe(true);
  });

  it("carries the host's notice and replacement for a removed model", () => {
    const rows = toModeResolutions(
      settings({ chat: "deleted-model" }),
      // The host echoes a pinned model straight back without checking the
      // catalog, so this row proves nothing on its own. The notice is what
      // carries the truth.
      { chat: "deleted-model", cowork: "ok", code: "ok" },
      [
        {
          mode: "chat",
          notice: "chat pointed at deleted-model, which no longer exists.",
          effective: "ok",
        },
      ],
    );
    const chat = rows.find((row) => row.mode === "chat");
    expect(chat?.notice).toContain("deleted-model");
    expect(chat?.effective).toBe("ok");
    // Not unresolvable: a replacement was found, so this is a warning rather
    // than a mode with nothing to send to.
    expect(chat?.unresolvable).toBe(false);
  });

  it("leaves the other modes alone when one is broken", () => {
    const rows = toModeResolutions(
      settings({ chat: "gone", cowork: "b", code: "c" }),
      { chat: AUTO_MODEL, cowork: "b", code: "c" },
      [{ mode: "chat", notice: "gone is not available.", effective: "b" }],
    );
    const others = rows.filter((row) => row.mode !== "chat");
    expect(others.every((row) => row.notice === null)).toBe(true);
  });

  it("flags a mode with no replacement as both missing and unresolvable", () => {
    const rows = toModeResolutions(
      settings({ chat: "gone" }),
      { chat: "gone", cowork: AUTO_MODEL, code: AUTO_MODEL },
      [{ mode: "chat", notice: "gone is not available.", effective: "" }],
    );
    const chat = rows.find((row) => row.mode === "chat");
    expect(chat?.unresolvable).toBe(true);
    expect(chat?.notice).toContain("gone");
  });

  it("covers every mode the host answered for", () => {
    // A mode silently absent from the rows would mean a header that never says
    // anything is wrong, which is the failure this whole thing exists to stop.
    const rows = toModeResolutions(settings(), empty, []);
    expect(rows.map((row) => row.mode).sort()).toEqual([...ALL].sort());
  });
});
