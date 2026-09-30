import { describe, expect, it } from "vitest";
import { PermissionGate } from "./gate.js";
import { matchesAnyGlob, globToRegExp } from "./glob.js";
import { describePlatform, type PlatformInfo } from "../platform/platform.js";
import { DEFAULT_SETTINGS, SettingsSchema, type Mode, type Settings } from "../settings/schema.js";
import { fail, ok, ToolRegistry, type Tool } from "../tools/registry.js";

const linux: PlatformInfo = describePlatform("linux", "x86_64", "Arch Linux");
const windows: PlatformInfo = describePlatform("windows", "x86_64", "Windows 11");

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "write_file",
    description: "Write a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    categories: ["file-write"],
    modes: ["code", "cowork"],
    execute: async () => ok("done"),
    ...overrides,
  };
}

function gateFor(settings: Settings, platform: PlatformInfo = linux): PermissionGate {
  return new PermissionGate(() => settings, { platform });
}

function withMode(mode: Mode, patch: Record<string, unknown>): Settings {
  return SettingsSchema.parse({ permissions: { [mode]: patch } });
}

const request = (mode: Mode, tool: Tool, args: Record<string, unknown>, workspace: string | null = "/ws") => ({
  mode,
  tool,
  args,
  workspace,
  conversationId: "c1",
  runId: "r1",
});

describe("glob matching", () => {
  it("keeps * inside one path segment and lets ** cross segments", () => {
    expect(globToRegExp("git *").test("git status")).toBe(true);
    expect(globToRegExp("git *").test("git log --oneline")).toBe(true);
    expect(globToRegExp("src/*").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
  });

  it("does not let a path * escape into a sibling directory", () => {
    expect(globToRegExp("**/secrets/*").test("/home/me/secrets/key.txt")).toBe(true);
    expect(globToRegExp("/ws/*").test("/ws-secrets/key.txt")).toBe(false);
    expect(globToRegExp("*secrets*").test("/home/me/secrets/key.txt")).toBe(false);
  });

  it("lets command globs cross separators so a wrapper cannot hide the command", () => {
    expect(globToRegExp("*rm -rf*", { crossSeparators: true }).test("sudo rm -rf /")).toBe(true);
    expect(globToRegExp("*rm -rf*").test("sudo rm -rf /")).toBe(false);
  });

  it("treats a bare entry as a word-prefix so `git` covers every subcommand", () => {
    expect(matchesAnyGlob("git push", ["git"])).toBe(true);
    expect(matchesAnyGlob("ls", ["git"])).toBe(false);
    expect(matchesAnyGlob("gitk --help", ["git"])).toBe(false);
  });

  it("never matches when the list is empty", () => {
    expect(matchesAnyGlob("anything", [])).toBe(false);
  });
});

describe("PermissionGate", () => {
  it("defaults to ask on first launch", () => {
    const gate = gateFor(DEFAULT_SETTINGS);
    const outcome = gate.check(request("code", makeTool(), { path: "src/a.ts" }));
    expect(outcome.decision).toBe("ask");
    expect(DEFAULT_SETTINGS.permissions.code.level).toBe("ask");
    expect(DEFAULT_SETTINGS.permissions.cowork.level).toBe("ask");
    expect(DEFAULT_SETTINGS.permissions.chat.level).toBe("ask");
    expect(DEFAULT_SETTINGS.telemetryEnabled).toBe(false);
  });

  it("allows read-only tools without asking in auto-accept", () => {
    const settings = withMode("code", { level: "auto-accept" });
    const gate = gateFor(settings);
    const read = makeTool({ name: "read_file", categories: ["file-write"], execute: async () => ok("x") });
    expect(gate.check(request("code", read, { path: "src/a.ts" })).decision).toBe("allow");
  });

  it("denies every mutating tool in plan mode", () => {
    const settings = withMode("code", { level: "plan" });
    const gate = gateFor(settings);
    const outcome = gate.check(request("code", makeTool(), { path: "src/a.ts" }));
    expect(outcome.decision).toBe("deny");
    expect(outcome.rule).toBe("plan_mode");

    const read = makeTool({ name: "read_file", execute: async () => ok("x") });
    expect(gate.check(request("code", read, { path: "src/a.ts" })).decision).toBe("allow");
  });

  it("honours the deny list even in bypass", () => {
    const settings = withMode("code", { level: "bypass" });
    const gate = gateFor(settings);
    const bash = makeTool({ name: "bash", categories: ["bash"], execute: async () => ok("x") });
    const outcome = gate.check(request("code", bash, { command: "rm -rf / --no-preserve-root" }));
    expect(outcome.decision).toBe("deny");
    expect(outcome.rule).toBe("denied_command");
  });

  it("cannot hide a denied command behind a wrapper or extra flags", () => {
    const settings = withMode("code", { level: "bypass" });
    const gate = gateFor(settings);
    const bash = makeTool({ name: "bash", categories: ["bash"], execute: async () => ok("x") });
    for (const command of [
      "rm -rf /",
      "rm -rf / --no-preserve-root",
      "sudo rm -rf /",
      "sudo -n rm -rf /",
      "sh -c 'rm -rf /'",
      "rm  -rf  /",
    ]) {
      expect(gate.check(request("code", bash, { command })).decision, command).toBe("deny");
    }
  });

  it("still allows a harmless command in bypass", () => {
    const settings = withMode("code", { level: "bypass" });
    const gate = gateFor(settings);
    const bash = makeTool({ name: "bash", categories: ["bash"], execute: async () => ok("x") });
    expect(gate.check(request("code", bash, { command: "pnpm test" })).decision).toBe("allow");
  });

  it("allows everything else in bypass", () => {
    const settings = withMode("code", { level: "bypass" });
    const gate = gateFor(settings);
    const bash = makeTool({ name: "bash", categories: ["bash"], execute: async () => ok("x") });
    expect(gate.check(request("code", bash, { command: "npm test" })).decision).toBe("allow");
  });

  it("keeps tool paths inside the workspace", () => {
    const settings = withMode("code", { level: "bypass" });
    const gate = gateFor(settings);
    const inside = gate.check(request("code", makeTool(), { path: "src/a.ts" }, "/ws"));
    expect(inside.decision).toBe("allow");

    const outside = gate.check(request("code", makeTool(), { path: "/etc/passwd" }, "/ws"));
    expect(outside.decision).toBe("deny");
    expect(outside.rule).toBe("outside_workspace");
  });

  it("understands Windows paths and case-insensitive comparison", () => {
    const settings = withMode("code", { level: "bypass" });
    const gate = gateFor(settings, windows);
    const outcome = gate.check(
      request("code", makeTool(), { path: "C:\\Users\\Me\\Proj\\src\\a.ts" }, "c:\\users\\me\\proj"),
    );
    expect(outcome.decision).toBe("allow");
  });

  it("denies paths on the deny list before the workspace check", () => {
    const settings = withMode("code", { level: "bypass", deniedPaths: ["/ws/secrets"] });
    const gate = gateFor(settings);
    const outcome = gate.check(request("code", makeTool(), { path: "/ws/secrets/key.txt" }, "/ws"));
    expect(outcome.decision).toBe("deny");
    expect(outcome.rule).toBe("denied_path");
  });

  it("filters domains", () => {
    const settings = withMode("cowork", { level: "bypass", deniedDomains: ["*.bank.com"] });
    const gate = gateFor(settings);
    const fetch = makeTool({ name: "web_fetch", categories: ["network"], execute: async () => ok("x") });
    expect(gate.check(request("cowork", fetch, { url: "https://login.bank.com/x" })).decision).toBe("deny");
    expect(gate.check(request("cowork", fetch, { url: "https://example.com/x" })).decision).toBe("allow");
  });

  it("auto-approves per category", () => {
    const settings = withMode("cowork", { level: "ask", autoApprove: { browser: true } });
    const gate = gateFor(settings);
    const browser = makeTool({ name: "click", categories: ["browser"], execute: async () => ok("x") });
    expect(gate.check(request("cowork", browser, { selector: "#go" })).decision).toBe("allow");

    const file = makeTool({ name: "write_file", categories: ["file-write"], execute: async () => ok("x") });
    expect(gate.check(request("cowork", file, { path: "a.txt" })).decision).toBe("ask");
  });

  it("auto-accepts edits but still asks for commands", () => {
    const settings = withMode("code", { level: "auto-accept" });
    const gate = gateFor(settings);
    expect(gate.check(request("code", makeTool(), { path: "a.ts" })).decision).toBe("allow");
    const bash = makeTool({ name: "bash", categories: ["bash"], execute: async () => ok("x") });
    expect(gate.check(request("code", bash, { command: "npm test" })).decision).toBe("ask");
  });

  it("reads settings on every call so a mid-task change takes effect", () => {
    let settings = DEFAULT_SETTINGS;
    const gate = new PermissionGate(() => settings, { platform: linux });
    const tool = makeTool();
    expect(gate.check(request("code", tool, { path: "a.ts" })).decision).toBe("ask");
    settings = withMode("code", { level: "bypass" });
    expect(gate.check(request("code", tool, { path: "a.ts" })).decision).toBe("allow");
  });

  it("offers an allow-list suggestion for commands", () => {
    const gate = gateFor(DEFAULT_SETTINGS);
    const bash = makeTool({
      name: "bash",
      categories: ["bash"],
      execute: async () => ok("x"),
      allowSuggestion: (args) => (typeof args.command === "string" ? args.command : null),
    });
    const outcome = gate.check(request("code", bash, { command: "pnpm test" }));
    expect(outcome.allowSuggestion).toBe("pnpm test");
  });
});

describe("ToolRegistry", () => {
  it("registers, lists, and filters by mode", () => {
    const registry = new ToolRegistry()
      .register(makeTool({ name: "read_file" }))
      .register(makeTool({ name: "click", modes: ["cowork"], categories: ["browser"] }));

    expect(registry.size).toBe(2);
    expect(registry.names("code")).toEqual(["read_file"]);
    expect(registry.names("cowork")).toEqual(["read_file", "click"]);
    expect(registry.names("chat")).toEqual([]);
  });

  it("refuses duplicate names", () => {
    const registry = new ToolRegistry().register(makeTool());
    expect(() => registry.register(makeTool())).toThrow(/already registered/);
  });

  it("produces provider-neutral specs", () => {
    const specs = new ToolRegistry().register(makeTool()).specs("code");
    expect(specs[0]).toEqual({ name: "write_file", description: "Write a file", parameters: expect.any(Object) });
  });

  it("can be disabled and re-enabled", () => {
    const registry = new ToolRegistry().register(makeTool());
    registry.setEnabled("write_file", false);
    expect(registry.has("write_file")).toBe(false);
    registry.setEnabled("write_file", true);
    expect(registry.has("write_file")).toBe(true);
  });
});

describe("tool results", () => {
  it("distinguishes failures from successes", () => {
    expect(ok("fine").isError).toBeUndefined();
    expect(fail("broken").isError).toBe(true);
  });
});
