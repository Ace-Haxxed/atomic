/**
 * Git tools and the todo list.
 *
 * The git tool is read-only by design. Committing, pushing, branching and
 * resetting are things a person decides, and a model that can `git push`
 * unasked has a lever that reaches past the machine. So this exposes exactly
 * the four queries an agent actually needs to understand a repository, and the
 * write half of git stays behind the human.
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./registry.js";
import type { ProcessPort } from "../host/ports.js";

// ---- git ----------------------------------------------------------------

const GitArgs = z.object({
  subcommand: z
    .enum(["status", "diff", "log", "show"])
    .describe("status: what changed. diff: uncommitted changes. log: recent commits. show: one commit."),
  path: z.string().min(1).optional().describe("Limit to this workspace-relative path."),
  commit: z.string().min(1).optional().describe("Commit for `show`. Defaults to HEAD."),
  limit: z.number().int().min(1).max(200).default(20).describe("How many commits for `log`."),
});

export function createGitTool(process: ProcessPort): Tool<any>[] {
  const git: Tool<z.infer<typeof GitArgs>> = {
    name: "git",
    description:
      "Read-only git queries: status, diff, log, show. Use status to see what is modified before editing, and diff to review your own changes. Atomic will not commit, push, or branch for you — suggest it and let the user decide.",
    parameters: {
      type: "object",
      properties: {
        subcommand: { type: "string", enum: ["status", "diff", "log", "show"] },
        path: { type: "string", description: "Limit to this path." },
        commit: { type: "string", description: "Commit to show." },
        limit: { type: "integer", description: "How many commits for log." },
      },
      required: ["subcommand"],
      additionalProperties: false,
    },
    categories: ["file-read"],
    modes: ["code", "cowork"],
    parse: (args) => GitArgs.parse(args),
    allowSuggestion: (args) => (args.subcommand === "status" ? "git status" : null),
    async execute(args, context): Promise<ToolResult> {
      if (!context.workspace) {
        throw new Error("This conversation has no folder open. Ask the user to open a project folder first.");
      }
      if (!(await process.isGitRepository(context.workspace))) {
        return {
          content: "This folder is not a git repository, so there is nothing to report. Use list_files and glob to explore it instead.",
        };
      }

      const argv: string[] = [args.subcommand];
      if (args.subcommand === "log") {
        argv.push(`--max-count=${args.limit}`, "--oneline", "--no-color");
      }
      if (args.subcommand === "diff") {
        argv.push("--no-color");
      }
      if (args.subcommand === "show") {
        argv.push("--no-color", args.commit ?? "HEAD");
      }
      if (args.path) argv.push("--", args.path);

      const result = await process.git(context.workspace, argv);
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n\n");

      if (result.exitCode !== 0) {
        return {
          content: `git ${args.subcommand} failed: ${output || `exit ${result.exitCode}`}`,
          isError: true,
        };
      }
      if (!output) {
        return { content: `git ${args.subcommand}: no output. The working tree is clean.` };
      }
      return { content: output };
    },
  };

  return [git];
}

// ---- todo ---------------------------------------------------------------

/**
 * The plan, as data.
 *
 * A todo list is the only way the model shows the user what it intends to do
 * before it does it, and in Code mode it is also how progress stays visible
 * across a long run. It lives in the host so the UI can render it outside the
 * message stream, where it survives compaction.
 */
export interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

/**
 * Keyed by conversation, so two chats can hold different plans and a plan
 * outlives the message stream it was discussed in.
 */
export interface TodoStore {
  read(conversationId: string): Promise<readonly TodoItem[]>;
  write(conversationId: string, items: readonly TodoItem[]): Promise<void>;
}

const TodoArgs = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().min(1).describe("What needs doing, as a short imperative phrase."),
        status: z.enum(["pending", "in_progress", "completed"]).default("pending"),
      }),
    )
    .min(1)
    .max(50)
    .describe("The complete list, not a partial update. Exactly one item may be in_progress."),
});

export function createTodoTool(todos: TodoStore): Tool<any>[] {
  const todoWrite: Tool<z.infer<typeof TodoArgs>> = {
    name: "todo_write",
    description:
      "Record the plan as a checklist, and update it as you go. Send the whole list every time. Keep exactly one item in_progress while you work on it, and mark it completed before moving to the next. Use it for any task with three or more steps, so the user can see where you are.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete list of steps.",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    categories: ["file-read"],
    modes: ["code", "cowork"],
    parse: (args) => TodoArgs.parse(args),
    async execute(args, context): Promise<ToolResult> {
      const inProgress = args.todos.filter((todo) => todo.status === "in_progress");
      if (inProgress.length > 1) {
        throw new Error(
          `${inProgress.length} items are marked in_progress. Exactly one at a time, so the user can tell where you are: ${inProgress.map((t) => `"${t.content}"`).join(", ")}.`,
        );
      }
      await todos.write(context.conversationId, args.todos);
      const done = args.todos.filter((todo) => todo.status === "completed").length;
      return {
        content: `Plan updated: ${done}/${args.todos.length} done.`,
        display: { kind: "todos", todos: args.todos },
      };
    },
  };

  return [todoWrite];
}
