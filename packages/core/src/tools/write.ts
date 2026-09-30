/**
 * The write tools: `write_file` and `edit_file`.
 *
 * `edit_file` is the one that matters. A model that rewrites a whole file to
 * change three lines will reformat everything it did not understand, and the
 * user ends up reviewing a 400-line diff for a one-word fix. So `edit_file`
 * requires the exact text to be present and unique, and refuses otherwise. That
 * strictness is the feature: it converts "I think this is the right place" into
 * a fact the tool verified.
 */

import { authorizedRoots } from "../settings/roots.js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import type { CheckpointPort, FileSystemPort } from "../host/ports.js";
import type { Settings } from "../settings/schema.js";

/**
 * Every folder this conversation may read or write, in the order they should be
 * tried: the open workspace first, then the folders the user added in Settings.
 *
 * Having no workspace is not automatically fatal. A user who has added a folder
 * and has no project open can still work in that folder, and refusing here would
 * make Settings look broken -- the folder is listed, it is authorized, and the
 * only reason it is unreachable is that some *other* folder happens to be closed.
 *
 * The message for the genuinely empty case names the fix, because "no folder
 * open" on its own is a dead end for a model that has no way to open one.
 */
function requireRoots(context: ToolContext): readonly string[] {
  const roots = authorizedRoots(context.workspace, context.extraRoots());
  if (roots.length === 0) {
    throw new Error(
      "This conversation has no folder open, and no folders have been allowed. " +
        "Ask the user to open a project folder, or to add one under Settings > Files.",
    );
  }
  return roots;
}

const WriteArgs = z.object({
  path: z
    .string()
    .min(1)
    .describe("Path to the file. Relative to the open folder, or absolute inside it. Parent folders are created."),
  content: z.string().describe("The full new contents of the file."),
});

const EditArgs = z.object({
  path: z
    .string()
    .min(1)
    .describe("Path of the file to edit. Relative to the open folder, or absolute inside it."),
  old_string: z
    .string()
    .min(1)
    .describe("The exact text to replace, including indentation. Must appear exactly once."),
  new_string: z.string().describe("The replacement text."),
  replace_all: z.boolean().default(false).describe("Replace every occurrence instead of requiring exactly one."),
});

/** How many lines of context to show around a change. */
const CONTEXT_LINES = 3;

/**
 * How the write tools are given the ability to checkpoint.
 *
 * `settings` is a getter, not a value, because the permission level and the
 * checkpoint switch are both changeable while the app is open and the tools are
 * built once. Passing a snapshot of the settings would mean a user who turns
 * checkpoints off still gets them for the rest of the session.
 */
export interface CheckpointDeps {
  readonly checkpoints: CheckpointPort | null;
  readonly settings: () => Settings;
}

export function createWriteTools(fs: FileSystemPort, checkpointDeps?: CheckpointDeps): Tool<any>[] {
  /**
   * Record a file's current contents before a write replaces them.
   *
   * Best-effort by design. A failed checkpoint must not block the write the
   * model asked for: the user is watching a run, and a full disk is not a reason
   * to deadlock them with a tool error. The alternative -- refusing the write --
   * would make the app unusable rather than merely less safe, and the run is
   * still undoable in the ways that matter (git, or the visible diff).
   *
   * Returns the warning to show, or `null` when the file is safely backed up.
   * The return is a string rather than a boolean on purpose: a bare flag
   * collapses "no backup needed" and "the backup failed" into the same value,
   * and only one of those is something the user must be shown.
   */
  async function capture(context: ToolContext, roots: readonly string[], path: string): Promise<string | null> {
    const deps = checkpointDeps;
    if (!deps?.checkpoints || deps.settings().checkpointsEnabled !== true) return null;
    const existed = await fs
      .readFile(roots, path)
      .then((file) => ({ existed: true, before: file.content }))
      .catch(() => ({ existed: false, before: "" }));
    try {
      await deps.checkpoints.save({
        conversationId: context.conversationId,
        runId: context.runId,
        path,
        existed: existed.existed,
        before: existed.before,
      });
      return null;
    } catch (error) {
      // The reason is included because a silent warning is one nobody can act
      // on: "no space" and "permission denied" call for completely different
      // fixes, and the user is the only one who can make either.
      const reason = error instanceof Error ? error.message : String(error);
      return `Couldn't back up ${path}; /undo won't restore it (${reason})`;
    }
  }
  const writeFile: Tool<z.infer<typeof WriteArgs>> = {
    name: "write_file",
    description:
      "Create a file or replace its entire contents. Use this for new files. For changing an existing file, prefer edit_file so the change stays minimal and reviewable.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file. Relative to the open folder, or absolute inside it.",
        },
        content: { type: "string", description: "Full new contents." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    categories: ["file-write"],
    modes: ["code", "cowork"],
    parse: (args) => WriteArgs.parse(args),
    async execute(args, context): Promise<ToolResult> {
      const roots = requireRoots(context);
      const existing = await fs
        .readFile(roots, args.path, { limit: 1 })
        .then(() => true)
        .catch(() => false);
      const backupWarning = await capture(context, roots, args.path);
      const entry = await fs.writeFile(roots, args.path, args.content);
      const verb = existing ? "Replaced" : "Created";
      return {
        content:
          `${verb} ${entry.path} (${entry.size} bytes).` +
          (backupWarning ? `\n\nWarning: ${backupWarning}` : ""),
        display: {
          kind: "file-write",
          path: entry.path,
          bytes: entry.size,
          created: !existing,
          ...(backupWarning ? { warning: backupWarning } : {}),
        },
      };
    },
  };

  const editFile: Tool<z.infer<typeof EditArgs>> = {
    name: "edit_file",
    description:
      "Replace an exact snippet of an existing file. The old text must appear exactly once unless replace_all is set, so include enough surrounding lines to be unambiguous. Returns the surrounding lines so you can see the result.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file. Relative to the open folder, or absolute inside it.",
        },
        old_string: { type: "string", description: "Exact text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    categories: ["file-write"],
    modes: ["code", "cowork"],
    parse: (args) => EditArgs.parse(args),
    async execute(args, context): Promise<ToolResult> {
      const roots = requireRoots(context);
      const current = await fs.readFile(roots, args.path);
      if (current.truncated) {
        throw new Error(
          `${args.path} is too large to edit safely (${current.totalLines} lines). Use write_file with the full contents, or edit a smaller file.`,
        );
      }

      const occurrences = countOccurrences(current.content, args.old_string);
      if (occurrences === 0) {
        // The most common failure by far. Returning the file's actual text is
        // what lets the model correct itself instead of retrying blind.
        throw new Error(
          `The text to replace was not found in ${args.path}. It must match exactly, including indentation and line endings. Read the file again and copy the exact lines.`,
        );
      }
      if (occurrences > 1 && !args.replace_all) {
        throw new Error(
          `The text to replace appears ${occurrences} times in ${args.path}. Include more surrounding lines to make it unique, or set replace_all to true.`,
        );
      }

      const updated = args.replace_all
        ? current.content.split(args.old_string).join(args.new_string)
        : current.content.replace(args.old_string, args.new_string);

      const backupWarning = await capture(context, roots, args.path);
      await fs.writeFile(roots, args.path, updated);
      const replaced = args.replace_all ? occurrences : 1;

      return {
        content:
          `Edited ${args.path} (${replaced} replacement${replaced === 1 ? "" : "s"}).` +
          contextDiff(current.content, updated, args.path) +
          (backupWarning ? `\n\nWarning: ${backupWarning}` : ""),
        display: {
          kind: "file-edit",
          path: args.path,
          before: current.content,
          after: updated,
          occurrences: replaced,
          ...(backupWarning ? { warning: backupWarning } : {}),
        },
      };
    },
  };

  return [writeFile, editFile];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * A minimal unified diff of just the changed region.
 *
 * Not a real diff algorithm: it locates the edit by comparing line counts and
 * shows the neighbourhood. It exists so the model can see the change in the tool
 * result without a second read, and so the UI has something to render. The
 * checkpoint store keeps the real previous contents for actual restore.
 */
export function contextDiff(before: string, after: string, path: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const firstDiff = firstDifferentLine(beforeLines, afterLines);
  const start = Math.max(0, firstDiff - CONTEXT_LINES);

  const removed = Math.max(0, beforeLines.length - afterLines.length);
  const added = afterLines.length - beforeLines.length;
  const from = start + 1;
  const to = Math.min(afterLines.length, start + 1 + afterLines.slice(start).length);

  const out: string[] = ["", `--- ${path}`, `+++ ${path}`, `@@ ${from},${removed} → ${from},${added} @@`];
  for (const line of afterLines.slice(start, start + 12)) out.push(`  ${line}`);
  if (afterLines.length > start + 12) out.push("  …");

  return out.join("\n");
}

function firstDifferentLine(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit; index++) {
    if (a[index] !== b[index]) return index;
  }
  return limit;
}
