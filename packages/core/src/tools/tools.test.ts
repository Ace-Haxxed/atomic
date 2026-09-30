import { describe, expect, it } from "vitest";
import { createCodeTools, createFolderTools } from "./index.js";
import { createWriteTools, contextDiff } from "./write.js";
import { createReadTools } from "./read.js";
import { createShellTool } from "./shell.js";
import { createTodoTool, type TodoStore, type TodoItem } from "./git.js";
import type { FileSystemPort, ProcessPort, RunResult, GrepResult } from "../host/ports.js";
import { SettingsSchema } from "../settings/schema.js";
import type { Tool, ToolContext } from "./registry.js";

// ---- fakes --------------------------------------------------------------

/** An in-memory workspace. Refuses `..` the way the Rust layer does. */
function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const port: FileSystemPort = {
    async readFile(root, path) {
      if (path.includes("..")) throw new Error("The path may not contain `..`.");
      const content = files.get(path);
      if (content === undefined) throw new Error("no such file in the workspace");
      const lines = content.split("\n");
      const from = 0;
      const to = lines.length;
      return {
        path,
        content: lines.slice(from, to).join("\n"),
        truncated: false,
        omittedBytes: 0,
        startLine: from + 1,
        endLine: to,
        totalLines: lines.length,
      };
    },
    async writeFile(_root, path, content) {
      files.set(path, content);
      return { path, name: path.split("/").pop() ?? path, isDir: false, size: content.length };
    },
    async listDirectory(_root, path) {
      const entries = [...files.keys()]
        .filter((key) => key.startsWith(path === "." ? "" : `${path}/`))
        .map((key) => ({ path: key, name: key.split("/").pop() ?? key, isDir: false, size: files.get(key)!.length }));
      return { entries, truncated: false };
    },
    async glob(_root, pattern) {
      const suffix = pattern.replace(/^\*\*\//, "");
      return [...files.keys()].filter((key) => key.endsWith(suffix.replace(/^\*\*/, "")));
    },
    async grep(): Promise<GrepResult> {
      return { matches: [], truncated: false, filesSearched: 0 };
    },
  };
  return { port, files };
}

function fakeProcess(overrides: Partial<RunResult> = {}, gitRepo = true) {
  const calls: { command: string; git: string[] | null }[] = [];
  const port: ProcessPort = {
    async run(_root, command) {
      calls.push({ command, git: null });
      return { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1, timedOut: false, ...overrides };
    },
    async git(_root, args) {
      calls.push({ command: "", git: args });
      return { exitCode: 0, stdout: "", stderr: "", truncated: false, durationMs: 1, timedOut: false, ...overrides };
    },
    async isGitRepository() {
      return gitRepo;
    },
    async defaultBranch() {
      return "main";
    },
  };
  return { port, calls };
}

function fakeTodos(): TodoStore & { items: TodoItem[] } {
  const store = {
    items: [] as TodoItem[],
    async read() {
      return store.items;
    },
    async write(_conversationId: string, items: readonly TodoItem[]) {
      store.items = [...items];
    },
  };
  return store;
}

const context = (workspace: string | null = "/ws", extraRoots: readonly string[] = []): ToolContext => ({
  conversationId: "c",
  messageId: "m",
  runId: "r",
  mode: "code",
  signal: new AbortController().signal,
  workspace,
  extraRoots: () => extraRoots,
  describe: (args) => JSON.stringify(args),
});

function find(tools: Tool<any>[], name: string): Tool<any> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
}

const run = async (tool: Tool<any>, rawArgs: unknown, ctx = context()) => {
  const args = tool.parse ? tool.parse(rawArgs) : rawArgs;
  return tool.execute(args, ctx);
};

// ---- read tools ---------------------------------------------------------

describe("read_file", () => {
  it("returns the file with a header naming the line count", async () => {
    const { port } = fakeFs({ "a.txt": "one\ntwo\nthree" });
    const result = await run(find(createReadTools(port), "read_file"), { path: "a.txt" });
    expect(result.content).toContain("a.txt (3 lines)");
    expect(result.content).toContain("one");
  });

  it("says the path was not found instead of returning nothing", async () => {
    const { port } = fakeFs();
    await expect(run(find(createReadTools(port), "read_file"), { path: "nope.txt" })).rejects.toThrow(
      /no such file/i,
    );
  });

  it("refuses to act without a workspace", async () => {
    const { port } = fakeFs({ "a.txt": "x" });
    await expect(run(find(createReadTools(port), "read_file"), { path: "a.txt" }, context(null))).rejects.toThrow(
      /no folder open/i,
    );
  });
});

describe("list_files", () => {
  it("says the directory is empty rather than returning a blank result", async () => {
    const { port } = fakeFs();
    const result = await run(find(createReadTools(port), "list_files"), { path: "." });
    expect(result.content).toMatch(/empty/i);
  });

  it("defaults to the workspace root", async () => {
    const { port } = fakeFs({ "a.txt": "x" });
    const result = await run(find(createReadTools(port), "list_files"), {});
    expect(result.content).toContain("a.txt");
  });
});

/**
 * Paths written out in full.
 *
 * A model asked to look in a folder the user named by hand will often write the
 * whole path, because that is what the user said and what it saw in earlier
 * output. Refusing that on the grounds of its shape is refusing to do the job.
 *
 * What this file checks is that the *tool* passes such a path through untouched
 * and says so in its schema, so a model is not left guessing whether absolute
 * paths are allowed. Whether the path is actually inside the folder is decided by
 * the host, which re-checks it on the Rust side against the canonicalized root --
 * that is covered by `workspace.rs`, and faking it here with a stub port would
 * only prove the stub agrees with itself.
 */
/**
 * Folders the user added under Settings.
 *
 * The contract the tools owe: a folder the user authorized is as usable as the
 * workspace, and a folder they did not is not. The first half is the feature; the
 * second is the reason the first is safe. The refusal cases matter just as much
 * as the working ones, because a tool that quietly passes an unauthorized path
 * through and lets something downstream decide would be trusting the wrong layer
 * to be the one that notices.
 */
describe("folders added under Settings", () => {
  const EXTRA = "/home/me/Code";

  it("reaches a file in an added folder when no workspace is open", async () => {
    // The user authorized a folder and closed the project. Refusing here would
    // make Settings look broken -- the folder is listed and it is authorized.
    const { port } = fakeFs({ [`${EXTRA}/src/a.ts`]: "export const a = 1;" });
    const result = await run(
      find(createReadTools(port), "read_file"),
      { path: `${EXTRA}/src/a.ts` },
      context(null, [EXTRA]),
    );
    expect(result.content).toContain("export const a");
  });

  it("lists an added folder when no workspace is open", async () => {
    const { port } = fakeFs({ [`${EXTRA}/src/a.ts`]: "x" });
    const result = await run(
      find(createReadTools(port), "list_files"),
      { path: EXTRA },
      context(null, [EXTRA]),
    );
    expect(result.content).toContain("src");
  });

  it("creates a file in an added folder", async () => {
    const { port, files } = fakeFs();
    await run(
      find(createWriteTools(port), "write_file"),
      { path: `${EXTRA}/new.ts`, content: "made" },
      context(null, [EXTRA]),
    );
    expect(files.get(`${EXTRA}/new.ts`)).toBe("made");
  });

  it("hands the host every root, workspace first", async () => {
    // The list is the authorization. A tool that sent only the workspace would
    // leave an added folder looking absent, and the model would conclude the
    // user's own folder does not exist.
    const seen: string[][] = [];
    const port: FileSystemPort = {
      ...fakeFs().port,
      async listDirectory(roots, path) {
        seen.push([...roots]);
        return { entries: [], truncated: false };
      },
    };
    await run(
      find(createReadTools(port), "list_files"),
      { path: "." },
      context("/ws", [EXTRA, "/home/me/Docs"]),
    );
    expect(seen).toEqual([["/ws", EXTRA, "/home/me/Docs"]]);
  });

  it("does not repeat a folder that is also the workspace", async () => {
    const seen: string[][] = [];
    const port: FileSystemPort = {
      ...fakeFs().port,
      async listDirectory(roots) {
        seen.push([...roots]);
        return { entries: [], truncated: false };
      },
    };
    await run(find(createReadTools(port), "list_files"), { path: "." }, context("/ws", ["/ws"]));
    expect(seen).toEqual([["/ws"]]);
  });

  it("still refuses when nothing is open and nothing has been added", async () => {
    const { port } = fakeFs({ "a.ts": "x" });
    await expect(
      run(find(createReadTools(port), "read_file"), { path: "a.ts" }, context(null, [])),
    ).rejects.toThrow(/no folder open/i);
  });

  it("says where to add a folder when nothing is open", async () => {
    // "No folder open" alone is a dead end for a model that cannot open one.
    // Naming the setting turns a dead end into a request the user can answer.
    const { port } = fakeFs({ "a.ts": "x" });
    await expect(
      run(find(createReadTools(port), "list_files"), {}, context(null, [])),
    ).rejects.toThrow(/settings/i);
  });

  it("passes an unauthorized path to the host rather than deciding here", async () => {
    // The tool is not the enforcement point and must not pretend to be. A path
    // outside every root still reaches the port, which re-checks it against the
    // real filesystem -- a textual check in TypeScript would be bypassable by
    // anything the resolver canonicalizes differently.
    const seen: string[] = [];
    const port: FileSystemPort = {
      ...fakeFs().port,
      async listDirectory(_roots, path) {
        seen.push(path);
        return { entries: [], truncated: false };
      },
    };
    await run(
      find(createReadTools(port), "list_files"),
      { path: "/etc" },
      context("/ws", [EXTRA]),
    );
    expect(seen).toEqual(["/etc"]);
  });
});

describe("absolute paths", () => {
  const absolute = "/home/me/project/src";

  it("passes an absolute directory through to the host when listing", async () => {
    const seen: string[] = [];
    const port: FileSystemPort = {
      ...fakeFs({ "src/a.txt": "x" }).port,
      async listDirectory(_root, path) {
        seen.push(path);
        return { entries: [], truncated: false };
      },
    };
    await run(find(createReadTools(port), "list_files"), { path: absolute });
    expect(seen).toEqual([absolute]);
  });

  it("passes an absolute file path through when reading", async () => {
    const seen: string[] = [];
    const port: FileSystemPort = {
      ...fakeFs().port,
      async readFile(_root, path) {
        seen.push(path);
        throw new Error("no such file in the workspace");
      },
    };
    await expect(
      run(find(createReadTools(port), "read_file"), { path: `${absolute}/a.ts` }),
    ).rejects.toThrow();
    expect(seen).toEqual([`${absolute}/a.ts`]);
  });

  it("passes an absolute file path through when writing, so a new file can be made there", async () => {
    const seen: string[] = [];
    const port: FileSystemPort = {
      ...fakeFs().port,
      async writeFile(_root, path, content) {
        seen.push(path);
        return { path, name: "new.ts", isDir: false, size: content.length };
      },
    };
    const result = await run(find(createWriteTools(port), "write_file"), {
      path: `${absolute}/new.ts`,
      content: "x",
    });
    expect(seen).toEqual([`${absolute}/new.ts`]);
    expect(result.content).toContain("new.ts");
  });

  it("still refuses a `..` escape, which is not the same thing as an absolute path", async () => {
    // The two look similar to a regex and mean opposite things: a full path is
    // naming a location the host can check, `..` is climbing out of one.
    const { port } = fakeFs({ "a.txt": "x" });
    await expect(
      run(find(createReadTools(port), "read_file"), { path: "../outside.txt" }),
    ).rejects.toThrow();
  });

  it("tells the model in its schema that an absolute path is acceptable", () => {
    // Silence here is what produces the retries: a model that guessed wrong once
    // will try relative paths forever rather than conclude the folder is closed.
    for (const tool of [...createReadTools(fakeFs().port), ...createWriteTools(fakeFs().port)]) {
      const described = JSON.stringify(tool.parameters);
      if (!described.includes("path")) continue;
      expect(described).toMatch(/absolute/i);
    }
  });
});

describe("glob", () => {
  it("names the pattern back when nothing matches, so a typo is visible", async () => {
    const { port } = fakeFs();
    const result = await run(find(createReadTools(port), "glob"), { pattern: "*.rs" });
    expect(result.content).toBe("No files match *.rs.");
  });
});

// ---- write tools --------------------------------------------------------

describe("write_file", () => {
  it("reports creating a new file", async () => {
    const { port, files } = fakeFs();
    const result = await run(find(createWriteTools(port), "write_file"), { path: "new.ts", content: "x" });
    expect(result.content).toMatch(/^Created new\.ts/);
    expect(files.get("new.ts")).toBe("x");
  });

  it("reports replacing an existing one", async () => {
    const { port } = fakeFs({ "old.ts": "1" });
    const result = await run(find(createWriteTools(port), "write_file"), { path: "old.ts", content: "2" });
    expect(result.content).toMatch(/^Replaced old\.ts/);
  });

  it("carries a display payload so the UI can show the write", async () => {
    const { port } = fakeFs();
    const result = await run(find(createWriteTools(port), "write_file"), { path: "n.ts", content: "x" });
    expect(result.display).toMatchObject({ kind: "file-write", path: "n.ts" });
  });
});

describe("edit_file", () => {
  const start = () => fakeFs({ "src/a.ts": "const a = 1;\nconst b = 2;\nconst c = 3;\n" });

  it("replaces an unambiguous snippet", async () => {
    const { port, files } = start();
    const result = await run(find(createWriteTools(port), "edit_file"), {
      path: "src/a.ts",
      old_string: "const b = 2;",
      new_string: "const b = 42;",
    });
    expect(result.content).toMatch(/^Edited src\/a\.ts \(1 replacement\)/);
    expect(files.get("src/a.ts")).toContain("const b = 42;");
    // The rest of the file is untouched, which is the whole point.
    expect(files.get("src/a.ts")).toContain("const c = 3;");
  });

  it("refuses when the snippet is absent, and does not write", async () => {
    const { port, files } = start();
    await expect(
      run(find(createWriteTools(port), "edit_file"), {
        path: "src/a.ts",
        old_string: "const zz = 9;",
        new_string: "x",
      }),
    ).rejects.toThrow(/not found/i);
    expect(files.get("src/a.ts")).toBe("const a = 1;\nconst b = 2;\nconst c = 3;\n");
  });

  it("refuses an ambiguous snippet unless replace_all is set", async () => {
    const { port } = fakeFs({ "d.ts": "x\nx\n" });
    await expect(
      run(find(createWriteTools(port), "edit_file"), { path: "d.ts", old_string: "x", new_string: "y" }),
    ).rejects.toThrow(/appears 2 times/i);
  });

  it("replaces every occurrence when asked", async () => {
    const { port, files } = fakeFs({ "d.ts": "x\nx\n" });
    await run(find(createWriteTools(port), "edit_file"), {
      path: "d.ts",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
    expect(files.get("d.ts")).toBe("y\ny\n");
  });

  it("carries before and after so a diff can be rendered without a re-read", async () => {
    const { port } = start();
    const result = await run(find(createWriteTools(port), "edit_file"), {
      path: "src/a.ts",
      old_string: "const b = 2;",
      new_string: "const b = 42;",
    });
    const display = result.display as { before: string; after: string };
    expect(display.before).toContain("const b = 2;");
    expect(display.after).toContain("const b = 42;");
  });

  it("respects exact whitespace, so a wrong-indent edit is caught", async () => {
    const { port } = start();
    await expect(
      run(find(createWriteTools(port), "edit_file"), {
        path: "src/a.ts",
        old_string: "const b=2;",
        new_string: "x",
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("contextDiff", () => {
  it("shows the changed region with its surroundings", () => {
    const diff = contextDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne", "f.txt");
    expect(diff).toContain("f.txt");
    expect(diff).toContain("X");
  });
});

// ---- bash ---------------------------------------------------------------

describe("bash", () => {
  it("marks a non-zero exit as an error so the model does not build on it", async () => {
    const { port } = fakeProcess({ exitCode: 1, stdout: "boom" });
    const result = await run(find(createShellTool(port), "bash"), { command: "false" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed");
    expect(result.content).toContain("boom");
  });

  it("reports a successful run with its exit code and duration", async () => {
    const { port } = fakeProcess({ stdout: "ok" });
    const result = await run(find(createShellTool(port), "bash"), { command: "true" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("ok");
    expect(result.content).toContain("exit code 0");
  });

  it("treats a timeout as a failure, not a slow success", async () => {
    const { port } = fakeProcess({ timedOut: true });
    const result = await run(find(createShellTool(port), "bash"), { command: "sleep 999" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("killed");
  });

  it("keeps stderr separate from stdout", async () => {
    const { port } = fakeProcess({ stdout: "out", stderr: "err" });
    const result = await run(find(createShellTool(port), "bash"), { command: "x" });
    expect(result.content).toContain("out");
    expect(result.content).toContain("stderr:");
  });

  it("refuses an empty command", async () => {
    const { port } = fakeProcess();
    await expect(run(find(createShellTool(port), "bash"), { command: "   " })).rejects.toThrow();
  });

  it("passes the timeout through", async () => {
    const { port, calls } = fakeProcess();
    await run(find(createShellTool(port), "bash"), { command: "x", timeout_ms: 5000 });
    expect(calls[0]?.command).toBe("x");
  });
});

// ---- todos --------------------------------------------------------------

describe("todo_write", () => {
  it("stores the plan", async () => {
    const todos = fakeTodos();
    await run(find(createTodoTool(todos), "todo_write"), {
      todos: [
        { content: "read the code", status: "completed" },
        { content: "fix it", status: "in_progress" },
      ],
    });
    expect(todos.items).toHaveLength(2);
  });

  it("refuses two in-progress items, so progress stays unambiguous", async () => {
    const todos = fakeTodos();
    await expect(
      run(find(createTodoTool(todos), "todo_write"), {
        todos: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow(/Exactly one/);
  });

  it("carries the plan as display data for the UI", async () => {
    const todos = fakeTodos();
    const result = await run(find(createTodoTool(todos), "todo_write"), {
      todos: [{ content: "a", status: "pending" }],
    });
    expect(result.display).toMatchObject({ kind: "todos" });
  });
});

// ---- the set ------------------------------------------------------------

describe("createCodeTools", () => {
  it("provides the nine Code tools", () => {
    const { port: fs } = fakeFs();
    const { port: process } = fakeProcess();
    const tools = createCodeTools({ fs, process, todos: fakeTodos() });
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "edit_file",
      "git",
      "glob",
      "grep",
      "list_files",
      "read_file",
      "todo_write",
      "write_file",
    ]);
  });

  it("declares only Code-relevant modes, so Chat never offers them", () => {
    const { port: fs } = fakeFs();
    const { port: process } = fakeProcess();
    const tools = createCodeTools({ fs, process, todos: fakeTodos() });
    for (const tool of tools) {
      expect(tool.modes).not.toContain("chat");
      expect(tool.categories.length).toBeGreaterThan(0);
    }
  });

  it("marks every read-only tool as file-read and every mutator as something else", () => {
    const { port: fs } = fakeFs();
    const { port: process } = fakeProcess();
    const tools = createCodeTools({ fs, process, todos: fakeTodos() });
    const readOnly = new Set(["read_file", "list_files", "glob", "grep", "git", "todo_write"]);
    for (const tool of tools) {
      if (readOnly.has(tool.name)) {
        expect(tool.categories, tool.name).toEqual(["file-read"]);
      } else {
        expect(tool.categories, tool.name).not.toContain("file-read");
      }
    }
  });
});

// ---- checkpoints --------------------------------------------------------

describe("checkpoints", () => {
  const fakeCheckpoints = () => {
    const saved: { conversationId: string; path: string; existed: boolean; before: string; runId: string }[] = [];
    const port = {
      save: async (input: { conversationId: string; path: string; existed: boolean; before: string; runId: string }) => {
        saved.push(input);
      },
      list: async () => [],
      restore: async () => [],
      discard: async () => {},
    };
    return { port, saved };
  };

  const enabled = () => SettingsSchema.parse({ checkpointsEnabled: true });

  it("records the previous contents before overwriting a file", async () => {
    const { port: fs } = fakeFs({ "a.ts": "original" });
    const { port, saved } = fakeCheckpoints();
    const tools = createWriteTools(fs, { checkpoints: port, settings: enabled });

    await run(find(tools, "write_file"), { path: "a.ts", content: "replaced" });
    expect(saved).toEqual([
      { conversationId: "c", path: "a.ts", existed: true, before: "original", runId: "r" },
    ]);
  });

  it("records that a new file did not exist, so a restore deletes it", async () => {
    const { port: fs } = fakeFs();
    const { port, saved } = fakeCheckpoints();
    const tools = createWriteTools(fs, { checkpoints: port, settings: enabled });

    await run(find(tools, "write_file"), { path: "new.ts", content: "x" });
    // `existed: false` is the whole point: without it, restoring a file the
    // agent created is indistinguishable from restoring one the user had.
    expect(saved).toEqual([
      { conversationId: "c", path: "new.ts", existed: false, before: "", runId: "r" },
    ]);
  });

  it("records the file as it was before an edit, not after", async () => {
    const { port: fs } = fakeFs({ "a.ts": "one\ntwo\nthree" });
    const { port, saved } = fakeCheckpoints();
    const tools = createWriteTools(fs, { checkpoints: port, settings: enabled });

    await run(find(tools, "edit_file"), { path: "a.ts", old_string: "two", new_string: "TWO" });
    expect(saved[0]?.before).toBe("one\ntwo\nthree");
  });

  it("writes nothing when the user has turned checkpoints off", async () => {
    const { port: fs } = fakeFs({ "a.ts": "original" });
    const { port, saved } = fakeCheckpoints();
    const tools = createWriteTools(fs, {
      checkpoints: port,
      // The setting is read per call, so turning it off takes effect at once
      // rather than at the next restart.
      settings: () => SettingsSchema.parse({ checkpointsEnabled: false }),
    });

    const result = await run(find(tools, "write_file"), { path: "a.ts", content: "replaced" });
    expect(saved).toEqual([]);
    expect(result.content).toContain("a.ts");
  });

  it("still writes when the checkpoint cannot be stored", async () => {
    // A full disk must not deadlock a run the user is watching. The write
    // going through is the right trade; the missing undo is visible.
    const { port: fs } = fakeFs({ "a.ts": "original" });
    const tools = createWriteTools(fs, {
      checkpoints: {
        save: async () => {
          throw new Error("no space left on device");
        },
        list: async () => [],
        restore: async () => [],
        discard: async () => {},
      },
      settings: enabled,
    });

    const result = await run(find(tools, "write_file"), { path: "a.ts", content: "replaced" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("a.ts");
    // Writing is not the thing that failed, so it is not an error. But the user
    // has to be able to see that /undo will not cover this file, or they will
    // believe it is restorable when it is not.
    expect(result.content).toContain("Couldn't back up a.ts; /undo won't restore it");
  });

  it("says which file lost its backup when an edit cannot be stored", async () => {
    const { port: fs } = fakeFs({ "a.ts": "original" });
    const tools = createWriteTools(fs, {
      checkpoints: {
        save: async () => {
          throw new Error("no space left on device");
        },
        list: async () => [],
        restore: async () => [],
        discard: async () => {},
      },
      settings: enabled,
    });

    const result = await run(find(tools, "edit_file"), {
      path: "a.ts",
      old_string: "original",
      new_string: "replaced",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Couldn't back up a.ts; /undo won't restore it");
  });

  it("keeps the warning in the card payload, not just the text", async () => {
    // The transcript shows the display payload, and it is what survives a
    // reload. A warning in the model-facing text alone would be invisible the
    // moment the user scrolled back.
    const { port: fs } = fakeFs({ "a.ts": "original" });
    const tools = createWriteTools(fs, {
      checkpoints: {
        save: async () => {
          throw new Error("disk full");
        },
        list: async () => [],
        restore: async () => [],
        discard: async () => {},
      },
      settings: enabled,
    });

    const result = await run(find(tools, "write_file"), { path: "a.ts", content: "replaced" });
    expect(result.display).toMatchObject({ warning: expect.stringContaining("won't restore it") });
  });

  it("says nothing about backups when the snapshot was stored", async () => {
    const { port: fs } = fakeFs({ "a.ts": "original" });
    const saved: unknown[] = [];
    const tools = createWriteTools(fs, {
      checkpoints: {
        save: async (input) => {
          saved.push(input);
          return { path: input.path, existed: true, bytes: 8, createdAt: 1, runId: input.runId };
        },
        list: async () => [],
        restore: async () => [],
        discard: async () => {},
      },
      settings: enabled,
    });

    const result = await run(find(tools, "write_file"), { path: "a.ts", content: "replaced" });
    // A warning on a successful backup trains people to ignore it.
    expect(result.content).not.toContain("Couldn't back up");
    expect(result.display).not.toHaveProperty("warning");
  });

  it("works with no checkpoint port at all", async () => {
    const { port: fs } = fakeFs({ "a.ts": "original" });
    const result = await run(find(createWriteTools(fs), "write_file"), { path: "a.ts", content: "x" });
    expect(result.isError).toBeFalsy();
  });
});

/*
 * The folder tool, from the model's side.
 *
 * What matters here is not that the tool calls the port -- that is a one-line
 * delegation -- but that it refuses to act on an aborted run, reports what
 * happened in terms the model can use, and does not exist at all when the host
 * cannot authorize folders. The last one matters most: a tool offered to a model
 * that always fails is one the model keeps calling.
 */
describe("add_folder", () => {
  const EXTRA = "/home/me/Code";

  function fakeFolders(
    result: { ok: true; path: string } | { ok: false; reason: string } = { ok: true, path: EXTRA },
  ) {
    const asked: string[] = [];
    return {
      asked,
      port: {
        async authorize(path: string) {
          asked.push(path);
          return result;
        },
      },
    };
  }

  it("authorizes the folder and says how to use it next", async () => {
    const { asked, port } = fakeFolders();
    const result = await run(find(createFolderTools({ folders: port }), "add_folder"), {
      path: EXTRA,
    }, context("/ws"));
    expect(asked).toEqual([EXTRA]);
    // The follow-up has to be spelled out. "Added" alone leaves the model
    // guessing whether the folder is relative to the workspace, and it will guess
    // wrong.
    expect(result.content).toContain(`${EXTRA}/README.md`);
    expect(result.content).toMatch(/relative paths still/i);
  });

  it("carries the reason the model gave into the result", async () => {
    const { port } = fakeFolders();
    const result = await run(find(createFolderTools({ folders: port }), "add_folder"), {
      path: EXTRA,
      reason: "the project you named",
    }, context("/ws"));
    expect(result.content).toContain("the project you named");
  });

  it("surfaces a refusal as an error the model can act on", async () => {
    // Not a thrown exception: the agent asked, the answer was no, and it needs to
    // carry on rather than have the run torn down.
    const { port } = fakeFolders({ ok: false, reason: "`/home/me/.ssh` is a credentials folder." });
    const result = await run(find(createFolderTools({ folders: port }), "add_folder"), {
      path: "/home/me/.ssh",
    }, context("/ws"));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("credentials folder");
  });

  it("does not authorize anything once the run is cancelled", async () => {
    // The gate has already asked the user by the time a tool runs, so honouring
    // a cancellation here means refusing to leave behind the one thing the user
    // was shown and did not get. An aborted run must change nothing.
    const { asked, port } = fakeFolders();
    const cancelled = context("/ws");
    const result = await run(
      find(createFolderTools({ folders: port }), "add_folder"),
      { path: EXTRA },
      { ...cancelled, signal: AbortSignal.abort() },
    );
    expect(asked).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/cancel/i);
  });

  it("asks for an absolute path, and says so in the schema", async () => {
    // A relative path here is ambiguous -- relative to the workspace, which is
    // already allowed, or to nothing at all. The schema says absolute so the
    // model does not have to infer it.
    const tool = find(createFolderTools({ folders: fakeFolders().port }), "add_folder");
    expect(JSON.stringify(tool.parameters)).toMatch(/absolute/i);
  });

  it("is absent when the host cannot authorize folders", () => {
    // The switch-off case. A model told about a capability that is always
    // refused keeps reaching for it, so absence is the honest answer.
    const names = createCodeTools({
      fs: fakeFs().port,
      process: {} as never,
      todos: fakeTodos(),
    }).map((tool) => tool.name);
    expect(names).not.toContain("add_folder");
  });

  it("is present when the host can, and declares folder-access as its category", () => {
    const tool = find(
      createCodeTools({
        fs: fakeFs().port,
        process: {} as never,
        todos: fakeTodos(),
        folders: fakeFolders().port,
      }),
      "add_folder",
    );
    // Not `file-write`: that category is covered by auto-accept, which would
    // grant this without a prompt on a switch the user set for something else.
    expect(tool.categories).toEqual(["folder-access"]);
  });

  it("tells the model not to ask for credentials or system folders", async () => {
    const tool = find(createFolderTools({ folders: fakeFolders().port }), "add_folder");
    // The refusal list is enforced in Rust, but a model that knows the rule
    // wastes far fewer turns discovering it.
    expect(tool.description).toMatch(/credential|home director/i);
  });
});
