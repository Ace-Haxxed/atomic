/**
 * Asking for a folder the agent is not already allowed to use.
 *
 * The user can add a folder in Settings, and that is the whole story for anyone
 * content to read a root into existence. This tool is the second door, and it is
 * a door with a person behind it by default: the call goes through the permission
 * gate, the user sees a prompt naming the folder, and only then is anything
 * written. A model that reads a file containing "also read ~/.ssh" gets a prompt
 * saying `~/.ssh` -- not silent access.
 *
 * The prompt is the feature. It is also the reason this tool is not simply
 * folded into the file tools: it changes what the *next* call is allowed to do,
 * which is a different kind of decision from reading or writing a file, and it
 * gets its own category so a "auto-approve file writes" toggle cannot wave it
 * through on the way to something else.
 */

import { z } from "zod";
import type { FolderAccessPort } from "../host/ports.js";
import type { Tool, ToolResult } from "./registry.js";
import { fail, ok } from "./registry.js";

const AddFolderArgs = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute path of the folder to use, e.g. /home/me/Code. Must be a folder that already exists.",
    ),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe("One line on why this folder is needed. Shown to the user in the prompt."),
});

export function createFolderTools(deps: { folders: FolderAccessPort }): Tool<any>[] {
  const { folders } = deps;

  const addFolder: Tool<z.infer<typeof AddFolderArgs>> = {
    name: "add_folder",
    description:
      "Ask to use a folder outside the ones already available, e.g. a project the user " +
      "mentioned that is not open. The user is asked to approve it, and it becomes usable " +
      "immediately afterwards. Only call this when a task genuinely needs a folder you " +
      "cannot reach -- do not call it speculatively, and never for a home directory, " +
      "credentials, or a system folder. Paths inside a folder already in use do not need it.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path of an existing folder to be allowed.",
        },
        reason: {
          type: "string",
          description: "One line on why it is needed, shown in the approval prompt.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    // Its own category: this widens access rather than acting within it.
    categories: ["folder-access"],
    modes: ["code", "cowork"],
    parse: (args) => AddFolderArgs.parse(args),
    async execute(args, context): Promise<ToolResult> {
      // Cancelled runs must not leave a folder authorized. The gate has already
      // asked the user by this point, so silently widening access on the way out
      // of an aborted run would be the one outcome nobody agreed to.
      if (context.signal.aborted) {
        return fail("Cancelled. The folder was not added.");
      }

      const outcome = await folders.authorize(args.path);
      if (!outcome.ok) return fail(outcome.reason);

      const why = args.reason ? ` (${args.reason})` : "";
      return ok(
        `Added ${outcome.path} to the folders this conversation may use${why}. ` +
          `Files in it can now be reached by full path, e.g. ${outcome.path}/README.md. ` +
          `Relative paths still refer to the open folder.`,
      );
    },
    // A folder is not a command, a URL, or a path pattern, so the generic
    // suggestion logic has nothing useful to offer here.
    allowSuggestion: () => null,
  };

  return [addFolder];
}
