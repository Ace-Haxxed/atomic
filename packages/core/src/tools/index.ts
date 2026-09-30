/**
 * The Code-mode toolset.
 *
 * Nine tools, assembled from parts that each need a host port. `createCodeTools`
 * is the single place that decides which tools exist, so a mode can ask "what
 * can you do" and get one honest answer rather than a list assembled at four
 * call sites.
 */

import type { FileSystemPort, ProcessPort } from "../host/ports.js";
import { createReadTools } from "./read.js";
import { createWriteTools, type CheckpointDeps } from "./write.js";
import { createShellTool } from "./shell.js";
import { createGitTool, createTodoTool, type TodoItem, type TodoStore } from "./git.js";
import type { Tool } from "./registry.js";

export { createReadTools, createWriteTools, createShellTool, createGitTool, createTodoTool };
export type { TodoItem, TodoStore };
export { contextDiff } from "./write.js";

export interface CodeToolDeps {
  readonly fs: FileSystemPort;
  readonly process: ProcessPort;
  readonly todos: TodoStore;
  /** Optional: without it the write tools still work, just without undo. */
  readonly checkpoint?: CheckpointDeps;
}

export function createCodeTools(deps: CodeToolDeps): Tool<any>[] {
  return [
    ...createReadTools(deps.fs),
    ...createWriteTools(deps.fs, deps.checkpoint),
    ...createShellTool(deps.process),
    ...createGitTool(deps.process),
    ...createTodoTool(deps.todos),
  ];
}
