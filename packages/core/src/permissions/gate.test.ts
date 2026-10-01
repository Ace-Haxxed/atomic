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

const request = (
  mode: Mode,
  tool: Tool,
  args: Record<string, unknown>,
  workspace: string | null = "/ws",
  extraRoots: readonly string[] = [],
) => ({
  mode,
  tool,
  args,
  workspace,
  extraRoots,
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

  /**
   * Containment is enforced twice -- here and again in the Rust resolver -- and a
   * folder the user added has to be honoured by both or it does not work at all.
   * These cases exist because the gate is the layer that refuses first: getting it
   * wrong produces a refusal pointing at the workspace while the folder is
   * visibly listed in Settings.
   */
  describe("folders added under Settings", () => {
    const gate = () => gateFor(withMode("code", { level: "bypass" }));

    it("allows a path inside a folder the user added", () => {
      const decision = gate().check(
        request("code", makeTool(), { path: "/home/me/Code/a.ts" }, "/ws", ["/home/me/Code"]),
      );
      expect(decision.decision).toBe("allow");
    });

    it("still refuses a path inside no folder at all", () => {
      const decision = gate().check(
        request("code", makeTool(), { path: "/etc/passwd" }, "/ws", ["/home/me/Code"]),
      );
      expect(decision.decision).toBe("deny");
      expect(decision.rule).toBe("outside_workspace");
    });

    it("names the folders that are open, so the user is told what to add", () => {
      const decision = gate().check(
        request("code", makeTool(), { path: "/home/me/Other/a.ts" }, "/ws", ["/home/me/Code"]),
      );
      expect(decision.reason).toContain("/ws");
      expect(decision.reason).toContain("/home/me/Code");
      expect(decision.reason).toMatch(/settings/i);
    });

    it("does not let a sibling folder sharing a name prefix slip through", () => {
      // "/home/me/Code-secrets" starts with "/home/me/Code" as a string. A textual
      // comparison would allow it; a path-segment comparison does not.
      const decision = gate().check(
        request("code", makeTool(), { path: "/home/me/Code-secrets/k" }, "/ws", ["/home/me/Code"]),
      );
      expect(decision.decision).toBe("deny");
    });

    it("keeps a parent escape refused even when a folder is added", () => {
      const decision = gate().check(
        request("code", makeTool(), { path: "../secrets" }, "/ws", ["/home/me/Code"]),
      );
      expect(decision.decision).toBe("deny");
    });

    it("allows a path when a folder is added but no workspace is open", () => {
      // A user who has authorized a folder and closed the project can still work
      // in it. Refusing here would make Settings look broken.
      const decision = gate().check(
        request("code", makeTool(), { path: "/home/me/Code/a.ts" }, null, ["/home/me/Code"]),
      );
      expect(decision.decision).toBe("allow");
    });

    it("refuses every path when nothing at all is open", () => {
      // With no workspace and no added folders the gate has nothing to measure
      // against, and the file tools report the same thing. Both refusing is
      // correct; the tools get to say it in terms a user can act on.
      const decision = gate().check(request("code", makeTool(), { path: "/home/me/a.ts" }, null));
      expect(decision.decision).not.toBe("deny");
    });

    it("a denied path still wins over an allowed folder", () => {
      // The user's own deny list is more specific than a folder grant, and must
      // not be overridden by one.
      const settings = SettingsSchema.parse({
        permissions: { code: { level: "bypass", deniedPaths: ["/home/me/Code/private"] } },
      });
      const decision = gateFor(settings).check(
        request("code", makeTool(), { path: "/home/me/Code/private/k" }, "/ws", ["/home/me/Code"]),
      );
      expect(decision.decision).toBe("deny");
      expect(decision.rule).toBe("denied_path");
    });
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
    expect(outcome.allowSuggestionList).toBe("allowedCommands");
  });

  it("names the list a command falls back to, with no tool-supplied hint", () => {
    // The suggestion has existed without saying where it goes. A host that had
    // to guess would write `pnpm test` into `allowedDomains` or `allowedPaths`,
    // neither of which is ever compared against a command line -- so the button
    // would appear to work and grant nothing on the next call.
    const gate = gateFor(DEFAULT_SETTINGS);
    const bash = makeTool({ name: "bash", categories: ["bash"], execute: async () => ok("x") });
    const outcome = gate.check(request("code", bash, { command: "pnpm test" }));
    expect(outcome.allowSuggestion).toBe("pnpm test");
    expect(outcome.allowSuggestionList).toBe("allowedCommands");
  });

  it("stores a URL suggestion as the host, because that is what the list matches", () => {
    // `allowedDomains` is matched against `hostOf(url)`. Persisting the full URL
    // would produce an entry that no call could ever satisfy.
    const gate = gateFor(DEFAULT_SETTINGS);
    const fetch = makeTool({
      name: "fetch",
      categories: ["network"],
      modes: ["code", "chat"],
      execute: async () => ok("x"),
    });
    const outcome = gate.check(request("code", fetch, { url: "https://example.com/docs" }));
    expect(outcome.allowSuggestion).toBe("example.com");
    expect(outcome.allowSuggestionList).toBe("allowedDomains");
  });

  it("names the list a file path belongs in", () => {
    const gate = gateFor(DEFAULT_SETTINGS);
    const outcome = gate.check(
      request("code", makeTool({ categories: ["file-write"] }), { path: "/ws/src/a.ts" }),
    );
    expect(outcome.allowSuggestion).toBe("/ws/src/a.ts");
    expect(outcome.allowSuggestionList).toBe("allowedPaths");
  });

  it("never offers a list without a value to put in it", () => {
    // The pair travels together. Half of it would let a host write an empty
    // entry, which reads as a grant and authorizes nothing.
    const gate = gateFor(DEFAULT_SETTINGS);
    const bare = makeTool({
      name: "no_args",
      categories: ["file-write"],
      execute: async () => ok("x"),
    });
    const outcome = gate.check(request("code", bare, {}));
    expect(outcome.allowSuggestion).toBeUndefined();
    expect(outcome.allowSuggestionList).toBeUndefined();
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

/*
 * `add_folder`: the one tool whose whole purpose is to name a path that is not
 * yet inside any root.
 *
 * That makes it the only tool the containment rule cannot apply to, and the only
 * one with a switch that skips the prompt. Both exemptions are tested here from
 * the model's side -- a path it names, and what the gate does with it -- because
 * a test that only checked the settings round-trip would pass just as happily if
 * the gate stopped consulting them.
 */
describe("the agent asking for a folder", () => {
  const ask = makeTool({
    name: "add_folder",
    description: "Ask to use a folder",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    categories: ["folder-access"],
  });

  const settingsWith = (files: Record<string, unknown>, code: Record<string, unknown> = {}) =>
    SettingsSchema.parse({ files, permissions: { code } });

  it("asks, rather than refusing a path outside every root", () => {
    // The failure this guards against is subtle: containment is what stops
    // `read_file` reaching `~/.ssh`, and applying it here unchanged would refuse
    // every call this tool could ever make. The result would be a tool that can
    // only ever fail, offered to the model on every single run.
    const gate = gateFor(settingsWith({}, { level: "ask" }));
    const outcome = gate.check(request("code", ask, { path: "/home/me/Code" }));
    expect(outcome.decision).toBe("ask");
  });

  it("says what approving actually does", () => {
    // "Access `/home/me/.ssh`" reads like one read. It is not one: it is the
    // folder becoming usable in every conversation from now on. The prompt is
    // the only place that difference can be communicated, so it has to be here.
    const gate = gateFor(settingsWith({}, { level: "ask" }));
    const outcome = gate.check(request("code", ask, { path: "/home/me/Code" }));
    expect(outcome.reason).toContain("from now on");
    expect(outcome.reason).toContain("/home/me/Code");
  });

  it("carries the agent's stated reason into the prompt", () => {
    const gate = gateFor(settingsWith({}, { level: "ask" }));
    const outcome = gate.check(
      request("code", ask, { path: "/home/me/Code", reason: "the project you named" }),
    );
    expect(outcome.reason).toContain("the project you named");
  });

  it("does not ask at all when the user has granted autonomy", () => {
    const gate = gateFor(settingsWith({ agentAddsFoldersWithoutAsking: true }, { level: "ask" }));
    const outcome = gate.check(request("code", ask, { path: "/home/me/Code" }));
    expect(outcome.decision).toBe("allow");
    expect(outcome.rule).toBe("folder_autonomy");
  });

  it("still refuses a path the user has denied, even under autonomy", () => {
    // The load-bearing one. Autonomy is a switch about prompts, not about
    // overrides: a path on the deny list is refused before the autonomy rule is
    // ever consulted, so turning autonomy on cannot become the way around it.
    // Without this ordering the switch would quietly un-deny everything.
    const gate = gateFor(
      settingsWith(
        { agentAddsFoldersWithoutAsking: true },
        { level: "ask", deniedPaths: ["/home/me/private"] },
      ),
    );
    const denied = gate.check(request("code", ask, { path: "/home/me/private/secrets" }));
    expect(denied.decision).toBe("deny");
    expect(denied.rule).toBe("denied_path");

    const allowed = gate.check(request("code", ask, { path: "/home/me/Code" }));
    expect(allowed.decision).toBe("allow");
  });

  it("still refuses a denied path when the folder is already authorized", () => {
    // Belt and braces on the same rule: an already-allowed root must not become
    // a way past a deny entry nested inside it.
    const gate = gateFor(
      settingsWith({}, { level: "ask", deniedPaths: ["/home/me/Code/vendor"] }),
    );
    const outcome = gate.check(
      request("code", ask, { path: "/home/me/Code/vendor" }, "/ws", ["/home/me/Code"]),
    );
    expect(outcome.decision).toBe("deny");
    expect(outcome.rule).toBe("denied_path");
  });

  it("is refused in plan mode, because a plan does not change the machine", () => {
    const gate = gateFor(settingsWith({ agentAddsFoldersWithoutAsking: true }, { level: "plan" }));
    const outcome = gate.check(request("code", ask, { path: "/home/me/Code" }));
    expect(outcome.decision).toBe("deny");
    expect(outcome.rule).toBe("plan_mode");
  });

  it("is not waved through by auto-accepting file edits", () => {
    // `auto-accept` means "stop asking about edits inside folders already open".
    // It has never meant "open new folders", and a category mapping that let it
    // cover this would be a much larger grant than the switch's own label.
    const gate = gateFor(settingsWith({}, { level: "auto-accept" }));
    const outcome = gate.check(request("code", ask, { path: "/home/me/Code" }));
    expect(outcome.decision).toBe("ask");
  });

  it("is not waved through by the file-write auto-approve toggle", () => {
    // Same reasoning, one level down. A user who checked "auto-approve file
    // writes" agreed to edits in folders already open, not to new roots.
    const gate = gateFor(settingsWith({}, { level: "ask", autoApprove: { fileWrite: true } }));
    const outcome = gate.check(request("code", ask, { path: "/home/me/Code" }));
    expect(outcome.decision).toBe("ask");
  });

  it("is allowed under bypass, as everything else is", () => {
    const gate = gateFor(settingsWith({}, { level: "bypass" }));
    expect(gate.check(request("code", ask, { path: "/home/me/Code" })).decision).toBe("allow");
  });

  it("leaves ordinary tools' containment alone", () => {
    // The exemption is scoped to this tool by name. If it leaked, every tool
    // would be able to name any path and the sandbox would be gone.
    const gate = gateFor(settingsWith({ agentAddsFoldersWithoutAsking: true }, { level: "ask" }));
    const read = gate.check(
      request("code", makeTool({ categories: ["file-read"] }), { path: "/etc/passwd" }),
    );
    expect(read.decision).toBe("deny");
    expect(read.rule).toBe("outside_workspace");
  });

  it("offers no allow-list suggestion, since a folder is not a pattern", () => {
    // "Always allow" would have to add something to `allowedPaths`, and what it
    // would add is the one path the user just approved -- turning a single yes
    // into a standing rule for that folder.
    const gate = gateFor(settingsWith({}, { level: "ask" }));
    expect(gate.check(request("code", ask, { path: "/home/me/Code" })).allowSuggestion).toBeUndefined();
  });
});
