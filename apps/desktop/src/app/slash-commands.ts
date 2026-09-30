/**
 * What each slash command actually does.
 *
 * Kept out of the composer so the composer's only job is deciding that a message
 * is a command. Every branch here is written to be safe to run from a menu
 * click: nothing acts on a half-typed argument, and the ones that change
 * something report what they changed so the note can say it out loud.
 */

import type { HostApi, Mode, Settings, SlashCommand } from "@atomic/core";
import { helpText } from "@atomic/core";

/**
 * What a command did.
 *
 * A string note is not enough: `/diff` has to render the same card the
 * transcript shows, and a custom command has to send a message. One return type
 * with three optional fields keeps the composer from having to know which kind
 * of command it just ran.
 */
/** One entry of a command's card output, in the shape the tool card needs. */
export interface SlashCard {
  readonly toolName: string;
  readonly display: unknown;
}

export interface SlashResult {
  /** Shown as a local message. */
  readonly note?: string;
  /** Display payloads rendered with the tool card, oldest first. */
  readonly cards?: readonly SlashCard[];
  /** Sent to the model as an ordinary message. */
  readonly send?: string;
}

export interface CommandContext {
  readonly api: HostApi;
  readonly mode: Mode;
  readonly settings: Settings;
  /** Null when no conversation is open. */
  readonly conversationId: string | null;
  /** Starts a fresh conversation in the current folder. */
  readonly newChat: () => Promise<void>;
  /** Applies a model id. */
  readonly setModel: (id: string) => Promise<void>;
  /** Turns a level on, used by `/plan`. */
  readonly setLevel: (level: Settings["permissions"][Mode]["level"]) => Promise<void>;
  /** Reports a problem back to the user instead of throwing. */
  readonly fail: (message: string) => void;
}

/** Caveat that belongs on anything offering to put files back. */
const RESTORE_SCOPE =
  "Covers changes made with the file tools only. Anything a command did to your files " +
  "(a formatter, a codemod, a `git checkout`) is not in here and will not be restored.";

/**
 * Returns the text to show as a local note, or null when the command did its
 * work through the API or the UI already reflected it.
 */
export async function runSlashCommand(
  command: SlashCommand,
  argument: string,
  context: CommandContext,
): Promise<SlashResult | null> {
  const { api } = context;

  switch (command.name) {
    case "help":
      return { note: helpText(context.mode) };

    case "clear": {
      await context.newChat();
      return null;
    }

    case "diff": {
      if (context.conversationId === null) {
        return { note: "There is no run to show yet." };
      }
      const latest = await api.latestRunChanges(context.conversationId);
      if (latest === null) {
        return { note: "No run has finished in this conversation yet." };
      }
      if (latest.changes.length === 0) {
        return { note: "The last run did not write or edit any files." };
      }
      // `toolName` is nullable in storage. A card with no tool to name it is
      // still a change the user asked to see, so it falls back to a label the
      // card can render rather than being dropped silently.
      return {
        cards: latest.changes.map((change) => ({
          toolName: change.toolName ?? "edit_file",
          display: change.display,
        })),
      };
    }

    case "model": {
      if (argument === "") {
        // There is no way to focus the inline picker from here, and pretending
        // otherwise would leave the user staring at an unchanged screen.
        return { note: "Use the model menu in the header. /model auto goes back to automatic selection." };
      }
      const isAuto = argument.toLowerCase() === "auto";
      await context.setModel(isAuto ? "" : argument);
      return {
        note: isAuto ? "Back to automatic model selection." : `Model set to ${argument}.`,
      };
    }

    case "plan": {
      await context.setLevel("plan");
      return { note: "Plan mode on. The agent will read and search, then stop with a plan it cannot act on until you approve it." };
    }

    case "compact": {
      if (context.conversationId === null) return { note: "There is no conversation to compact yet." };
      const result = await api.compactConversation(context.conversationId);
      if (result.removed === 0) {
        return { note: "Nothing to compact yet, or the last few messages are the whole conversation." };
      }
      return { note: `Compacted ${result.removed} earlier message${result.removed === 1 ? "" : "s"} into a summary. The full transcript is still here if you scroll back.` };
    }

    case "checkpoints": {
      if (context.conversationId === null) return { note: "There is no conversation with a history yet." };
      const runs = await api.listCheckpoints(context.conversationId);
      if (runs.length === 0) {
        return { note: "No runs have changed files in this conversation yet." };
      }
      return {
        note: [
          "Runs you can undo, newest first:",
          ...runs.map((run, index) => {
            const files = run.files.map((file) => file.path).join(", ");
            return `${index + 1}. ${run.files.length} file${run.files.length === 1 ? "" : "s"} — ${files}`;
          }),
          "",
          RESTORE_SCOPE,
          "",
          "Use /undo to put the most recent one back.",
        ].join("\n"),
      };
    }

    case "undo": {
      if (context.conversationId === null) return { note: "There is no conversation to undo in." };
      const runs = await api.listCheckpoints(context.conversationId);
      if (runs.length === 0) {
        return { note: "No runs have changed files in this conversation, so there is nothing to undo." };
      }
      const target = argument === "" ? runs[0] : runs.find((run) => run.runId === argument);
      if (!target) {
        context.fail(`No run called "${argument}". Run /checkpoints to see what can be undone.`);
        return null;
      }
      const restored = await api.restoreCheckpoint({
        conversationId: context.conversationId,
        runId: target.runId,
      });
      return {
        note: `Put back ${restored.length} file${restored.length === 1 ? "" : "s"}: ${restored.join(", ")}\n\n${RESTORE_SCOPE}`,
      };
    }

    default:
      return { note: `/${command.name} is not wired up yet.` };
  }
}
