/**
 * The filesystem and process ports the Code-mode tools depend on.
 *
 * `packages/core` is host-agnostic: it has no `node:fs`, no `child_process`,
 * and no `process`. Tools talk to these interfaces, and the desktop app
 * implements them by calling into Rust.
 *
 * The split is deliberate and load-bearing. Core decides *what* a tool wants to
 * do and the permission gate decides *whether* it may; Rust decides *how* and
 * enforces the sandbox at the syscall boundary. Putting the path check in
 * TypeScript would mean a future tool could forget it, and there is no way to
 * write a test that proves a check nobody remembered to call.
 *
 * So: no method here takes an absolute path, and every method takes the
 * workspace root and a relative path. There is deliberately no escape hatch.
 */

export interface FileEntry {
  /** Workspace-relative, forward slashes. What a tool passes back. */
  readonly path: string;
  readonly name: string;
  readonly isDir: boolean;
  readonly size: number;
}

export interface ReadFileResult {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  /** Bytes not returned, so the model knows to narrow rather than re-read. */
  readonly omittedBytes: number;
  /** 1-based, matching what a stack trace and an editor both show. */
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
}

export interface GrepMatch {
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  readonly text: string;
}

export interface GrepResult {
  readonly matches: readonly GrepMatch[];
  readonly truncated: boolean;
  /** Files actually examined, so "no matches" can be told from "never looked". */
  readonly filesSearched: number;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/**
 * A file system, scoped to the folders a conversation is allowed to use.
 *
 * Every method takes the *whole* list of authorized roots rather than a single
 * workspace, because a path is authorized by being inside any one of them. The
 * list is passed as data so the host can re-check it against the real filesystem
 * -- nothing on this side of the port gets to decide a path is safe.
 */
export interface FileSystemPort {
  /**
   * @param roots Authorized roots; a path inside any of them is allowed.
   * @param offset 1-based first line to return.
   */
  readFile(
    roots: readonly string[],
    path: string,
    options?: { offset?: number; limit?: number },
  ): Promise<ReadFileResult>;
  writeFile(roots: readonly string[], path: string, content: string): Promise<FileEntry>;
  listDirectory(
    roots: readonly string[],
    path: string,
  ): Promise<{ entries: readonly FileEntry[]; truncated: boolean }>;
  /** Paths matching a glob across every authorized root, in the order found. */
  glob(roots: readonly string[], pattern: string): Promise<readonly string[]>;
  grep(
    roots: readonly string[],
    pattern: string,
    options?: { glob?: string; caseSensitive?: boolean; maxMatches?: number },
  ): Promise<GrepResult>;
}

/** Process execution, always rooted at the workspace. */
export interface ProcessPort {
  run(
    workspaceRoot: string,
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<RunResult>;
  /** Read-only git queries. The agent decides separately whether to mutate. */
  git(workspaceRoot: string, args: readonly string[]): Promise<RunResult>;
  isGitRepository(workspaceRoot: string): Promise<boolean>;
  defaultBranch(workspaceRoot: string): Promise<string | null>;
}

/** One file the agent changed during a run, as it was beforehand. */
export interface CheckpointFileInfo {
  readonly path: string;
  /** False when the file did not exist, so a restore removes it. */
  readonly existed: boolean;
  readonly bytes: number;
}

export interface CheckpointRunInfo {
  readonly runId: string;
  readonly createdAt: number;
  readonly files: readonly CheckpointFileInfo[];
}

/**
 * Checkpoints: the previous contents of every file a run touched, so a change
 * can be put back. The store is keyed by conversation and run, which is what
 * makes "undo that run" a question the UI can answer without guessing.
 */
export interface CheckpointPort {
  /** Record `path` as it is now, before a write changes it. First write wins. */
  save(input: {
    conversationId: string;
    runId: string;
    path: string;
    existed: boolean;
    before: string;
  }): Promise<void>;
  /** Runs with something to restore, newest first. */
  list(conversationId: string): Promise<readonly CheckpointRunInfo[]>;
  /** Put files back. Omit `path` to restore the whole run. */
  restore(input: {
    workspaceRoot: string;
    conversationId: string;
    runId: string;
    path?: string;
  }): Promise<readonly string[]>;
  discard(conversationId: string, runId: string): Promise<void>;
}

export const UNAVAILABLE_CHECKPOINTS: CheckpointPort = {
  save: () => Promise.reject(new Error("Checkpoints are not available in this host.")),
  list: () => Promise.resolve([]),
  restore: () => Promise.reject(new Error("Checkpoints are not available in this host.")),
  discard: () => Promise.resolve(),
};

/** A port that fails everything, so a host without Code support still loads. */
export const UNAVAILABLE_FILE_SYSTEM: FileSystemPort = {
  readFile: () => Promise.reject(new Error("File access is not available in this host.")),
  writeFile: () => Promise.reject(new Error("File access is not available in this host.")),
  listDirectory: () => Promise.reject(new Error("File access is not available in this host.")),
  glob: () => Promise.reject(new Error("File access is not available in this host.")),
  grep: () => Promise.reject(new Error("Search is not available in this host.")),
};

export const UNAVAILABLE_PROCESS: ProcessPort = {
  run: () => Promise.reject(new Error("Running commands is not available in this host.")),
  git: () => Promise.reject(new Error("git is not available in this host.")),
  isGitRepository: () => Promise.resolve(false),
  defaultBranch: () => Promise.resolve(null),
};
