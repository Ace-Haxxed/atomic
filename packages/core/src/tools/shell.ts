/**
 * The shell tool.
 *
 * This is the most dangerous tool in the app, and the safety does not live here.
 * By the time `bash` runs, the permission gate has already decided whether it
 * may, and the host has already bounded the process. What this file is
 * responsible for is being a good neighbour to the model: report the exit code,
 * separate stdout from stderr, and never swallow a failure into a string that
 * reads like success.
 *
 * In particular, a non-zero exit is returned as an *error* result. A model that
 * sees `exit 1` in prose will often try again; a model that sees a clean result
 * will carry on and build the next step on a failure.
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import type { ProcessPort } from "../host/ports.js";

const BashArgs = z.object({
  // Trimmed before the length check, so a whitespace-only command is refused
  // as the obvious mistake it is rather than being run as a silent no-op.
  command: z
    .string()
    .trim()
    .min(1)
    .describe("The shell command to run, in the workspace root."),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe("Kill the command after this many milliseconds. Defaults to two minutes."),
});

export function createShellTool(process: ProcessPort): Tool<any>[] {
  const bash: Tool<z.infer<typeof BashArgs>> = {
    name: "bash",
    description:
      "Run a shell command in the workspace root. Use it for builds, tests, linters, and git. Prefer the specific tools (read_file, glob, grep) over cat, ls and find — they are faster and their output is bounded. The command runs through bash on macOS and Linux, PowerShell on Windows.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        timeout_ms: { type: "integer", description: "Timeout in milliseconds." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    // `bash` covers every effect a command can have, so it always triggers a
    // prompt in ask mode. There is no narrower category that would be honest:
    // `git status` and `rm -rf` arrive through the same door.
    categories: ["bash"],
    modes: ["code", "cowork"],
    parse: (args) => BashArgs.parse(args),
    async execute(args, context): Promise<ToolResult> {
      if (!context.workspace) {
        throw new Error("This conversation has no folder open. Ask the user to open a project folder first.");
      }
      const result = await process.run(context.workspace, args.command, {
        ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
      });

      const sections: string[] = [];
      if (result.stdout.trim()) sections.push(result.stdout.trimEnd());
      if (result.stderr.trim()) sections.push(`stderr:\n${result.stderr.trimEnd()}`);

      const status = [
        `exit code ${result.exitCode}`,
        `${(result.durationMs / 1000).toFixed(1)}s`,
        result.truncated ? "output truncated" : null,
      ]
        .filter(Boolean)
        .join(", ");

      const body = sections.length > 0 ? sections.join("\n\n") : "(no output)";

      if (result.timedOut) {
        return {
          content: `The command was killed after ${args.timeout_ms ?? 120_000}ms.\n\n${body}`,
          isError: true,
          display: { kind: "bash", command: args.command, ...result },
        };
      }
      if (result.exitCode !== 0) {
        return {
          content: `The command failed (${status}).\n\n${body}`,
          isError: true,
          display: { kind: "bash", command: args.command, ...result },
        };
      }
      return {
        content: `${body}\n\n(${status})`,
        display: { kind: "bash", command: args.command, ...result },
      };
    },
  };

  return [bash];
}
