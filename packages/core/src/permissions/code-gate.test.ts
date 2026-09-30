/**
 * The permission gate, tested against the real toolset.
 *
 * These are the tests that matter most in the app. Everything else can be wrong
 * and merely annoying; if the gate is wrong, the agent edits files the user
 * never opened, runs commands they never approved, or reads a file they never
 * granted. So this file deliberately uses the *real* `createCodeTools` output
 * rather than stub tools whose names merely look right -- a tool that quietly
 * declared the wrong category would pass a stub-based test and fail in the app.
 */

import { describe, expect, it } from "vitest";
import { PermissionGate } from "./gate.js";
import { isReadOnlyTool } from "./gate.js";
import { SettingsSchema, type Settings, type Mode } from "../settings/schema.js";
import { createCodeTools } from "../tools/index.js";
import type { FileSystemPort, ProcessPort } from "../host/ports.js";
import type { Tool } from "../tools/registry.js";
import { describePlatform } from "../platform/platform.js";

const tools = (): Tool<any>[] =>
  createCodeTools({
    fs: {} as FileSystemPort,
    process: {} as ProcessPort,
    todos: { read: async () => [], write: async () => {} },
  });

const byName = (name: string): Tool<any> => {
  const tool = tools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
};

function settingsWith(patch: (settings: Settings) => Settings): () => Settings {
  const base = SettingsSchema.parse({});
  let current = patch(base);
  return () => current;
}

const LINUX = describePlatform("linux", "x86_64");
const MAC = describePlatform("macos", "arm64");
const WINDOWS = describePlatform("win32", "x86_64");

const gate = (get: () => Settings, platform = LINUX) => new PermissionGate(get, { platform });

/**
 * The gate receives the real `Tool` object, not a name. That is deliberate: a
 * test that passed strings could not catch a tool declaring the wrong category
 * or the wrong mode, which are exactly the mistakes worth catching here.
 */
const check = (g: PermissionGate, tool: string, args: Record<string, unknown>, options: { mode?: Mode; workspace?: string | null } = {}) =>
  g.check({
    tool: byName(tool),
    args,
    mode: options.mode ?? "code",
    runId: "r",
    conversationId: "c",
    workspace: options.workspace === undefined ? "/ws" : options.workspace,
  });

// ---- plan mode ----------------------------------------------------------

describe("plan mode", () => {
  const inPlan = (get: () => Settings) => gate(get);

  it("refuses every write tool, and says why", () => {
    for (const name of ["write_file", "edit_file", "bash"]) {
      const g = inPlan(settingsWith((s) => SettingsSchema.parse({ ...s, permissions: { ...s.permissions, code: { ...s.permissions.code, level: "plan" } } })));
      const outcome = check(g, name, { path: "a.ts", command: "ls" });
      expect(outcome.decision, name).toBe("deny");
      expect(outcome.rule, name).toBe("plan_mode");
      expect(outcome.reason).toMatch(/read-only/i);
    }
  });

  it("allows the read tools, so planning is possible at all", () => {
    const g = inPlan(settingsWith((s) => SettingsSchema.parse({ ...s, permissions: { ...s.permissions, code: { ...s.permissions.code, level: "plan" } } })));
    for (const name of ["read_file", "list_files", "glob", "grep", "git", "todo_write"]) {
      expect(check(g, name, { path: "a.ts", pattern: "x" }).decision, name).toBe("allow");
    }
  });

  it("cannot be talked out of it by an allow-list entry", () => {
    // The plan check runs first, so an over-broad allow list cannot re-enable a
    // write. If the order ever changes, this test catches it.
    const g = inPlan(
      settingsWith((s) =>
        SettingsSchema.parse({
          ...s,
          permissions: {
            ...s.permissions,
            code: { ...s.permissions.code, level: "plan", allowedPaths: ["/ws"] },
          },
        }),
      ),
    );
    expect(check(g, "write_file", { path: "a.ts" }).decision).toBe("deny");
  });
});

// ---- deny precedence ---------------------------------------------------

describe("deny beats everything", () => {
  const base = (over: Partial<Settings["permissions"]["code"]> = {}) =>
    settingsWith((s) =>
      SettingsSchema.parse({
        ...s,
        permissions: { ...s.permissions, code: { ...s.permissions.code, ...over } },
      }),
    );

  it("denies a listed command in ask mode", () => {
    const g = gate(base({ deniedCommands: ["git push"] }));
    expect(check(g, "bash", { command: "git push origin main" }).decision).toBe("deny");
  });

  it("denies a listed command in bypass mode too", () => {
    // Bypass is a convenience, not an override. This is the single most
    // important assertion in the file.
    const g = gate(base({ level: "bypass", deniedCommands: ["git push"] }));
    const outcome = check(g, "bash", { command: "git push origin main" });
    expect(outcome.decision).toBe("deny");
    expect(outcome.rule).toBe("denied_command");
  });

  it("denies a denied path even with bypass", () => {
    const g = gate(base({ level: "bypass", deniedPaths: ["secrets"] }));
    expect(check(g, "read_file", { path: "secrets/key.txt" }).decision).toBe("deny");
  });

  it("denies a command hidden behind a prefix, such as sudo", () => {
    const g = gate(base({ deniedCommands: ["rm -rf /"] }));
    expect(check(g, "bash", { command: "sudo -n rm -rf /" }).decision).toBe("deny");
  });

  it("denies the default destructive commands without configuration", () => {
    const g = gate(base());
    for (const command of ["rm -rf /", "mkfs.ext4 /dev/sda", "shutdown -h now"]) {
      expect(check(g, "bash", { command }).decision, command).toBe("deny");
    }
  });
});

// ---- workspace containment --------------------------------------------

describe("workspace containment", () => {
  it("denies a path that escapes the workspace", () => {
    const g = gate(settingsWith((s) => s));
    const outcome = check(g, "read_file", { path: "../../etc/passwd" }, { workspace: "/ws" });
    expect(outcome.decision).toBe("deny");
    expect(outcome.rule).toBe("outside_workspace");
  });

  it("denies an absolute path outside the workspace", () => {
    const g = gate(settingsWith((s) => s));
    expect(check(g, "read_file", { path: "/etc/passwd" }, { workspace: "/ws" }).decision).toBe("deny");
  });

  it("allows a path inside the workspace", () => {
    // `auto-accept` rather than the default `ask`, so the assertion is about
    // containment rather than about the level.
    const g = gate(
      settingsWith((s) =>
        SettingsSchema.parse({
          ...s,
          permissions: { ...s.permissions, code: { ...s.permissions.code, level: "auto-accept" } },
        }),
      ),
    );
    expect(check(g, "read_file", { path: "src/a.ts" }, { workspace: "/ws" }).decision).toBe("allow");
  });

  it("applies the check to every file tool, not just read_file", () => {
    const g = gate(settingsWith((s) => s));
    for (const name of ["read_file", "write_file", "edit_file", "list_files"]) {
      expect(check(g, name, { path: "../secrets" }, { workspace: "/ws" }).decision, name).toBe("deny");
    }
  });

  it("does not invent a workspace when the conversation has none", () => {
    // No workspace means no relative-path attack to catch, and the file tools
    // fail later with "no folder open" rather than resolving against "/".
    const g = gate(
      settingsWith((s) =>
        SettingsSchema.parse({
          ...s,
          permissions: { ...s.permissions, code: { ...s.permissions.code, level: "auto-accept" } },
        }),
      ),
    );
    expect(check(g, "read_file", { path: "a.ts" }, { workspace: null }).decision).toBe("allow");
  });
});

// ---- levels ------------------------------------------------------------

describe("permission levels", () => {
  const at = (level: string) =>
    settingsWith((s) =>
      SettingsSchema.parse({
        ...s,
        permissions: { ...s.permissions, code: { ...s.permissions.code, level } },
      }),
    );

  it("asks before bash in ask mode", () => {
    const g = gate(at("ask"));
    const outcome = check(g, "bash", { command: "npm test" });
    expect(outcome.decision).toBe("ask");
  });

  it("asks before an edit in ask mode", () => {
    expect(check(gate(at("ask")), "edit_file", { path: "a.ts" }).decision).toBe("ask");
  });

  it("never asks for a read-only tool outside ask mode", () => {
    for (const level of ["auto-accept", "bypass", "plan"]) {
      expect(check(gate(at(level)), "read_file", { path: "a.ts" }).decision, level).toBe("allow");
    }
  });

  it("auto-accepts edits but still asks for bash", () => {
    // The distinction that makes auto-accept worth having: an edit is
    // reviewable in the diff, a command is not.
    const g = gate(at("auto-accept"));
    expect(check(g, "edit_file", { path: "a.ts" }).decision).toBe("allow");
    expect(check(g, "bash", { command: "npm test" }).decision).toBe("ask");
  });

  it("allows everything in bypass", () => {
    const g = gate(at("bypass"));
    expect(check(g, "bash", { command: "npm test" }).decision).toBe("allow");
    expect(check(g, "edit_file", { path: "a.ts" }).decision).toBe("allow");
  });

  it("auto-approves only what the user turned on", () => {
    const g = gate(
      settingsWith((s) =>
        SettingsSchema.parse({
          ...s,
          permissions: {
            ...s.permissions,
            code: { ...s.permissions.code, autoApprove: { ...s.permissions.code.autoApprove, bash: true } },
          },
        }),
      ),
    );
    expect(check(g, "bash", { command: "npm test" }).decision).toBe("allow");
    // Enabling bash must not silently enable writes.
    expect(check(g, "write_file", { path: "a.ts" }).decision).toBe("ask");
  });

  it("never auto-approves a read through a write-side category toggle", () => {
    // A user who allowed file-write must not thereby auto-approve everything.
    const g = gate(
      settingsWith((s) =>
        SettingsSchema.parse({
          ...s,
          permissions: {
            ...s.permissions,
            code: {
              ...s.permissions.code,
              level: "auto-accept",
              autoApprove: { ...s.permissions.code.autoApprove, fileWrite: true },
            },
          },
        }),
      ),
    );
    const outcome = check(g, "read_file", { path: "a.ts" });
    // Still allowed, but because reads need no approval -- not because of the
    // toggle. The rule name is what distinguishes the two.
    expect(outcome.decision).toBe("allow");
    expect(outcome.rule).toBe("read_only");
  });
});

// ---- allow lists -------------------------------------------------------

describe("allow lists", () => {
  it("allows a listed command without asking", () => {
    const g = gate(
      settingsWith((s) =>
        SettingsSchema.parse({
          ...s,
          permissions: {
            ...s.permissions,
            code: { ...s.permissions.code, allowedCommands: ["npm test*"] },
          },
        }),
      ),
    );
    const outcome = check(g, "bash", { command: "npm test -- --watch=false" });
    expect(outcome.decision).toBe("allow");
    expect(outcome.rule).toBe("allowed_command");
  });

  it("does not let an allow-list entry bypass a deny entry", () => {
    const g = gate(
      settingsWith((s) =>
        SettingsSchema.parse({
          ...s,
          permissions: {
            ...s.permissions,
            code: {
              ...s.permissions.code,
              allowedCommands: ["rm*"],
              deniedCommands: ["rm -rf /"],
            },
          },
        }),
      ),
    );
    expect(check(g, "bash", { command: "rm -rf /" }).decision).toBe("deny");
    // The rest of the pattern is still allowed.
    expect(check(g, "bash", { command: "rm build/out.js" }).decision).toBe("allow");
  });

  it("allows anything inside an allowed folder", () => {
    const g = gate(
      settingsWith((s) =>
        SettingsSchema.parse({
          ...s,
          permissions: {
            ...s.permissions,
            code: { ...s.permissions.code, allowedPaths: ["src"] },
          },
        }),
      ),
    );
    expect(check(g, "edit_file", { path: "src/a.ts" }).decision).toBe("allow");
    expect(check(g, "edit_file", { path: "docs/a.md" }).decision).toBe("ask");
  });
});

// ---- read-only classification -----------------------------------------

describe("read-only classification", () => {
  it("matches the tools that declare themselves read-only", () => {
    // If a new tool is added and forgotten here, it would be allowed in plan
    // mode while mutating the project. The category check below is the real
    // guard; this asserts the two agree.
    for (const tool of tools()) {
      const declared = tool.categories.includes("file-write") || tool.categories.includes("bash");
      expect(isReadOnlyTool(tool.name), tool.name).toBe(!declared);
    }
  });

  it("does not treat an unknown tool as read-only", () => {
    expect(isReadOnlyTool("some_future_tool")).toBe(false);
  });
});
