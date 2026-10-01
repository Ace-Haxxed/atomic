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
  overrides: {
    workspace?: string | null;
    planMode?: boolean;
    browserTools?: readonly string[];
    noQuestionsMode?: boolean;
  } = {},
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
    ...(overrides.browserTools === undefined
      ? {}
      : { browserTools: overrides.browserTools }),
    ...(overrides.noQuestionsMode === undefined
      ? {}
      : { noQuestionsMode: overrides.noQuestionsMode }),
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

describe("the Cowork prompt", () => {
  /**
   * The claim that used to be unconditional.
   *
   * Cowork was described as operating a browser, told to prefer one, and told to
   * screenshot pages when layout mattered -- with nothing registered in the
   * `browser` category. Every answer that touched the web was a confident guess
   * presented as verification, which is the worst way for an agent to be wrong.
   */
  it("states the absence of a browser rather than promising one", () => {
    const text = prompt("cowork");
    expect(text).not.toMatch(/operating a web browser/i);
    expect(text).not.toMatch(/screenshot/i);
    expect(text).toMatch(/no browser/i);
  });

  it("tells the model to stop short of guessing what a page would contain", () => {
    // An honest "I could not check this" is useful. A plausible invented page is
    // not, and the prompt is the only place that difference can be taught.
    expect(prompt("cowork")).toMatch(/stop short of guessing/i);
  });

  it("describes a browser only when the registry has one to describe", () => {
    // The other half: this is not a permanent downgrade. The day something
    // registers a browser-category tool, the capability lines come back on their
    // own, without this prompt being edited.
    const text = prompt("cowork", { browserTools: ["browser_navigate", "browser_screenshot"] });
    expect(text).toMatch(/operating a web browser/i);
    expect(text).toMatch(/screenshot/i);
    expect(text).not.toMatch(/no browser/i);
  });

  it("keeps the filesystem claims in both cases", () => {
    // Only the browser is conditional. Files are real in both, and dropping that
    // along with the browser would be a second, quieter lie.
    expect(prompt("cowork")).toMatch(/local filesystem/i);
    expect(prompt("cowork", { browserTools: ["browser_navigate"] })).toMatch(
      /local filesystem/i,
    );
  });

  it("keeps the safety rules in both cases", () => {
    for (const browserTools of [[], ["browser_navigate"]]) {
      const text = prompt("cowork", { browserTools });
      expect(text).toMatch(/never enter credentials/i);
      expect(text).toMatch(/including anything that failed/i);
    }
  });
});

describe("the never-ask-clarifying-questions switch", () => {
  it("is absent by default, so the model may still ask", () => {
    // The guard on the change below: the setting defaults to false, and a prompt
    // that always carried this line would make the switch a decoration.
    expect(prompt("code")).not.toMatch(/clarifying questions/i);
  });

  it("tells the model to assume and continue when it is on", () => {
    const text = prompt("code", { noQuestionsMode: true });
    expect(text).toMatch(/clarifying questions/i);
    expect(text).toMatch(/state the assumption/i);
  });

  it("says what to do when the task genuinely cannot start", () => {
    // "Never ask" has to mean "proceed anyway", not "refuse to answer anything
    // ambiguous" -- which is its own unhelpful silence.
    expect(prompt("code", { noQuestionsMode: true })).toMatch(
      /do the part that is unblocked/i,
    );
  });

  it("exempts permission prompts from itself", () => {
    // The line that stops this from becoming an auto-approve switch. A user who
    // wants fewer interruptions should not get them by losing the prompts that
    // gate the agent's writes.
    const text = prompt("code", { noQuestionsMode: true });
    expect(text).toMatch(/permission prompts/i);
    expect(text).toMatch(/still asks/i);
  });

  it("applies to every mode, not just the one that mentions ambiguity", () => {
    for (const mode of ["chat", "code", "cowork"] as const) {
      expect(prompt(mode, { noQuestionsMode: true }), mode).toMatch(/clarifying questions/i);
    }
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
