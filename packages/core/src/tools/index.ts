/**
 * The Code-mode toolset.
 *
 * Assembled from parts that each need a host port. `createCodeTools` is the
 * single place that decides which tools exist, so a mode can ask "what can you
 * do" and get one honest answer rather than a list assembled at four call sites.
 *
 * The folder tool is conditional on a setting rather than merely unused, because
 * a user who has switched off agent-requested folders should not be reading a
 * model description that offers the capability. Absent beats declined: the
 * alternative is a tool the model keeps reaching for and being refused.
 */

import type { FileSystemPort, FolderAccessPort, ProcessPort } from "../host/ports.js";
import { createReadTools } from "./read.js";
import { createWriteTools, type CheckpointDeps } from "./write.js";
import { createShellTool } from "./shell.js";
import { createGitTool, createTodoTool, type TodoItem, type TodoStore } from "./git.js";
import { createFolderTools } from "./folder.js";
import type { Tool } from "./registry.js";

export { createReadTools, createWriteTools, createShellTool, createGitTool, createTodoTool };
export type { TodoItem, TodoStore };
export { contextDiff } from "./write.js";
export { createFolderTools } from "./folder.js";

export interface CodeToolDeps {
  readonly fs: FileSystemPort;
  readonly process: ProcessPort;
  readonly todos: TodoStore;
  /** Optional: without it the write tools still work, just without undo. */
  readonly checkpoint?: CheckpointDeps;
  /**
   * Optional: the port that widens the allowed folders. Omitted when the user
   * has turned agent-requested folders off, which is also what keeps the tool
   * out of the model's tool list.
   */
  readonly folders?: FolderAccessPort;
}

export function createCodeTools(deps: CodeToolDeps): Tool<any>[] {
  return [
    ...createReadTools(deps.fs),
    ...createWriteTools(deps.fs, deps.checkpoint),
    ...createShellTool(deps.process),
    ...createGitTool(deps.process),
    ...createTodoTool(deps.todos),
    ...(deps.folders ? createFolderTools({ folders: deps.folders }) : []),
  ];
}
