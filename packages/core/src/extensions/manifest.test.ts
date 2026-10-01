/**
 * Extension manifests.
 *
 * The tests here are mostly about what the app does with a manifest it does not
 * trust, because that is where the damage would be: a manifest is data, and data
 * arrives from disk, from a future extensions folder, and from MCP servers.
 */

import { describe, expect, it } from "vitest";

import {
  manifestCategories,
  manifestModes,
  validateManifest,
  ExtensionManifestSchema,
} from "./manifest.js";

const minimal = {
  id: "example.browser",
  name: "Example browser",
  description: "Drives a browser on the user's behalf.",
};

describe("a manifest that says nothing wrong", () => {
  it("fills in the parts a small manifest omits", () => {
    const { manifest, problems } = validateManifest(minimal);
    expect(problems).toEqual([]);
    expect(manifest?.defaultEnabled).toBe(false);
    expect(manifest?.publisher).toBe("unknown");
    expect(manifest?.contributions.tools).toEqual([]);
  });

  it("refuses to make a tool's categories empty", () => {
    // Defaulting to "no categories" would be a tool the gate has to guess about,
    // and the guess that matters is the one that permits it.
    const { manifest, problems } = validateManifest({
      ...minimal,
      contributions: {
        tools: [{ name: "x", description: "d", parameters: { type: "object", properties: {} }, categories: [] }],
      },
    });
    expect(manifest).toBeUndefined();
    expect(problems.length).toBeGreaterThan(0);
  });

  it("refuses a tool name a provider could not address", () => {
    // Tools are named over the wire. A name with a space or a slash works in a
    // unit test and comes back renamed -- or not at all -- from a real model.
    for (const name of ["Web Browse", "browser/navigate", "9lives"]) {
      const { manifest } = validateManifest({
        ...minimal,
        contributions: {
          tools: [{ name, description: "d", parameters: { type: "object", properties: {} } }],
        },
      });
      expect(manifest, name).toBeUndefined();
    }
  });

  it("accepts the name shape it does allow", () => {
    const { problems } = validateManifest({
      ...minimal,
      contributions: {
        tools: [{ name: "browser_navigate2", description: "d", parameters: { type: "object", properties: {} } }],
      },
    });
    expect(problems).toEqual([]);
  });
});

describe("collecting every problem, not the first", () => {
  it("reports several at once", () => {
    // The whole reason this is not a schema parse: a first-error contract turns
    // a five-field mistake into five reloads, and the person fixing a manifest
    // is usually not the person who wrote it.
    const { problems } = validateManifest({
      id: "Bad Id",
      name: "",
      description: "x",
      contributions: {
        tools: [
          { name: "Bad Name", description: "d", parameters: { type: "object", properties: {} } },
          { name: "also bad", description: "d", parameters: { type: "object", properties: {} } },
        ],
      },
    });
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });

  it("says which field each problem is about", () => {
    const { problems } = validateManifest({ id: "x" });
    const paths = problems.map((problem) => problem.path);
    expect(paths).toContain("name");
    expect(paths).toContain("description");
  });
});

describe("problems a schema cannot express", () => {
  const tool = (over: Record<string, unknown> = {}) => ({
    name: "browser_go",
    description: "navigate",
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, path: { type: "string" } },
    },
    ...over,
  });

  it("flags two tools claiming one name", () => {
    // Otherwise the second silently shadows the first, and the model gets
    // whichever the registry kept rather than the one the author intended.
    const { manifest, problems } = validateManifest({
      ...minimal,
      contributions: { tools: [tool(), tool({ description: "a different tool" })] },
    });
    expect(manifest).toBeDefined();
    expect(problems).toEqual([
      { path: "contributions.tools.1.name", message: '"browser_go" is already declared at contributions.tools.0' },
    ]);
  });

  it("flags an allow-suggestion pointing at an argument the tool does not have", () => {
    // Reads as "always allow" doing nothing, which is the exact failure the
    // suggestion machinery exists to prevent.
    const { problems } = validateManifest({
      ...minimal,
      contributions: { tools: [tool({ allowSuggestion: { from: "urlz", kind: "domain" } })] },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("urlz");
    expect(problems[0]?.message).toContain("url, path");
  });

  it("accepts an allow-suggestion pointing at a real argument", () => {
    const { problems } = validateManifest({
      ...minimal,
      contributions: { tools: [tool({ allowSuggestion: { from: "url", kind: "domain" } })] },
    });
    expect(problems).toEqual([]);
  });

  it("flags enablement and lifecycle disagreeing about a credential", () => {
    // The manifest author did not know which one decides, and the reader cannot
    // tell either. Better to say so than to pick.
    const { problems } = validateManifest({
      ...minimal,
      platforms: ["linux"],
      enablement: { requiresCredential: true },
    });
    expect(problems.some((problem) => problem.path === "lifecycle.requiresCredential")).toBe(true);
  });

  it("flags a needsPlatform outside platforms", () => {
    const { problems } = validateManifest({
      ...minimal,
      platforms: ["linux", "macos"],
      enablement: { needsPlatform: "win32" },
    });
    expect(problems.some((problem) => problem.path === "enablement.needsPlatform")).toBe(true);
  });
});

describe("what a manifest is worth on its own", () => {
  const withTools = validateManifest({
    ...minimal,
    contributions: {
      tools: [
        { name: "a_read", description: "d", parameters: { type: "object", properties: {} }, categories: ["file-read"], modes: ["code"] },
        { name: "b_go", description: "d", parameters: { type: "object", properties: {} }, categories: ["browser", "network"], modes: ["cowork"] },
      ],
    },
  }).manifest;

  it("reports the union of its tools' modes, for the prompt and the UI", () => {
    // This is the same shape the browser capability check reads, so an extension
    // that adds a browser tool makes the Cowork prompt describe it automatically.
    expect(manifestModes(withTools!).sort()).toEqual(["code", "cowork"]);
  });

  it("reports the union of its tools' categories", () => {
    expect(manifestCategories(withTools!).sort()).toEqual(["browser", "file-read", "network"]);
  });

  it("stops being a manifest if the schema is bypassed", () => {
    // The type is derived from the schema, so a hand-built object claiming to be
    // one cannot be substituted without going through it. A runtime assertion
    // here rather than a cast: this file is the boundary between data from disk
    // and the rest of the app, and it is the right place to be strict.
    expect(() => ExtensionManifestSchema.parse({ id: "x" })).toThrow();
  });
});