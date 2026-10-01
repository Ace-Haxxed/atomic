/**
 * System prompt construction.
 *
 * The OS and shell are stated explicitly so the model writes commands that
 * actually run on this machine. Path conventions are spelled out because they
 * are the single most common source of cross-platform agent failures.
 */

import { describeShell, type ShellProfile } from "../platform/shell.js";
import type { PlatformInfo } from "../platform/platform.js";
import type { Mode } from "../settings/schema.js";
import { APP_NAME } from "../platform/dirs.js";

export interface SystemPromptInput {
  readonly mode: Mode;
  readonly platform: PlatformInfo;
  readonly shell: ShellProfile;
  readonly workspace: string | null;
  /** Per-chat override, set in the UI. */
  readonly customSystemPrompt: string | null;
  /** Global custom instructions from Settings. */
  readonly customInstructions: string;
  /** Contents of AGENTS.md, loaded automatically in Code mode. */
  readonly projectMemory: string | null;
  readonly today: Date;
  readonly tools?: readonly string[];
  /**
   * Tools that can drive a web browser, taken from the registry that will serve
   * this run.
   *
   * Named explicitly rather than sniffed out of `tools`, because the difference
   * between "has a browser" and "does not" is the difference between an accurate
   * prompt and one that sends the model looking for a capability it was promised
   * and never given. Empty today; the browser lines reappear on their own the
   * day something registers a tool in the `browser` category.
   */
  readonly browserTools?: readonly string[];
  /** Read-only first pass. */
  readonly planMode?: boolean;
  /**
   * The mode's "never ask clarifying questions" switch.
   *
   * Enforced here because this is the only place that can enforce it: a
   * clarifying question is text the model chooses to emit, and the gate decides
   * permissions, not conversation. Note what it does *not* reach -- an approval
   * prompt is not a clarifying question, and a mode with this on still stops for
   * every permission it always stopped for.
   */
  readonly noQuestionsMode?: boolean;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const sections: string[] = [];

  sections.push(
    `You are ${APP_NAME}, a desktop assistant running locally on the user's machine. ` +
      `Be direct and concise. Prefer doing the work over describing it.`,
  );

  // Only in modes that have tools. A detailed description of the shell in a
  // conversation where no shell is reachable reads as a capability, and the
  // model answers as though it has one.
  if (input.mode !== "chat") {
    sections.push(`# Environment\n${describeShell(input.platform, input.shell)}`);
  }

  const pathRules = pathRulesFor(input.platform, input.workspace);
  sections.push(`# Paths\n${pathRules}`);

  sections.push(
    `# Today's date\n${input.today.toISOString().slice(0, 10)} (local time ${
      formatTime(input.today)
    }).`,
  );

  const modeLines = modeGuidance(
    input.mode,
    input.planMode === true,
    Boolean(input.workspace),
    input.browserTools ?? [],
  );
  sections.push(`# Mode\n${modeLines}`);
  if (input.noQuestionsMode) sections.push(NO_QUESTIONS_GUIDANCE);

  if (input.workspace) {
    sections.push(
      `# Workspace\nThe working folder is \`${input.workspace}\`. ` +
        `Treat it as the root: all file paths are relative to it unless absolute. ` +
        `Never read or write outside it unless the user explicitly asks.`,
    );
  }

  if (input.tools?.length) {
    sections.push(`# Tools available\n${input.tools.map((tool) => `- \`${tool}\``).join("\n")}`);
  }

  if (input.projectMemory?.trim()) {
    sections.push(
      `# Project instructions (${"AGENTS.md"})\nThe user maintains a project instruction file. ` +
        `Follow it unless the current request overrides it.\n\n${input.projectMemory.trim()}`,
    );
  }

  if (input.customSystemPrompt?.trim()) {
    sections.push(`# Instructions for this conversation\n${input.customSystemPrompt.trim()}`);
  }

  if (input.customInstructions.trim()) {
    sections.push(`# User preferences\n${input.customInstructions.trim()}`);
  }

  sections.push(STYLE_RULES);

  return sections.join("\n\n");
}

/**
 * The "never ask clarifying questions" instruction.
 *
 * A separate section rather than another bullet inside the mode's, because it
 * cuts across modes: it says nothing about Code's codebase or Cowork's browser,
 * only about what the model does with a request it cannot fully resolve.
 *
 * The last line is the part that matters. A user who turns this on is asking for
 * fewer interruptions, and the easy way to deliver that is to start waving
 * through the prompts -- which trades a small annoyance for the one thing the
 * approval prompt exists to prevent. Naming the boundary keeps this switch from
 * quietly becoming an auto-approve switch.
 */
const NO_QUESTIONS_GUIDANCE = [
  "## Never ask clarifying questions",
  "- Make your own call on anything ambiguous and keep going. State the assumption you made and carry on; do not stop to ask.",
  "- If a task genuinely cannot be started without an answer, do the part that is unblocked and name what you skipped.",
  "- This applies to questions in your replies. It does not apply to permission prompts: anything requiring approval still asks.",
].join("\n");

function pathRulesFor(platform: PlatformInfo, workspace: string | null): string {
  const lines: string[] = [];
  if (platform.os === "windows") {
    lines.push(
      "- Use backslashes in paths, e.g. `C:\\Users\\name\\project`. Forward slashes mostly work but backslashes are correct.",
      "- Drive letters are case-insensitive. Do not assume a path is case-sensitive.",
      "- Do not use POSIX-only utilities (`ls`, `cat`, `grep`, `sed`, `chmod`). Use their PowerShell or Windows equivalents (`Get-ChildItem`, `Get-Content`, `Select-String`, `Set-Content`).",
      "- Prefer PowerShell 7 (`pwsh`) syntax. Avoid `cmd`-only constructs like `set VAR=`.",
    );
  } else {
    lines.push(
      "- Use forward slashes. Paths are case-sensitive on this filesystem, so `README.md` and `readme.md` are different files.",
      "- Standard Unix tools are available: `ls`, `cat`, `grep`, `sed`, `awk`, `find`, `xargs`.",
      "- Quote paths that may contain spaces.",
    );
  }
  if (platform.os === "macos") {
    lines.push("- The default filesystem is case-insensitive (APFS) unless the volume is formatted as case-sensitive.");
    lines.push("- Prefer `brew` for installing tools.");
  }
  if (platform.os === "linux") {
    lines.push("- Prefer your distribution's package manager (`apt`, `dnf`, `pacman`, `apk`) for installing tools; do not assume `sudo` is available.");
  }
  lines.push(
    `- Line endings: this platform defaults to ${platform.crlfByDefault ? "CRLF" : "LF"}. When creating a file, match the line endings already used in that file rather than imposing your own.`,
  );
  if (workspace) lines.push(`- Paths in tool calls may be relative to \`${workspace}\` or absolute.`);
  return lines.join("\n");
}

function modeGuidance(
  mode: Mode,
  planOnly: boolean,
  hasWorkspace: boolean,
  browserTools: readonly string[],
): string {
  if (planOnly) {
    return [
      "You are in **plan mode**. Investigate and propose, but do not modify anything.",
      "- Use only read-only tools.",
      "- Explore the codebase enough to be certain about your plan.",
      "- Finish with a numbered, concrete plan the user can approve. Do not write code yet.",
    ].join("\n");
  }

  switch (mode) {
    case "code":
      return [
        "You are in **Code mode**, working inside a project directory.",
        "- Read before you write. Match the existing style, naming, and structure of the codebase.",
        "- Prefer small, targeted edits over rewriting files.",
        "- Use the todo tool to track multi-step work and keep it current as you go.",
        "- Run the project's tests or type checks after making changes, and report failures honestly.",
        "- When a task is ambiguous, state your assumption briefly and continue rather than stopping.",
      ].join("\n");
    case "cowork": {
      // Built as a list rather than a literal because one of these lines is only
      // true when a browser tool exists. It used to be unconditional, so the one
      // mode built around capabilities was the one mode lying about having them:
      // the model was told to prefer a browser and to screenshot pages, with
      // nothing to do either, and every answer that touched the web was a
      // confident guess.
      const lines = [
        browserTools.length > 0
          ? "You are in **Cowork mode**, operating a web browser and the local filesystem on the user's behalf."
          : "You are in **Cowork mode**, working with the local filesystem on the user's behalf.",
        "- Plan briefly, then execute. Work in observable steps so the user can follow along.",
      ];
      if (browserTools.length > 0) {
        lines.push(
          "- Prefer the browser over guessing: verify by navigating, reading the page, and screenshotting when layout matters.",
        );
      } else {
        lines.push(
          "- You have no browser in this session. If the task needs one, say that plainly and stop short of guessing at what a page would contain. Report what you verified from files and commands, and what you could not check.",
        );
      }
      lines.push(
        "- Never enter credentials or submit payments without an explicit instruction to do so.",
        "- Summarise what you did at the end, including anything that failed.",
      );
      return lines.join("\n");
    }
    case "chat":
    default:
      return [
        "You are in **Chat mode**.",
        // Stated as an absence rather than left implied. A prompt that only
        // says "no tool use unless asked" leaves two failure modes, both of
        // which the user has to unpick: the model offers to open a file it
        // cannot open, or it answers as though it already ran the command.
        "- You have no tools in this mode. You cannot read or write files, run shell commands, or open a browser. Never say or imply that you did, and never present a command as if its output were known.",
        hasWorkspace
          ? "- If the user asks for file or shell work, say in one sentence that this is Chat mode and it has no tools, and point them to Code mode in this same workspace."
          : "- If the user asks for file or shell work, say in one sentence that this is Chat mode and it has no tools, and point them to Code mode with a project folder selected.",
        "- Answer directly, from what the user has told you and what you know. If an answer depends on a file or a command you cannot run, say what you would need.",
        "- Format code as fenced blocks with a language tag. Use LaTeX (`$...$` inline, `$$...$$` display) for math.",
      ].join("\n");
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const STYLE_RULES = [
  "# How to respond",
  "- Lead with the answer. No preamble, no restating the question.",
  "- Use Markdown: headings for long answers, lists for steps, tables for comparisons.",
  "- Fence code blocks with a language tag so they can be copied and syntax-highlighted.",
  "- Do not apologise for errors. Fix them and move on.",
  "- If you do not know something, say so plainly rather than guessing.",
].join("\n");

/** Short title generator: first user message, truncated sensibly. */
export function deriveTitle(text: string, maxLength = 60): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  const cleaned = firstLine.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned || "New chat";
  const cut = cleaned.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
