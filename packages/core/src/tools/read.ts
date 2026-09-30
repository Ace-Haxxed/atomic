/**
 * The read tools: `read_file`, `list_files`, `glob`, `grep`.
 *
 * These are the four the model reaches for first, and the four that have to be
 * cheap, because every other tool depends on them finding the right file. The
 * design rule throughout: return what was asked for, and when a result was cut
 * off, say so in the text the model reads. A silently truncated list teaches a
 * model to guess, and a model that guesses edits the wrong file.
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import type { FileSystemPort } from "../host/ports.js";

/**
 * Refuse early when the mode has no workspace, with a message the model can act
 * on. Every file tool needs this and none should invent its own wording.
 */
function requireWorkspace(context: ToolContext): string {
  if (!context.workspace) {
    throw new Error("This conversation has no folder open. Ask the user to open a project folder first.");
  }
  return context.workspace;
}

const ReadArgs = z.object({
  path: z.string().min(1).describe("Workspace-relative path, e.g. src/app.ts"),
  offset: z.number().int().min(1).optional().describe("1-based first line to return."),
  limit: z.number().int().min(1).max(2000).optional().describe("How many lines to return."),
});

const ListArgs = z.object({
  path: z.string().min(1).default(".").describe("Workspace-relative directory. Defaults to the root."),
});

const GlobArgs = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Glob such as "src/**/*.ts" or "*.{ts,tsx}". A bare pattern matches any directory.'),
});

const GrepArgs = z.object({
  pattern: z.string().min(1).describe("Regular expression to search for."),
  glob: z.string().min(1).optional().describe("Only search files matching this glob."),
  case_sensitive: z.boolean().default(false),
  max_matches: z.number().int().min(1).max(400).default(200),
});

export function createReadTools(fs: FileSystemPort): Tool<any>[] {
  const readFile: Tool<z.infer<typeof ReadArgs>> = {
    name: "read_file",
    description:
      "Read a text file from the workspace. Returns numbered-line-friendly content, or a slice when the file is long. Supports an offset and limit to page through a large file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
        offset: { type: "integer", description: "1-based first line to return." },
        limit: { type: "integer", description: "How many lines to return." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    categories: ["file-read"],
    modes: ["code", "cowork"],
    parse: (args) => ReadArgs.parse(args),
    async execute(args, context): Promise<ToolResult> {
      const root = requireWorkspace(context);
      const result = await fs.readFile(root, args.path, {
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });

      const header =
        result.startLine === 1 && result.endLine >= result.totalLines
          ? `${result.path} (${result.totalLines} lines)`
          : `${result.path} lines ${result.startLine}-${result.endLine} of ${result.totalLines}`;
      const footer = result.truncated
        ? `\n\n… ${result.omittedBytes} bytes not shown. Continue with offset ${result.endLine + 1}, or use grep to find the part you need.`
        : "";

      return { content: `${header}\n${result.content}${footer}` };
    },
  };

  const listFiles: Tool<z.infer<typeof ListArgs>> = {
    name: "list_files",
    description:
      "List the files and folders in a directory. Directories come first. Generated folders such as node_modules and .git are left out.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Workspace-relative directory. Use "." for the root.' },
      },
      additionalProperties: false,
    },
    categories: ["file-read"],
    modes: ["code", "cowork"],
    parse: (args) => ListArgs.parse(args),
    async execute(args, context): Promise<ToolResult> {
      const root = requireWorkspace(context);
      const { entries, truncated } = await fs.listDirectory(root, args.path);
      if (entries.length === 0) return { content: `${args.path} is empty.` };
      const lines = entries.map((entry) =>
        entry.isDir ? `${entry.path}/` : `${entry.path}  (${entry.size} bytes)`,
      );
      return {
        content: `${lines.join("\n")}${truncated ? "\n\n… more entries were not shown." : ""}`,
      };
    },
  };

  const glob: Tool<z.infer<typeof GlobArgs>> = {
    name: "glob",
    description:
      'Find files by name pattern. Use this to locate a file when you know how it ends but not where it lives, e.g. pattern "**/*.test.ts".',
    parameters: {
      type: "object",
      properties: { pattern: { type: "string", description: "Glob pattern." } },
      required: ["pattern"],
      additionalProperties: false,
    },
    categories: ["file-read"],
    modes: ["code", "cowork"],
    parse: (args) => GlobArgs.parse(args),
    async execute(args, context): Promise<ToolResult> {
      const root = requireWorkspace(context);
      const matches = await fs.glob(root, args.pattern);
      if (matches.length === 0) {
        // Naming the pattern back makes a typo obvious; "no results" alone
        // reads identically to a genuinely absent file.
        return { content: `No files match ${args.pattern}.` };
      }
      return { content: matches.join("\n") };
    },
  };

  const grepTool: Tool<z.infer<typeof GrepArgs>> = {
    name: "grep",
    description:
      "Search file contents with a regular expression. Returns matching lines with their file and line number. Skips binary and generated files, and respects .gitignore.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression." },
        glob: { type: "string", description: "Only search files matching this glob." },
        case_sensitive: { type: "boolean", description: "Match case exactly. Defaults to false." },
        max_matches: { type: "integer", description: "Stop after this many matches." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    categories: ["file-read"],
    modes: ["code", "cowork"],
    parse: (args) => GrepArgs.parse(args),
    async execute(args, context): Promise<ToolResult> {
      const root = requireWorkspace(context);
      const result = await fs.grep(root, args.pattern, {
        caseSensitive: args.case_sensitive,
        ...(args.glob ? { glob: args.glob } : {}),
        maxMatches: args.max_matches,
      });

      if (result.matches.length === 0) {
        // `filesSearched` is what separates "nothing matches" from "nothing was
        // looked at", which are very different and look identical otherwise.
        return {
          content:
            result.filesSearched === 0
              ? `Nothing was searched. No text files matched, or everything was skipped.`
              : `No matches for ${args.pattern} in ${result.filesSearched} file(s).`,
        };
      }
      const lines = result.matches.map((match) => `${match.path}:${match.line}: ${match.text}`);
      const footer = result.truncated
        ? `\n\n… more matches exist. Narrow the pattern, add a glob, or raise max_matches.`
        : "";
      return { content: lines.join("\n") + footer };
    },
  };

  return [readFile, listFiles, glob, grepTool];
}
