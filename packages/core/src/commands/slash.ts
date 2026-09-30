/**
 * Slash commands.
 *
 * Parsing and the descriptions live here rather than in the composer, so the
 * behaviour can be tested without a DOM and so the command list has one source
 * of truth. The composer's only job is to notice a leading `/` and show the menu.
 *
 * A command is only a command when it is the *whole* message. `/help` inside a
 * sentence ("try /help first") is text the user wants sent, and silently turning
 * it into a command would lose what they typed.
 */

export interface SlashCommand {
  readonly name: string;
  /** One line, shown in the menu. */
  readonly summary: string;
  /** Longer form, shown in the menu when there is room. */
  readonly detail?: string;
  /** Words that match this command in the menu. */
  readonly keywords?: readonly string[];
  /** The mode this command belongs to, or null when it is always available. */
  readonly mode: "chat" | "code" | "cowork" | null;
  /** Destructive, so the menu can warn and confirmation can be required. */
  readonly destructive?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "help",
    summary: "List what you can do here",
    detail: "Shows the available commands and what the current mode will do.",
    keywords: ["commands", "?"],
    mode: null,
  },
  {
    name: "clear",
    summary: "Start a fresh conversation",
    detail: "Begins a new chat in the same folder. The old one is kept.",
    keywords: ["new", "reset", "restart"],
    mode: null,
  },
  {
    name: "compact",
    summary: "Summarise this conversation and free up context",
    detail: "Replaces the older turns with a summary so a long chat can keep going.",
    keywords: ["summarise", "summarize", "context", "shorten", "token"],
    mode: null,
    // Compaction is lossy and cannot be undone: the replaced turns are gone
    // from the context, not just from the view.
    destructive: true,
  },
  {
    name: "model",
    summary: "Switch model, or go back to Auto",
    detail: "Auto picks the best free model for the job. An explicit choice is never replaced.",
    keywords: ["models", "auto"],
    mode: null,
  },
  {
    name: "plan",
    summary: "Read-only pass: investigate, then stop with a plan",
    detail: "The agent reads and searches but cannot change anything until you approve the plan.",
    keywords: ["planning", "read-only", "readonly", "readonly"],
    mode: "code",
  },
  {
    name: "undo",
    summary: "Put back the files a previous run changed",
    detail: "Restores the contents from before that run. The conversation stays as it is.",
    keywords: ["revert", "rollback", "restore", "checkpoint"],
    mode: "code",
    destructive: true,
  },
  {
    name: "diff",
    summary: "Show what this run changed",
    detail: "Every file the last run wrote or edited, as the same diff you approved.",
    keywords: ["changes", "review", "changed", "what did you do"],
    mode: "code",
  },
  {
    name: "checkpoints",
    summary: "List the runs you can undo",
    detail: "Every run that changed a file, newest first, with the files it touched.",
    keywords: ["history", "undo", "runs", "backups"],
    mode: "code",
  },
];

export interface ParsedInput {
  /** Set when the whole message is a command. */
  readonly command: SlashCommand | null;
  /** The rest of the line after the command name. */
  readonly argument: string;
  /** Always the original text, for sending or clearing. */
  readonly text: string;
  /** True when the message begins with `/`, whether or not it parsed. */
  readonly looksLikeCommand: boolean;
}

/**
 * Parse a composed message.
 *
 * A message with more than one token after the slash is not a command. `mode` is
 * only used to report `available: false` for a command that exists but does not
 * apply here; the caller decides what to do about that.
 */
export function parseSlash(
  input: string,
  mode: string,
): {
  parsed: ParsedInput;
  /** Set when the text named a real command that `mode` does not offer. */
  unavailable: SlashCommand | null;
  /** Set when the text started with `/` but named nothing. */
  unknown: string | null;
} {
  const text = input;
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) {
    return { parsed: { command: null, argument: "", text, looksLikeCommand: false }, unavailable: null, unknown: null };
  }

  const body = trimmed.slice(1);
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) {
    return { parsed: { command: null, argument: "", text, looksLikeCommand: true }, unavailable: null, unknown: null };
  }

  const name = match[1] ?? "";
  const argument = match[2] ?? "";
  const found = SLASH_COMMANDS.find((command) => command.name === name);
  if (found === undefined) {
    return { parsed: { command: null, argument: "", text, looksLikeCommand: true }, unavailable: null, unknown: name };
  }
  if (found.mode !== null && found.mode !== mode) {
    return {
      parsed: { command: null, argument: "", text, looksLikeCommand: true },
      unavailable: found,
      unknown: null,
    };
  }
  return {
    parsed: { command: found, argument: argument.trim(), text, looksLikeCommand: true },
    unavailable: null,
    unknown: null,
  };
}

/**
 * Resolve a typed `/name argument` line to the command it names.
 *
 * This is what the composer calls on submit, and it is separate from
 * `parseSlash` because the two answer different questions: `parseSlash` reports
 * what the user *meant* even when it is not a command, while this returns a
 * command only on an exact name match. A prefix must come from the menu -- if
 * `/hel` silently ran `/help`, a typo would execute something.
 */
export function resolveCommandLine(
  value: string,
  mode: string,
): { command: SlashCommand; argument: string } | null {
  const text = value.trim();
  if (!text.startsWith("/")) return null;
  const [head, ...rest] = text.slice(1).split(/\s+/);
  const name = (head ?? "").toLowerCase();
  if (name === "") return null;
  const found = commandsFor(mode).find((command) => command.name === name);
  return found === undefined ? null : { command: found, argument: rest.join(" ") };
}

/** Commands offered in a mode, for the menu. */
export function commandsFor(mode: string): readonly SlashCommand[] {
  return SLASH_COMMANDS.filter((command) => command.mode === null || command.mode === mode);
}

/**
 * Menu entries for what has been typed so far.
 *
 * Matches on name, summary and keywords, so `/undo` can be found by typing
 * `revert`. An empty query lists everything, which is what makes `/help` a way
 * to discover the commands rather than something you have to already know.
 */
export function matchCommands(
  query: string,
  mode: string,
  limit = 8,
): readonly SlashCommand[] {
  const needle = query.replace(/^\//, "").trim().toLowerCase();
  const available = commandsFor(mode);
  if (needle === "") return available.slice(0, limit);

  const scored = available
    .map((command) => {
      const name = command.name.toLowerCase();
      if (name.startsWith(needle)) return { command, rank: 0 };
      if (name.includes(needle)) return { command, rank: 1 };
      // Both directions: the keyword "token" should be found by typing
      // "tokens", and a keyword longer than the query should still match.
      if (command.keywords?.some((word) => word.includes(needle) || needle.includes(word))) {
        return { command, rank: 2 };
      }
      if (command.summary.toLowerCase().includes(needle)) return { command, rank: 3 };
      return { command, rank: -1 };
    })
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.command.name.localeCompare(b.command.name));

  return scored.slice(0, limit).map((entry) => entry.command);
}

/** The help text `/help` prints, so the same list is never described twice. */
export function helpText(mode: string): string {
  const lines = ["Available commands:"];
  for (const command of commandsFor(mode)) {
    lines.push(`/${command.name} — ${command.summary}`);
  }
  lines.push("", "Type / on an empty message to see them.");
  return lines.join("\n");
}
