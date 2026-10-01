/**
 * The built-in capability, expressed as a manifest.
 *
 * Built as data *from* the real `Tool` objects rather than written out beside
 * them. The obvious alternative -- a hand-written manifest listing the same ten
 * tools with the same descriptions -- is a second source of truth that starts
 * correct and decays: a description edited in the tool would silently not reach
 * the manifest, and the settings UI would tell the user one thing while the model
 * is told another. Deriving it means the two cannot disagree, and the "built-ins
 * and extensions use one path" requirement is met without a drift test to
 * maintain.
 *
 * What cannot be derived is which allow-list a tool's "always allow" value
 * belongs in, because that depends on what the tool does with its arguments. So
 * it is inferred from the declared argument names, using the same precedence the
 * permission gate applies when it offers a suggestion: a command first, then a
 * URL, then a path. Getting this wrong is not silent -- a value written into the
 * wrong list never matches -- but it is now visible in the manifest a user can
 * read, instead of being buried in the tool's closure.
 */

import type { Tool } from "../tools/registry.js";
import { isFolderAccess, isReadOnlyTool } from "../permissions/gate.js";
import { ExtensionManifestSchema, type ExtensionManifest } from "./manifest.js";

/** Argument names that decide which allow-list a suggestion lands in, in order. */
const SUGGESTION_SOURCES = [
  { arg: "command", kind: "command" },
  { arg: "url", kind: "domain" },
  { arg: "path", kind: "path" },
] as const;

function suggestionFor(tool: Tool): { from: string; kind: "command" | "domain" | "path" } | undefined {
  const properties = Object.keys(
    (tool.parameters.properties as Record<string, unknown> | undefined) ?? {},
  );
  // Two kinds of tool are never suggested at all, and both reasons are the gate's
  // rather than this file's -- so they are imported rather than restated. Folder
  // access always asks, deliberately: a standing grant to any folder is not a
  // narrower thing than asking. A read-only tool is never asked in the first
  // place, so it has no prompt to attach a suggestion to, and declaring one would
  // describe a capability that does not exist.
  if (isFolderAccess(tool.name) || isReadOnlyTool(tool.name)) return undefined;

  const byName = SUGGESTION_SOURCES.find((source) => properties.includes(source.arg));

  // A tool that says what kind of value its suggestion is gets that kind. The
  // argument it reads is the one the gate will read too, so the two cannot end up
  // pointing at different values.
  if (tool.allowSuggestionKind) {
    const from = byName?.arg ?? properties[0];
    return from ? { from, kind: tool.allowSuggestionKind } : undefined;
  }

  // Otherwise inferred from the argument names, which is how the gate finds a
  // value as well: a `command` argument is a command, a `url` argument is a
  // domain, a `path` argument is a path. `bash` declares no `allowSuggestion` of
  // its own and is still suggestible -- the gate derives one from its `command`
  // argument -- so gating this on `allowSuggestion` would under-report what the
  // gate will actually offer, and the manifest would describe a smaller capability
  // than exists.
  return byName ? { from: byName.arg, kind: byName.kind } : undefined;
}

/**
 * The manifest for a set of built-in tools.
 *
 * `id` is passed in rather than derived, because grouping is a product decision:
 * file tools, shell and git are three capabilities a user might reasonably want
 * to switch off separately, and one manifest for all of them would make that
 * impossible. `defaultEnabled: true` because these are the app's reason for
 * existing -- an extension registry that shipped with the built-in tools off
 * would be a very literal reading of the rules.
 */
export function manifestForBuiltins(input: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly tools: readonly Tool[];
}): ExtensionManifest {
  return ExtensionManifestSchema.parse({
    id: input.id,
    name: input.name,
    description: input.description,
    icon: input.icon,
    publisher: "Atomic",
    version: "1.0.0",
    // Left empty on purpose: these run everywhere the app runs, and claiming a
    // narrower platform set would get them switched off elsewhere by their own
    // manifest.
    platforms: [],
    lifecycle: { requiresProcess: false, requiresCredential: false, lazy: true },
    defaultEnabled: true,
    defaultHidden: false,
    source: "builtin",
    contributions: {
      tools: input.tools.map((tool) => {
        const suggestion = suggestionFor(tool);
        return {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          categories: tool.categories,
          modes: tool.modes,
          ...(suggestion ? { allowSuggestion: suggestion } : {}),
        };
      }),
    },
  });
}

/**
 * The three built-in capabilities, split along the lines a user would split them.
 *
 * Read tools are separate from write tools on purpose: "let the agent look at my
 * project without changing it" is a real request, and expressing it as a toggle
 * on read tools makes it a switch rather than a setting buried in a list of
 * deny patterns. Git and the todo list are grouped with neither, because both are
 * read-only in this app's implementation and treating them as file access would
 * misdescribe what they do.
 */
export function builtinCapabilities(tools: readonly Tool[]): {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly tools: Tool[];
}[] {
  const group = (
    id: string,
    name: string,
    description: string,
    icon: string,
    names: readonly string[],
  ) => ({
    id,
    name,
    description,
    icon,
    tools: tools.filter((tool) => names.includes(tool.name)),
  });

  return [
    group(
      "atomic.files.read",
      "Read files",
      "List, search and read files in the project the conversation has open.",
      "folder-search",
      ["read_file", "list_files", "glob", "grep"],
    ),
    group(
      "atomic.files.write",
      "Edit files",
      "Write and edit files, with a diff to review and undo.",
      "file-pen",
      ["write_file", "edit_file"],
    ),
    group(
      "atomic.shell",
      "Run commands",
      "Run shell commands and inspect git history. Everything is asked first unless you allow it.",
      "terminal",
      ["bash", "git", "todo_write"],
    ),
    group(
      "atomic.folders",
      "Ask for folders",
      "Let the agent request access to folders outside the one the conversation has open.",
      "folder-plus",
      ["add_folder"],
    ),
  ].filter((capability) => capability.tools.length > 0);
}