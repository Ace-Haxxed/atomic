/**
 * The extension manifest: what a capability declares about itself.
 *
 * A manifest is data, not code. That boundary is the whole design and it is not
 * negotiable, because the alternative -- a manifest that names a function to
 * call -- means any extension can run arbitrary code in the app's process, and a
 * Cowork user installing a browser tool is the exact moment that matters. So a
 * manifest declares *what* a capability is: its identity, the tools it offers,
 * the conditions under which it can run. The code that performs those tools is
 * supplied separately, by a resolver the app already trusts. A manifest whose
 * tools have no implementation is reported as unavailable, not registered with
 * a stand-in that does nothing.
 *
 * The fields exist because each one is needed to answer a question the app
 * already asks about a built-in tool:
 *
 *  - `id` / `name` / `description` / `icon` — what the settings UI shows, and what
 *    the model is told when the tool is in play.
 *  - `contributions.tools` — the tools themselves, with the same categories and
 *    mode restriction a built-in declares, so the permission gate and the loop
 *    cannot tell the two apart.
 *  - `platforms` — a browser tool that only works on Linux must not be offered
 *    on Windows. Offering it anyway produces a tool that is always refused.
 *  - `lifecycle` and `enablement` — whether it needs a running process, a
 *    credential, or a human to turn it on.
 *  - `defaultEnabled` / `defaultHidden` — the difference between a capability
 *    most people want and one most people should not have switched on silently.
 */

import { z } from "zod";
import { MODES, TOOL_CATEGORIES, type Mode, type ToolCategory } from "../settings/schema.js";

/** Where a tool's arguments come from, used to keep schemas honest. */
const ToolDeclarationSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    // Providers address tools by name over the wire, so a name with whitespace
    // or a slash is a tool that works in a test and breaks in a real model.
    .regex(/^[a-z][a-z0-9_]*$/, "use lowercase letters, digits and underscores"),
  description: z.string().min(1).max(2_000),
  /** JSON Schema for the arguments object, passed to the model as-is. */
  parameters: z
    .object({ type: z.literal("object"), properties: z.record(z.string(), z.unknown()).default({}) })
    .default({ type: "object", properties: {} }),
  /**
   * Permission categories, the same ones built-in tools declare.
   *
   * Defaults to `["network"]` rather than to nothing: an undeclared category
   * would be a tool the gate has to guess about, and the guess that matters is
   * the permissive one.
   */
  categories: z.array(z.enum(TOOL_CATEGORIES)).min(1).default(["network"]),
  modes: z.array(z.enum(MODES)).min(1).default([...MODES]),
  /**
   * A value the user can add to an allow-list via "always allow".
   *
   * Declared here as the *form* of the value ("command", "domain", "path") rather
   * than as a rendered string, because the host has to write it into one of
   * three differently-matched lists and cannot tell them apart from a string.
   */
  allowSuggestion: z
    .object({
      /** Which of `args` names the thing being allowed. */
      from: z.string().min(1),
      kind: z.enum(["command", "domain", "path"]),
    })
    .optional(),
});

/**
 * The platforms a manifest can name.
 *
 * Narrower than the app's `OsPlatform`, because android, ios and unknown are not
 * platforms a desktop extension ships for and letting a manifest name one would
 * be an offer the app cannot honour.
 */
export const EXTENSION_PLATFORMS = ["linux", "macos", "win32"] as const;
export type ExtensionPlatform = (typeof EXTENSION_PLATFORMS)[number];

export const ExtensionManifestSchema = z.object({
  /**
   * Reversed-DNS-ish, so a publisher's prefix is visible and two of them cannot
   * quietly collide on the bare name.
   */
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/,
      "use lowercase letters and digits, separated by dots or hyphens",
    ),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2_000),
  /** Lucide icon name, resolved by the UI. Unknown names render a fallback. */
  icon: z.string().min(1).max(64).default("plug"),
  /** Document version, compared semantically. Purely informational for now. */
  version: z.string().min(1).max(32).default("0.0.0"),
  /** The producer, shown so a user can tell who is asking for permissions. */
  publisher: z.string().min(1).max(120).default("unknown"),
  /**
   * Operating systems this can run on. Empty means "any", which is the honest
   * default for something genuinely portable and a lie for something that is not.
   */
  platforms: z.array(z.enum(EXTENSION_PLATFORMS)).default([]),
  lifecycle: z
    .object({
      /** Starts something outside the app, so a stop is needed on exit. */
      requiresProcess: z.boolean().default(false),
      /** Needs a credential the user must supply before it can run. */
      requiresCredential: z.boolean().default(false),
      /** Started lazily on first tool call rather than with the app. */
      lazy: z.boolean().default(true),
    })
    .default(() => ({ requiresProcess: false, requiresCredential: false, lazy: true })),
  /**
   * When the extension can run at all, as data the app evaluates.
   *
   * Conditions are checked rather than trusted: an extension that declares
   * `needsPlatform: "darwin"` must not be reachable on Linux, and evaluating
   * them here means a manifest cannot assert a capability the host has not got.
   */
  enablement: z
    .object({
      needsPlatform: z.enum(EXTENSION_PLATFORMS).optional(),
      requiresCredential: z.boolean().default(false),
      /** A host port this extension cannot work without, by name. */
      requiresService: z.array(z.string().min(1)).default([]),
    })
    .default(() => ({ requiresCredential: false, requiresService: [] })),
  defaultEnabled: z.boolean().default(false),
  /**
   * Off by default and out of the way until asked for. Separate from
   * `defaultEnabled`: something may be enabled but not advertised.
   */
  defaultHidden: z.boolean().default(false),
  contributions: z
    .object({
      tools: z.array(ToolDeclarationSchema).default([]),
    })
    .default(() => ({ tools: [] })),
  /** Where the manifest was read from, for the settings UI to show and for errors. */
  source: z.string().min(1).max(512).optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
export type ToolDeclaration = z.infer<typeof ToolDeclarationSchema>;

/** One problem with a manifest, with enough context to act on it. */
export interface ManifestProblem {
  /** Dotted path to the offending field, e.g. `contributions.tools.1.categories`. */
  readonly path: string;
  readonly message: string;
}

export interface ValidatedManifest {
  readonly manifest: ExtensionManifest;
  readonly problems: readonly ManifestProblem[];
}

/**
 * Collect *every* problem with a manifest rather than throwing on the first.
 *
 * The first-error behaviour is what makes a broken manifest expensive to fix:
 * whoever wrote it gets one error at a time and has to keep reloading to find
 * the rest, and a five-field mistake takes five round trips. It also makes the
 * difference between "invalid" and "valid but with warnings" impossible to
 * express, which matters because a duplicate tool name or an out-of-date
 * version is something to surface, not something to refuse.
 *
 * So the schema is parsed for a hard verdict, and the checks a schema cannot
 * express run alongside it and append to the same list.
 */
export function validateManifest(input: unknown): ValidatedManifest {
  const parsed = ExtensionManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      manifest: undefined as never,
      problems: parsed.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
        message: issue.message,
      })),
    };
  }

  const manifest = parsed.data;
  const problems: ManifestProblem[] = [];

  // Tool names have to be unique within an extension: two tools with one name
  // means the second silently shadows the first, and the model gets whichever the
  // registry kept -- so the user sees a capability the extension did not intend
  // to hide.
  const seen = new Map<string, number>();
  for (const [index, tool] of manifest.contributions.tools.entries()) {
    const first = seen.get(tool.name);
    if (first !== undefined) {
      problems.push({
        path: `contributions.tools.${index}.name`,
        message: `"${tool.name}" is already declared at contributions.tools.${first}`,
      });
    } else {
      seen.set(tool.name, index);
    }

    // An allow-suggestion that points at an argument the tool does not declare
    // yields `undefined` at call time, which reads to the user as "always allow"
    // silently doing nothing.
    if (tool.allowSuggestion) {
      const properties = Object.keys(
        (tool.parameters.properties as Record<string, unknown> | undefined) ?? {},
      );
      if (!properties.includes(tool.allowSuggestion.from)) {
        problems.push({
          path: `contributions.tools.${index}.allowSuggestion.from`,
          message: `"${tool.allowSuggestion.from}" is not one of the tool's arguments (${properties.join(", ") || "none"})`,
        });
      }
    }
  }

  // A platform restriction expressed twice, disagreeing, is a manifest whose
  // author did not know which one decides. The narrower one is assumed, since
  // being available on a platform that does not work is the worse error.
  if (manifest.platforms.length > 0) {
    if (manifest.enablement.needsPlatform && !manifest.platforms.includes(manifest.enablement.needsPlatform)) {
      problems.push({
        path: "enablement.needsPlatform",
        message: `requires ${manifest.enablement.needsPlatform} but platforms allows only ${manifest.platforms.join(", ")}`,
      });
    }
    if (manifest.enablement.requiresCredential && !manifest.lifecycle.requiresCredential) {
      problems.push({
        path: "lifecycle.requiresCredential",
        message: "enablement.requiresCredential is set but lifecycle.requiresCredential is not",
      });
    }
  }

  return { manifest, problems };
}

/** Modes a manifest's tools can be called in, for the registry to intersect with. */
export function manifestModes(manifest: ExtensionManifest): readonly Mode[] {
  const modes = new Set<Mode>();
  for (const tool of manifest.contributions.tools) {
    for (const mode of tool.modes) modes.add(mode);
  }
  return [...modes];
}

/** The union of a manifest's tool categories, for read-only and browser checks. */
export function manifestCategories(manifest: ExtensionManifest): readonly ToolCategory[] {
  const categories = new Set<ToolCategory>();
  for (const tool of manifest.contributions.tools) {
    for (const category of tool.categories) categories.add(category);
  }
  return [...categories];
}