/**
 * Tool registry.
 *
 * A tool is a name, a JSON Schema, and an execute function. Adding a tool means
 * implementing `Tool` and calling `registry.register` — nothing else changes.
 * Every tool declares the permission categories it touches so the single
 * permission gate can decide without a per-tool special case.
 */

import { z } from "zod";
import type { Mode, ToolCategory } from "../settings/schema.js";

export const TOOL_CALL_RESULT = "tool_result" as const;

export interface ToolContext {
  /** Conversation the call belongs to. */
  readonly conversationId: string;
  readonly messageId: string;
  readonly runId: string;
  readonly mode: Mode;
  readonly signal: AbortSignal;
  /** Absolute workspace root for file tools; null when the mode has no workspace. */
  readonly workspace: string | null;
  /**
   * Folders the user has authorized in addition to `workspace`.
   *
   * Kept separate from `workspace` rather than merged into it, because the
   * difference is meaningful: `workspace` is where this conversation is and every
   * relative path is measured from it, while these are somewhere else entirely
   * and only reachable by writing a full path. Anything that assumes a single
   * root -- process execution, git, checkpoints, project memory -- keeps using
   * `workspace` alone and cannot wander into them by accident.
   *
   * A function, because the list can grow while a run is in progress: the agent
   * may ask for a folder and the user may approve it, and the tool called after
   * that has to see it. A snapshot taken at the start of the run would leave the
   * agent holding an approval it cannot spend until the next message.
   */
  readonly extraRoots: () => readonly string[];
  /** Human-readable one-liner for the audit log and the UI card header. */
  readonly describe: (args: Record<string, unknown>) => string;
}

export interface ToolResult {
  /** Text handed back to the model. */
  readonly content: string;
  /** Optional structured payload for the UI (image, diff, timeline entry). */
  readonly display?: unknown;
  /** Set when the tool failed in a way the model should see and can recover from. */
  readonly isError?: boolean;
  /** When false, the result is truncated before reaching the model. */
  readonly large?: boolean;
}

export interface Tool<I = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments object. Keep it strict; models follow it. */
  readonly parameters: Record<string, unknown>;
  /** Permission categories this tool can trigger. */
  readonly categories: readonly ToolCategory[];
  /** Modes the tool is available in. */
  readonly modes: readonly Mode[];
  /** Validate + coerce raw args. Runs after the permission gate, before execute. */
  readonly parse?: (args: unknown) => z.ZodType<I>["_output"];
  execute(args: I, context: ToolContext): Promise<ToolResult>;
  /** Suggest a value for a permission allow-list entry, e.g. `git status`. */
  readonly allowSuggestion?: (args: I) => string | null;
  /**
   * Which allow-list `allowSuggestion` names, and how the gate should read it.
   *
   * Absent means a command, which is every built-in tool's case. It has to be
   * declared rather than inferred from the value, because the three lists are
   * matched differently -- one against a command line, one against a host name,
   * one against a path -- so a value filed under the wrong one is a standing
   * grant that no later call can satisfy. A contributed tool says which it is in
   * its manifest and the gate does the rest.
   */
  readonly allowSuggestionKind?: "command" | "domain" | "path";
}

export interface ToolEntry {
  readonly tool: Tool;
  readonly enabled: boolean;
}

export class ToolRegistry {
  #tools = new Map<string, Tool>();
  #disabled = new Set<string>();

  register(tool: Tool): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: readonly Tool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  unregister(name: string): boolean {
    this.#disabled.delete(name);
    return this.#tools.delete(name);
  }

  setEnabled(name: string, enabled: boolean): void {
    if (enabled) this.#disabled.delete(name);
    else this.#disabled.add(name);
  }

  get(name: string): Tool | undefined {
    if (this.#disabled.has(name)) return undefined;
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name) && !this.#disabled.has(name);
  }

  list(mode?: Mode): Tool[] {
    const all = [...this.#tools.values()].filter((tool) => !this.#disabled.has(tool.name));
    if (!mode) return all;
    return all.filter((tool) => tool.modes.includes(mode));
  }

  names(mode?: Mode): string[] {
    return this.list(mode).map((tool) => tool.name);
  }

  /** Convert to the provider-neutral declaration the model sees. */
  specs(mode: Mode): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return this.list(mode).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  clear(): void {
    this.#tools.clear();
    this.#disabled.clear();
  }

  get size(): number {
    return this.#tools.size;
  }
}

/** Categories a tool touches, used by the permission gate. */
export function categoriesFor(registry: ToolRegistry, name: string): readonly ToolCategory[] {
  return registry.get(name)?.categories ?? ["network"];
}

export function ok(content: string, display?: unknown): ToolResult {
  return { content, ...(display === undefined ? {} : { display }) };
}

export function fail(content: string): ToolResult {
  return { content, isError: true };
}
