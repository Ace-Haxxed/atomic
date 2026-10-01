/**
 * Contributions: a manifest's tool declarations as tools the loop can call.
 *
 * The claim being tested is that an extension tool and a built-in are the same
 * thing to everything downstream. If that stops being true, this codebase has a
 * second permission path and a second prompt path, and this file is where it is
 * caught.
 */

import { describe, expect, it } from "vitest";

import { PermissionGate } from "../permissions/gate.js";
import { ToolRegistry, type ToolContext } from "../tools/registry.js";
import { SettingsSchema } from "../settings/schema.js";
import { allowListFor, contributeTools, toolFromDeclaration, type ToolImplementation } from "./contributions.js";
import type { ExtensionManifest } from "./manifest.js";

const manifest: ExtensionManifest = {
  id: "example.browser",
  name: "Example",
  description: "d",
  icon: "globe",
  version: "1.0.0",
  publisher: "Someone",
  platforms: [],
  lifecycle: { requiresProcess: false, requiresCredential: false, lazy: true },
  enablement: { requiresCredential: false, requiresService: [] },
  defaultEnabled: true,
  defaultHidden: false,
  contributions: {
    tools: [
      {
        name: "browser_go",
        description: "Navigate to a URL",
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
        categories: ["browser"],
        modes: ["cowork"],
        allowSuggestion: { from: "url", kind: "domain" },
      },
    ],
  },
  source: undefined,
};

const context = (over: Partial<ToolContext> = {}): ToolContext => ({
  conversationId: "c1",
  messageId: "m1",
  runId: "r1",
  mode: "cowork",
  signal: new AbortController().signal,
  workspace: null,
  extraRoots: () => [],
  describe: () => "browser_go",
  ...over,
});

const works: ToolImplementation = {
  execute: async (args) => ({ content: `went to ${String(args.url)}` }),
};

describe("a contributed tool is an ordinary tool", () => {
  it("carries the manifest's categories and modes through unchanged", () => {
    // If these were defaulted or widened here, the permission gate would be
    // deciding on a different tool than the one the manifest describes.
    const tool = toolFromDeclaration(manifest, manifest.contributions.tools[0]!, () => works)!;
    expect(tool.categories).toEqual(["browser"]);
    expect(tool.modes).toEqual(["cowork"]);
    expect(tool.description).toBe("Navigate to a URL");
  });

  it("registers into the same registry as a built-in", async () => {
    const registry = new ToolRegistry();
    const contributed = contributeTools(manifest, () => works).tools;
    registry.registerAll(contributed);
    expect(registry.names("cowork")).toEqual(["browser_go"]);
    expect(registry.names("code")).toEqual([]);
    await expect(registry.get("browser_go")!.execute({ url: "https://x.test" }, context())).resolves.toEqual({
      content: "went to https://x.test",
    });
  });

  it("is gated exactly as a built-in is", () => {
    // Ask mode and a browser category: the gate must produce the same decision it
    // would for any tool it has never heard of. If extensions needed a rule of
    // their own, a browser tool could end up asking where a file read does not.
    const gate = new PermissionGate(() => SettingsSchema.parse({}), { platform: "linux" });
    const tool = toolFromDeclaration(manifest, manifest.contributions.tools[0]!, () => works)!;
    const outcome = gate.check({
      tool,
      args: { url: "https://x.test" },
      mode: "cowork",
      runId: "r1",
      conversationId: "c1",
      workspace: null,
    });
    expect(outcome.decision).toBe("ask");
    // The host, not the URL: `allowedDomains` is matched against a host name, so
    // filing the whole URL there would produce an entry no call can satisfy.
    expect(outcome.allowSuggestion).toBe("x.test");
    expect(outcome.allowSuggestionList).toBe("allowedDomains");
  });
});

describe("a declared tool with no implementation", () => {
  it("contributes nothing and is reported by name", () => {
    // The failure this avoids: registering a tool that returns an empty string,
    // so the model reports having opened a page it never opened. Absent beats
    // refusing -- a model offered a tool keeps reaching for it, and one that has
    // never heard of the tool moves on.
    const result = contributeTools(manifest, () => undefined);
    expect(result.tools).toEqual([]);
    expect(result.unimplemented).toEqual(["browser_go"]);
  });

  it("takes the implementation from the resolver, per tool", () => {
    const result = contributeTools(manifest, (name) => (name === "browser_go" ? works : undefined));
    expect(result.tools).toHaveLength(1);
    expect(result.unimplemented).toEqual([]);
  });
});

describe("arguments are validated before anything acts on them", () => {
  it("runs the implementation's parse step, and hands over only its result", async () => {
    // The gate has already asked the user about this call. Running on raw
    // arguments would act on a decision the user never saw the inputs to.
    const seen: unknown[] = [];
    const tool = toolFromDeclaration(manifest, manifest.contributions.tools[0]!, () => ({
      execute: async (args) => {
        seen.push(args);
        return { content: "ok" };
      },
      parse: (args) => ({ url: String((args as { url: unknown }).url).trim() }),
    }))!;

    expect(tool.parse).toBeTypeOf("function");
    await tool.execute({ url: "  https://x.test  ", extra: "dropped" }, context());
    // Trimmed, and the argument the parser does not know about is gone: the
    // implementation must not be handed fields the manifest never declared.
    expect(seen).toEqual([{ url: "https://x.test" }]);
  });

  it("reports no parse step when there is nothing to validate with", () => {
    // Offering a parse that could then be skipped would be worse than none.
    const tool = toolFromDeclaration(manifest, manifest.contributions.tools[0]!, () => works)!;
    expect(tool.parse).toBeUndefined();
  });
});

describe("always allow on a contributed tool", () => {
  it("reads the argument the manifest named, as a string", () => {
    const tool = toolFromDeclaration(manifest, manifest.contributions.tools[0]!, () => works)!;
    expect(tool.allowSuggestion?.({ url: "https://x.test" })).toBe("https://x.test");
  });

  it("coerces a number, because an allow-list holds strings", () => {
    // An entry that is a number never matches anything, so "always allow" would
    // look like it worked and remember nothing -- the same failure the suggestion
    // list was introduced to remove, with a new shape.
    const numeric = {
      ...manifest,
      contributions: {
        tools: [
          {
            ...manifest.contributions.tools[0]!,
            parameters: { type: "object", properties: { port: { type: "number" } } },
            allowSuggestion: { from: "port", kind: "path" as const },
          },
        ],
      },
    };
    const tool = toolFromDeclaration(numeric, numeric.contributions.tools[0]!, () => works)!;
    expect(tool.allowSuggestion?.({ port: 8080 })).toBe("8080");
  });

  it("offers nothing for an argument that is absent or empty", () => {
    const tool = toolFromDeclaration(manifest, manifest.contributions.tools[0]!, () => works)!;
    expect(tool.allowSuggestion?.({})).toBeNull();
    expect(tool.allowSuggestion?.({ url: "   " })).toBeNull();
  });

  it("declares the kind, so the gate files the value in the right list", () => {
    // The defect this exists to catch: the gate filed a contributed tool's own
    // suggestion into `allowedCommands` regardless of what it was, because
    // commands were the only kind that existed when that default was written. A
    // browser URL landed in a command list, matched nothing, and reported
    // success.
    const tool = toolFromDeclaration(manifest, manifest.contributions.tools[0]!, () => works)!;
    expect(tool.allowSuggestionKind).toBe("domain");
  });

  it("leaves the kind off when the manifest declares no suggestion", () => {
    const none = { ...manifest.contributions.tools[0]! };
    delete (none as { allowSuggestion?: unknown }).allowSuggestion;
    const tool = toolFromDeclaration(manifest, none, () => works)!;
    expect(tool.allowSuggestion).toBeUndefined();
    expect(tool.allowSuggestionKind).toBeUndefined();
  });

  it("knows which list the value belongs in, and does not guess per tool", () => {
    expect(allowListFor(manifest.contributions.tools[0]!)).toBe("allowedDomains");
    const noSuggestion = { ...manifest.contributions.tools[0]! };
    delete (noSuggestion as { allowSuggestion?: unknown }).allowSuggestion;
    expect(allowListFor(noSuggestion)).toBeUndefined();
  });
});