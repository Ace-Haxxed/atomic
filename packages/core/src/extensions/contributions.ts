/**
 * Turning a manifest's tool declarations into tools the loop can call.
 *
 * This is where "extensions and built-ins use the same capability system" either
 * becomes true or does not. The answer is that a contributed tool is a `Tool`,
 * registered in the same `ToolRegistry` as `bash` and `read_file`, with the same
 * permission categories, the same gate, the same approval cards and the same
 * audit rows. Nothing downstream can tell which came from a manifest, which is
 * the point: a second permission path for extensions would be a second thing to
 * get wrong, and this codebase has already spent several rounds fixing places
 * where an assumption was made in one path and not the other.
 *
 * The one thing a manifest cannot supply is the function that does the work.
 * A manifest is data, so the code comes from a resolver the app already trusts --
 * a built-in module, or (in the connections step) an MCP server the user
 * configured. A declared tool with no implementation is therefore *not* an error
 * to paper over: it is reported, and its absence is visible, because the failure
 * mode of quietly registering a tool that returns an empty string is a model
 * confidently reporting that it did something.
 */

import type { Tool, ToolContext, ToolResult } from "../tools/registry.js";
import type { AllowList } from "../permissions/gate.js";
import type { ToolDeclaration, ExtensionManifest } from "./manifest.js";

/**
 * The code behind a declared tool.
 *
 * The argument type is `unknown` rather than a generic: a tool arrives from a
 * schema the app did not write, so there is no compile-time argument type to
 * check against, and pretending otherwise with a cast would put the cast at the
 * gate's input rather than at the edge where the model actually gets to invent
 * values. Implementations validate their own arguments.
 */
export interface ToolImplementation {
  readonly execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
  /**
   * Validate and coerce the raw arguments.
   *
   * Optional because the manifest's JSON Schema is a description for the model,
   * not a validator: it is not guaranteed to be expressible in zod, and a tool
   * with no validator must coerce or reject before touching anything. Tools that
   * do declare one get the same parse-then-execute treatment a built-in has.
   */
  readonly parse?: Tool["parse"];
}

/**
 * Supplies implementations by tool name.
 *
 * A function rather than a map so an implementation can be conditional on host
 * state -- an MCP server that is not connected resolves nothing, and the tool is
 * then reported unavailable rather than registered with an error inside it.
 */
export type ImplementationResolver = (
  toolName: string,
  manifest: ExtensionManifest,
) => ToolImplementation | undefined;

export interface ContributionResult {
  readonly tools: Tool[];
  /** Declared tools with no implementation behind them. */
  readonly unimplemented: readonly string[];
}

const ALLOW_LIST_FOR: Record<
  NonNullable<ToolDeclaration["allowSuggestion"]>["kind"],
  AllowList
> = {
  command: "allowedCommands",
  domain: "allowedDomains",
  path: "allowedPaths",
};

/**
 * Read the value a tool wants to allow, from the argument the manifest named.
 *
 * Coerced to a string here rather than passed through, because an allow-list is a
 * list of strings and an entry that is a number never matches anything: an
 * "always allow" that silently does nothing is the failure the previous commit
 * removed, and this is the same failure with a new shape.
 */
function suggestionValue(
  args: Record<string, unknown>,
  declaration: ToolDeclaration,
): string | null {
  const from = declaration.allowSuggestion?.from;
  if (!from) return null;
  const raw = args[from];
  if (typeof raw === "string" && raw.trim().length > 0) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

/**
 * The `Tool` for one declared tool, or undefined when it has no implementation.
 *
 * Returns undefined rather than a refusing tool on purpose. A registered tool
 * that always fails is worse than an absent one: a model offered a tool keeps
 * reaching for it, and an absent tool it has never heard of moves on.
 */
export function toolFromDeclaration(
  manifest: ExtensionManifest,
  declaration: ToolDeclaration,
  resolve: ImplementationResolver,
): Tool | undefined {
  const implementation = resolve(declaration.name, manifest);
  if (!implementation) return undefined;

  const parse = implementation.parse;
  return {
    name: declaration.name,
    description: declaration.description,
    parameters: declaration.parameters,
    categories: declaration.categories,
    modes: declaration.modes,
    // Present only when the implementation can validate. Declaring a parse step
    // that can then be skipped would be worse than not having one, so the
    // adapter exposes it exactly when there is something behind it.
    ...(parse ? { parse: (args: unknown) => parse(args) } : {}),
    async execute(rawArgs: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      // Validated before anything else touches them. The gate has already asked
      // the user about this call, so an implementation that ran on unvalidated
      // arguments would act on a decision the user never saw the inputs to.
      const args = parse ? parse(rawArgs) : rawArgs;
      return implementation.execute(args, context);
    },
    // The kind comes from the manifest, so the gate files the value in the list
    // that is actually matched against it. Left off entirely when the tool
    // declares no suggestion, rather than present and returning null: a built-in
    // tool without one has no such member at all, and the two should look alike
    // to everything downstream.
    ...(declaration.allowSuggestion
      ? {
          allowSuggestion: (args: Record<string, unknown>) => suggestionValue(args, declaration),
          allowSuggestionKind: declaration.allowSuggestion.kind,
        }
      : {}),
  };
}

/** The allow-list a declared tool's suggestion belongs in, for the host to write to. */
export function allowListFor(
  declaration: ToolDeclaration,
): AllowList | undefined {
  return declaration.allowSuggestion ? ALLOW_LIST_FOR[declaration.allowSuggestion.kind] : undefined;
}

/**
 * Build every tool an enabled manifest contributes.
 *
 * The order is the manifest's own, so a settings list and a model-facing tool
 * list agree on which tool is "first" -- otherwise a user comparing the two has
 * no way to line them up.
 */
export function contributeTools(
  manifest: ExtensionManifest,
  resolve: ImplementationResolver,
): ContributionResult {
  const tools: Tool[] = [];
  const unimplemented: string[] = [];
  for (const declaration of manifest.contributions.tools) {
    const tool = toolFromDeclaration(manifest, declaration, resolve);
    if (tool) tools.push(tool);
    else unimplemented.push(declaration.name);
  }
  return { tools, unimplemented };
}