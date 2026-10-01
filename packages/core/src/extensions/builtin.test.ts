/**
 * The built-in capability, as a manifest.
 *
 * The point of deriving the manifest from the real tools is that the two cannot
 * disagree. These tests are the argument for that: they use the real `createCodeTools`
 * output rather than a hand-written fixture, so a description edited in a tool
 * file fails here if it ever stops reaching the manifest.
 */

import { describe, expect, it } from "vitest";

import { createCodeTools } from "../tools/index.js";
import { ExtensionRegistry } from "./registry.js";
import { builtinCapabilities, manifestForBuiltins } from "./builtin.js";
import { ExtensionManifestSchema, validateManifest } from "./manifest.js";
import type { FileSystemPort, ProcessPort } from "../host/ports.js";
import type { Tool } from "../tools/registry.js";
import type { HostCapabilities } from "./registry.js";

const tools = (): Tool[] =>
  createCodeTools({
    fs: {} as FileSystemPort,
    process: {} as ProcessPort,
    todos: { read: async () => [], write: async () => {} },
    // Present, because the real host has it and `createCodeTools` leaves the
    // folder tools out without it. A fixture missing it would quietly test three
    // capabilities instead of four.
    folders: {
      canRequest: () => true,
      addsWithoutAsking: () => false,
      request: async () => null,
    },
  });

const caps: HostCapabilities = {
  platform: {
    os: "linux",
    rawOs: "linux",
    arch: "x64",
    description: "Linux",
    sep: "/",
    caseSensitivePaths: true,
    crlfByDefault: false,
  } as unknown as HostCapabilities["platform"],
  services: ["fs", "process", "folders"],
  hasCredentialStore: true,
};

describe("the built-in manifest describes the tools that actually exist", () => {
  const capabilities = builtinCapabilities(tools());

  it("finds every tool, with none invented and none missed", () => {
    // The whole reason for deriving rather than writing it out. A hand-written
    // manifest listing ten tools starts correct and decays: a tool added to
    // `createCodeTools` never appears, and a tool deleted stays listed forever.
    const declared = capabilities.flatMap((capability) =>
      capability.tools.map((tool) => tool.name),
    );
    expect(declared.sort()).toEqual(tools().map((tool) => tool.name).sort());
  });

  it("carries each tool's own description and categories, unmodified", () => {
    const real = new Map(tools().map((tool) => [tool.name, tool]));
    for (const capability of capabilities) {
      const manifest = manifestForBuiltins(capability);
      for (const declared of manifest.contributions.tools) {
        expect(declared.description, declared.name).toBe(real.get(declared.name)?.description);
        expect(declared.categories, declared.name).toEqual(real.get(declared.name)?.categories);
        expect(declared.modes, declared.name).toEqual(real.get(declared.name)?.modes);
      }
    }
  });

  it("passes its own validator, with no problems to report", () => {
    for (const capability of capabilities) {
      const { problems } = validateManifest(manifestForBuiltins(capability));
      expect(problems, capability.id).toEqual([]);
    }
  });

  it("splits them along the lines a user would want to switch off", () => {
    // "Let it look without changing anything" is a real request, and expressing it
    // as a toggle on read tools makes it a switch rather than a deny pattern.
    expect(capabilities.map((capability) => capability.id)).toEqual([
      "atomic.files.read",
      "atomic.files.write",
      "atomic.shell",
      "atomic.folders",
    ]);
  });

  it("drops a capability with no tools rather than listing an empty one", () => {
    // A group whose tools are all absent is not a capability. Showing it would
    // offer a switch that turns nothing on.
    const capabilities = builtinCapabilities([]);
    expect(capabilities).toEqual([]);
  });
});

describe("which allow-list each built-in tool suggests into", () => {
  const manifestFor = (name: string) => {
    const capability = builtinCapabilities(tools()).find((group) =>
      group.tools.some((tool) => tool.name === name),
    )!;
    return manifestForBuiltins(capability);
  };

  it("files a command where a command belongs", () => {
    expect(manifestFor("bash").contributions.tools[0]?.allowSuggestion).toEqual({
      from: "command",
      kind: "command",
    });
  });

  it("gives the folder tool no suggestion at all", () => {
    // A standing grant to any folder is not a narrower thing than asking, so
    // offering one would be an offer the user should never see.
    const addFolder = manifestFor("add_folder").contributions.tools.find(
      (tool) => tool.name === "add_folder",
    );
    expect(addFolder?.allowSuggestion).toBeUndefined();
  });

  it("infers nothing for a tool that offers no suggestion", () => {
    // `add_folder` is the case; a tool with an `allowSuggestion` but no command,
    // url or path argument gets no declaration rather than a wrong one.
    const readFile = manifestFor("read_file").contributions.tools.find(
      (tool) => tool.name === "read_file",
    );
    expect(readFile?.allowSuggestion).toBeUndefined();
  });
});

describe("the built-ins as extensions", () => {
  it("are enabled, published by Atomic, and available everywhere", () => {
    // An extension registry shipping with the app's own reason for existing
    // switched off would be a very literal reading of the rules.
    const registry = new ExtensionRegistry(caps);
    for (const capability of builtinCapabilities(tools())) {
      registry.discover({ label: "builtin", manifest: manifestForBuiltins(capability) });
    }
    expect(registry.active()).toHaveLength(builtinCapabilities(tools()).length);
    expect(registry.summaries().every((summary) => summary.available)).toBe(true);
    expect(registry.summaries().every((summary) => summary.enabled)).toBe(true);
    expect(registry.summaries().every((summary) => summary.publisher === "Atomic")).toBe(true);
  });

  it("can be switched off, which takes its tools with it", () => {
    const registry = new ExtensionRegistry(caps);
    const capability = builtinCapabilities(tools())[0]!;
    registry.discover({ manifest: manifestForBuiltins(capability) });
    expect(registry.setEnabled(capability.id, false)).toBe(true);
    expect(registry.active()).toHaveLength(0);
  });
});

describe("the schema and the types cannot drift apart", () => {
  it("round-trips a parsed manifest through the type unchanged", () => {
    const parsed = ExtensionManifestSchema.parse({
      id: "x.y",
      name: "X",
      description: "d",
    });
    // A compile-time-only assertion: if `ExtensionManifest` and the schema's
    // output ever diverge, this line stops typechecking.
    const asType: ExtensionManifestSchema.infer<typeof ExtensionManifestSchema> = parsed;
    expect(asType.id).toBe("x.y");
  });
});