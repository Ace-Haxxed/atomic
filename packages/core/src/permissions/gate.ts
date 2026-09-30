/**
 * The single permission gate.
 *
 * Every tool call in every mode goes through `PermissionGate.check`. There is no
 * second path. The gate reads the *current* settings on every call, so changing
 * a permission level mid-task takes effect immediately.
 *
 * Decision order (first match wins):
 *   1. plan mode       -> only read-only tools, everything else is denied
 *   2. deny list      -> denied, even in bypass
 *   3. not in workspace -> denied
 *   4. allow list     -> allowed
 *   5. level          -> ask | auto-accept | bypass
 *   6. category auto-approve
 */

import { globToRegExp, matchesAnyGlob } from "./glob.js";
import {
  basename,
  isPathInside,
  normalizePath,
  resolvePath,
} from "../platform/paths.js";
import type { PlatformInfo } from "../platform/platform.js";
import type { Tool } from "../tools/registry.js";
import type { Mode, PermissionLevel, Settings, ToolCategory } from "../settings/schema.js";

export const DECISIONS = ["allow", "ask", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];

export interface PermissionRequest {
  readonly mode: Mode;
  readonly tool: Tool;
  readonly args: Record<string, unknown>;
  /** Absolute workspace root, or null when the mode is unconstrained. */
  readonly workspace: string | null;
  /**
   * Folders the user authorized in Settings, outside the workspace.
   *
   * Needed here for the same reason the host needs them: containment is enforced
   * twice, in this gate and again in the Rust resolver, and a path allowed by
   * only one of the two is still refused. Without this, authorizing a folder
   * would change nothing and the refusal would arrive with a reason -- "outside
   * the workspace" -- that points at the wrong layer.
   */
  readonly extraRoots?: readonly string[];
  readonly conversationId: string;
  readonly runId: string;
}

export interface PermissionOutcome {
  readonly decision: Decision;
  /** One-line explanation shown under the approval prompt. */
  readonly reason: string;
  /** The rule that produced the decision, for the audit log. */
  readonly rule: string;
  /** A value the user can add to the allow-list if they pick "always". */
  readonly allowSuggestion?: string;
}

/**
 * Tools that never mutate the user's project, and so are safe in plan mode and
 * in ask mode.
 *
 * `todo_write` belongs here even though it writes: it writes the agent's own
 * task list, not a file the user cares about, and a plan the model cannot
 * record is not a plan. The user's files are what plan mode protects.
 */
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_files",
  "glob",
  "grep",
  // One `git` tool, not three: it only ever runs status, diff, log and show.
  // The write half of git is not exposed to the model at all.
  "git",
  "web_search",
  "web_fetch",
  "todo_read",
  "todo_write",
  "memory_read",
]);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

export interface GateOptions {
  readonly platform: PlatformInfo;
  /** Path of the command's first word, for command allow/deny lists. */
  readonly extractCommand?: (args: Record<string, unknown>) => string | null;
  readonly extractPath?: (args: Record<string, unknown>) => string | null;
  readonly extractUrl?: (args: Record<string, unknown>) => string | null;
}

export class PermissionGate {
  #settings: () => Settings;
  #platform: PlatformInfo;
  #options: GateOptions;

  constructor(settings: () => Settings, options: GateOptions) {
    this.#settings = settings;
    this.#platform = options.platform;
    this.#options = options;
  }

  check(request: PermissionRequest): PermissionOutcome {
    const settings = this.#settings();
    const policy = settings.permissions[request.mode];
    const tool = request.tool;
    const level = policy.level;

    // 1. Plan mode is read-only by definition.
    if (level === "plan" && !isReadOnlyTool(tool.name)) {
      return deny("plan_mode", "Plan mode only allows read-only tools.");
    }

    // 2. Explicit deny lists win over every other rule, including bypass.
    //    Matched against every word-aligned variant of the command so that
    //    `sudo rm -rf /` cannot slip past a `rm -rf /` deny entry.
    const command = this.#options.extractCommand?.(request.args) ?? commandLineFromArgs(request.args);
    const variants = command ? commandVariants(command) : [];
    if (variants.some((variant) => matchesAnyGlob(variant, policy.deniedCommands, COMMAND_GLOB))) {
      return deny("denied_command", `Command "${command}" is on the deny list.`);
    }

    const url = this.#options.extractUrl?.(request.args) ?? urlFromArgs(request.args);
    if (url) {
      const host = hostOf(url);
      if (host && matchesAnyGlob(host, policy.deniedDomains)) {
        return deny("denied_domain", `Domain "${host}" is on the deny list.`);
      }
    }

    const path = this.#options.extractPath?.(request.args) ?? pathFromArgs(request.args);
    const resolvedPath = path ? this.#resolve(path, request.workspace) : null;
    if (resolvedPath) {
      for (const denied of policy.deniedPaths) {
        const deniedPath = this.#resolve(denied, request.workspace);
        if (deniedPath && isPathInside(resolvedPath, deniedPath, this.#platform)) {
          return deny("denied_path", `"${basename(resolvedPath, this.#platform)}" is inside a denied path.`);
        }
      }
    }

    // 3. Containment. Scoped modes must not escape the chosen folder -- or any
    //    folder the user added to it deliberately. A path is authorized when it
    //    is inside the workspace *or* inside one of the extra roots; a path
    //    inside neither is refused here and again by the host, and the reason
    //    says which folders were actually open so the user can be told what to
    //    add rather than left guessing.
    if (path && resolvedPath) {
      const roots = [request.workspace, ...(request.extraRoots ?? [])].filter(
        (root): root is string => typeof root === "string" && root.length > 0,
      );
      if (roots.length > 0) {
        const inside = roots.some((root) => isPathInside(resolvedPath, root, this.#platform));
        if (!inside) {
          const open = roots.map((root) => `"${root}"`).join(", ");
          return deny(
            "outside_workspace",
            `"${resolvedPath}" is outside every folder this conversation may use (${open}). ` +
              `To use another folder, add it under Settings > Files.`,
          );
        }
      }
    }

    // 4. Allow lists.
    if (variants.some((variant) => matchesAnyGlob(variant, policy.allowedCommands, COMMAND_GLOB))) {
      return allow("allowed_command", `"${command}" is on the allow list.`);
    }
    if (url) {
      const host = hostOf(url);
      if (host && matchesAnyGlob(host, policy.allowedDomains)) {
        return allow("allowed_domain", `"${host}" is on the allow list.`);
      }
    }
    if (resolvedPath) {
      for (const allowed of policy.allowedPaths) {
        const allowedPath = this.#resolve(allowed, request.workspace);
        if (allowedPath && isPathInside(resolvedPath, allowedPath, this.#platform)) {
          return allow("allowed_path", "Path is inside an allowed folder.");
        }
      }
    }

    // 5. Level.
    if (level === "bypass") {
      return allow("bypass", "Permissions are bypassed for this mode.");
    }

    if (isReadOnlyTool(tool.name) && level !== "ask") {
      return allow("read_only", "Read-only tools do not need approval.");
    }

    // 6. Per-category auto-approve.
    for (const category of tool.categories) {
      if (autoApproved(policy.autoApprove, category)) {
        return allow(`auto_${category}`, `${category} actions are auto-approved for this mode.`);
      }
    }

    // 7. Auto-accept covers file edits only. Shell, network, browser and MCP
    //    calls can leave the machine in a state the user cannot see, so they
    //    still prompt. Bypass is the level that stops asking.
    if (level === "auto-accept") {
      if (tool.categories.every((category) => category === "file-write")) {
        return allow("auto_accept", "This mode auto-accepts file edits.");
      }
      return askFor(
        request,
        tool,
        `Auto-accept only covers file edits; \`${tool.name}\` still needs approval.`,
      );
    }

    return askFor(request, tool, describeCall(tool.name, request.args));
  }

  #resolve(path: string, workspace: string | null): string | null {
    if (!path) return null;
    return resolvePath(this.#platform, workspace ?? ".", path);
  }
}

function autoApproved(autoApprove: Record<string, boolean>, category: ToolCategory): boolean {
  // Reads are never auto-approved by category. `isReadOnlyTool` already allows
  // them outright, and a per-category toggle here would only create a second,
  // contradictory way to decide the same question.
  if (category === "file-read") return false;
  const key: Record<ToolCategory, keyof typeof autoApprove | ""> = {
    "file-read": "",
    "file-write": "fileWrite",
    bash: "bash",
    browser: "browser",
    network: "network",
    mcp: "mcp",
  };
  return autoApprove[key[category]] === true;
}

function deny(rule: string, reason: string): PermissionOutcome {
  return { decision: "deny", reason, rule };
}

function allow(rule: string, reason: string): PermissionOutcome {
  return { decision: "allow", reason, rule };
}

/** Command globs may span `/`: `*rm -rf*` has to match `sudo rm -rf /`. */
const COMMAND_GLOB = { crossSeparators: true } as const;

function askFor(
  request: PermissionRequest,
  tool: Tool,
  reason: string,
): PermissionOutcome {
  const suggestion =
    tool.allowSuggestion?.(request.args as never) ??
    commandLineFromArgs(request.args) ??
    urlFromArgs(request.args) ??
    pathFromArgs(request.args) ??
    undefined;
  return {
    decision: "ask",
    reason,
    rule: "ask",
    ...(suggestion ? { allowSuggestion: suggestion } : {}),
  };
}

/** The full command line, e.g. `sudo rm -rf / --no-preserve-root`. */
function commandLineFromArgs(args: Record<string, unknown>): string | null {
  const command = args.command ?? args.cmd;
  if (typeof command !== "string") return null;
  const trimmed = command.trim();
  return trimmed ? trimmed : null;
}

/**
 * Every string a deny/allow entry could reasonably be written against: the
 * whole line, and each word-aligned tail. Comparing all tails is what stops
 * `sudo -n rm -rf /` from slipping past a `rm -rf /` deny entry, and it costs
 * nothing on the allow side because entries match by prefix there.
 */
export function commandVariants(command: string): string[] {
  const normalized = command.replace(/["']/g, "");
  const out = new Set<string>([normalized]);
  // Long scripts are capped so a runaway tool argument cannot blow up memory.
  const words = normalized.split(/\s+/).filter(Boolean).slice(0, 64);
  for (let i = 0; i < words.length; i++) {
    out.add(words.slice(i).join(" "));
  }
  return [...out].filter(Boolean);
}

function pathFromArgs(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file", "filePath", "target"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function urlFromArgs(args: Record<string, unknown>): string | null {
  for (const key of ["url", "href"]) {
    const value = args[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  }
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function describeCall(name: string, args: Record<string, unknown>): string {
  const command = commandLineFromArgs(args);
  if (command) return `Run \`${command}\``;
  const path = pathFromArgs(args);
  if (path) return `Access \`${path}\``;
  const url = urlFromArgs(args);
  if (url) return `Request ${url}`;
  return `Run tool \`${name}\``;
}

/** Lazily imported to keep this module free of a cycle with `paths.ts`. */
export { globToRegExp, normalizePath };
