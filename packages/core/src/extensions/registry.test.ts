/**
 * The extension registry.
 *
 * These tests are about the states a user is most likely to hit and least likely
 * to understand from a switch: an extension that is installed but not usable
 * here, one that is switched on and doing nothing, and two of them claiming one
 * id.
 */

import { describe, expect, it, vi } from "vitest";

import { ExtensionRegistry, extensionPlatformOf, type HostCapabilities } from "./registry.js";
import type { OsPlatform } from "../platform/platform.js";

const caps = (over: Partial<HostCapabilities> = {}): HostCapabilities => ({
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
  ...over,
});

const manifest = (over: Record<string, unknown> = {}) => ({
  id: "example.browser",
  name: "Example browser",
  description: "d",
  defaultEnabled: true,
  ...over,
});

describe("what the host can do decides what the user is offered", () => {
  it("refuses a macOS-only extension on Linux, and says which platform", () => {
    const registry = new ExtensionRegistry(caps());
    registry.discover({ label: "browser", manifest: manifest({ platforms: ["macos"] }) });
    const record = registry.get("example.browser");
    expect(record?.enabled).toBe(true);
    expect(record?.unavailable).toEqual({ kind: "platform", required: "macos" });
  });

  it("keeps a portable extension available", () => {
    // No `platforms` means "runs anywhere", not "runs on the machine we happen
    // to be developing on".
    const registry = new ExtensionRegistry(caps());
    registry.discover({ manifest: manifest() });
    expect(registry.get("example.browser")?.unavailable).toBeUndefined();
    expect(registry.active()).toHaveLength(1);
  });

  it("reports which host services are missing", () => {
    const registry = new ExtensionRegistry(caps({ services: ["fs"] }));
    registry.discover({
      manifest: manifest({ enablement: { requiresService: ["process", "browser-profile"] } }),
    });
    expect(registry.get("example.browser")?.unavailable).toEqual({
      kind: "service",
      missing: ["process", "browser-profile"],
    });
  });

  it("re-checks availability when a service arrives late", () => {
    // Startup order is not ours to control, so an extension that needs the
    // network port must be able to become usable once it is wired up.
    const registry = new ExtensionRegistry(caps({ services: ["fs"] }));
    registry.discover({ manifest: manifest({ enablement: { requiresService: ["process"] } }) });
    expect(registry.active()).toHaveLength(0);
    registry.setCapabilities(caps());
    expect(registry.active()).toHaveLength(1);
  });

  it("blocks an extension needing a credential store the app has not got", () => {
    const registry = new ExtensionRegistry(caps({ hasCredentialStore: false }));
    registry.discover({ manifest: manifest({ lifecycle: { requiresCredential: true } }) });
    expect(registry.get("example.browser")?.unavailable).toEqual({ kind: "credential" });
  });

  it("blocks everything on a host with no desktop platform", () => {
    // Android, iOS and unrecognised platforms are real values of `os`, and none
    // of them is one a desktop extension ships for. An empty `platforms` must not
    // be read as "runs anywhere at all".
    const registry = new ExtensionRegistry(
      caps({ platform: { os: "android" } as unknown as HostCapabilities["platform"] }),
    );
    registry.discover({ manifest: manifest() });
    expect(registry.get("example.browser")?.unavailable?.kind).toBe("platform");
  });
});

describe("mapping the app's platform to one a manifest can name", () => {
  it("maps the three desktop platforms", () => {
    expect(extensionPlatformOf("linux")).toBe("linux");
    expect(extensionPlatformOf("macos")).toBe("macos");
    expect(extensionPlatformOf("windows")).toBe("win32");
  });

  it("has no answer for the rest", () => {
    for (const os of ["android", "ios", "unknown"] as OsPlatform[]) {
      expect(extensionPlatformOf(os), os).toBeUndefined();
    }
  });
});

describe("the user's own choice", () => {
  it("will not store a switch for something that cannot run", () => {
    // Accepting it would leave the UI showing "on" for a capability that is not
    // there -- the exact shape of the bug this area started from.
    const registry = new ExtensionRegistry(caps());
    registry.discover({ manifest: manifest({ platforms: ["macos"], defaultEnabled: false }) });
    expect(registry.setEnabled("example.browser", true)).toBe(false);
    expect(registry.get("example.browser")?.enabled).toBe(false);
  });

  it("switches something usable, and notifies once per real change", () => {
    const registry = new ExtensionRegistry(caps());
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.discover({ manifest: manifest() });
    expect(listener).toHaveBeenCalledTimes(1); // the discovery itself

    expect(registry.setEnabled("example.browser", false)).toBe(true);
    expect(registry.active()).toHaveLength(0);
    // Idempotent: setting the same value again is not a change, and firing on it
    // would make a settings panel re-render for no reason.
    registry.setEnabled("example.browser", false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("remembers a choice made before the extension was discovered", () => {
    // A settings file can name an extension that has not been installed on this
    // machine. Forgetting the choice would install it enabled the moment it
    // appeared, which is how an extension the user deliberately turned off comes
    // back on by itself.
    const registry = new ExtensionRegistry(caps());
    expect(registry.setEnabled("later.extension", false)).toBe(true);
    registry.discover({ manifest: manifest({ id: "later.extension", defaultEnabled: true }) });
    expect(registry.get("later.extension")?.enabled).toBe(false);
    expect(registry.active()).toHaveLength(0);
  });
});

describe("two manifests claiming one id", () => {
  it("lets the last one win and says so", () => {
    // Not an error to swallow: this is a stale install or a mislabelled package,
    // and one author's tools appearing under another's name is worth a user
    // seeing.
    const registry = new ExtensionRegistry(caps());
    registry.discover({ label: "old", manifest: manifest({ name: "Old" }) });
    registry.discover({ label: "new", manifest: manifest({ name: "New" }) });

    const record = registry.get("example.browser");
    expect(record?.manifest.name).toBe("New");
    expect(record?.unavailable).toEqual({ kind: "shadowed", by: "example.browser", bySource: "old" });
    // Shadowed means not active: the user should not get two copies.
    expect(registry.active()).toHaveLength(0);
  });

  it("names a tool more than one extension claims", () => {
    // The gate and the loop address tools by name, so a contended name is a
    // silent shadowing. Reporting it is the only thing that prevents one.
    const registry = new ExtensionRegistry(caps());
    const tool = { name: "shared", description: "d", parameters: { type: "object", properties: {} } };
    registry.discover({ manifest: manifest({ id: "a.one", contributions: { tools: [tool] } }) });
    registry.discover({ manifest: manifest({ id: "b.two", contributions: { tools: [tool] } }) });
    expect(registry.contendedToolNames().get("shared")).toEqual(["a.one", "b.two"]);
  });
});

describe("a broken manifest is still visible", () => {
  it("is listed with its problems, not dropped", () => {
    // Dropping it makes a typo indistinguishable from "never installed", and the
    // first of those is fixable.
    const registry = new ExtensionRegistry(caps());
    const problems = registry.discover({
      manifest: manifest({ contributions: { tools: [{ name: "Bad", description: "d", parameters: { type: "object", properties: {} } }] } }),
    });
    expect(problems.length).toBeGreaterThan(0);
    const summary = registry.summaries()[0];
    expect(summary?.problems.length).toBeGreaterThan(0);
    expect(summary?.available).toBe(false);
    expect(summary?.unavailable?.kind).toBe("invalid");
    expect(registry.active()).toHaveLength(0);
  });

  it("survives a manifest with no id at all", () => {
    // Nothing to list it under, so the problems are the only channel. It must not
    // throw: one unreadable file in an extensions folder cannot be allowed to stop
    // the app starting.
    const registry = new ExtensionRegistry(caps());
    expect(() => registry.discover({ manifest: { name: "no id" } })).not.toThrow();
    expect(registry.size).toBe(0);
  });
});

describe("what the settings UI reads", () => {
  it("reports tools, categories and modes without interpreting them", () => {
    // The panel renders what the registry says. No extension is named in a
    // component, so a new one appears without a code change.
    const registry = new ExtensionRegistry(caps());
    registry.discover({
      manifest: manifest({
        icon: "globe",
        publisher: "Someone",
        version: "2.1.0",
        contributions: {
          tools: [
            { name: "browser_go", description: "d", parameters: { type: "object", properties: {} }, categories: ["browser", "network"], modes: ["cowork"] },
          ],
        },
      }),
    });
    expect(registry.summaries()).toEqual([
      {
        id: "example.browser",
        name: "Example browser",
        description: "d",
        icon: "globe",
        publisher: "Someone",
        version: "2.1.0",
        enabled: true,
        available: true,
        unavailable: undefined,
        hidden: false,
        toolNames: ["browser_go"],
        categories: ["browser", "network"],
        modes: ["cowork"],
        problems: [],
        source: undefined,
      },
    ]);
  });
});