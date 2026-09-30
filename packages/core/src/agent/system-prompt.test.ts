import { describe, expect, it } from "vitest";

import { buildSystemPrompt, deriveTitle } from "./system-prompt.js";
import { describeShell } from "../platform/shell.js";
import type { PlatformInfo } from "../platform/platform.js";
import type { Mode } from "../settings/schema.js";

const LINUX: PlatformInfo = {
  os: "linux",
  homeDir: "/home/u",
  crlfByDefault: false,
};

function prompt(
  mode: Mode,
  overrides: { workspace?: string | null; planMode?: boolean } = {},
): string {
  return buildSystemPrompt({
    mode,
    platform: LINUX,
    shell: describeShell(LINUX, { shell: "bash", loginShell: true }),
    workspace: overrides.workspace === undefined ? null : overrides.workspace,
    customSystemPrompt: null,
    customInstructions: "",
    projectMemory: null,
    today: new Date("2026-09-29T12:00:00Z"),
    ...(overrides.planMode === undefined ? {} : { planMode: overrides.planMode }),
  });
}

describe("the Chat mode prompt", () => {
  /**
   * The core complaint.
   *
   * Chat mode has no tools. A prompt that does not say so leaves the model free
   * to either offer to open a file it cannot open, or to answer as if it had
   * already run the command -- and the user cannot tell which happened from the
   * reply.
   */
  it("states that there are no tools, as an absence", () => {
    const text = prompt("chat");
    expect(text).toMatch(/no tools/i);
    expect(text).toMatch(/cannot read or write files/i);
    expect(text).toMatch(/never say or imply that you did/i);
  });

  it("tells the model to point at Code mode instead of trying", () => {
    expect(prompt("chat")).toMatch(/point them to Code mode/i);
  });

  /**
   * Code mode needs a project folder. Telling someone to switch to a mode that
   * then has nowhere to work is the same dead end one step later.
   */
  it("names the workspace requirement when there is no folder", () => {
    expect(prompt("chat")).toMatch(/Code mode with a project folder selected/i);
  });

  it("points at the same workspace when there is one", () => {
    const text = prompt("chat", { workspace: "/home/u/project" });
    expect(text).toMatch(/point them to Code mode in this same workspace/i);
  });

  it("does not describe the shell, which reads as a capability", () => {
    // A detailed shell description in a conversation with no shell is what
    // makes the model answer as though it has one.
    expect(prompt("chat")).not.toContain("# Environment");
  });

  it("still describes the environment where tools exist", () => {
    // The guard on the change above: this is not a global removal.
    expect(prompt("code")).toContain("# Environment");
  });
});

describe("modes with tools", () => {
  it("tells Code mode it can work in the project", () => {
    expect(prompt("code")).toMatch(/Code mode/);
  });

  it("keeps plan mode read-only", () => {
    const text = prompt("code", { planMode: true, workspace: "/w" });
    expect(text).toMatch(/plan mode/i);
    expect(text).toMatch(/read-only/i);
  });
});

describe("deriveTitle", () => {
  it("uses the first non-empty line", () => {
    expect(deriveTitle("\n\nhello there")).toBe("hello there");
  });

  it("truncates at a word boundary", () => {
    const title = deriveTitle("one two three four five six seven eight", 20);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("seve…");
  });

  it("falls back when there is no text", () => {
    expect(deriveTitle("   ")).toBe("New chat");
  });
});
