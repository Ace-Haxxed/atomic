/**
 * The extension registry, as the host actually uses it.
 *
 * Unit tests over the registry and over `contributeTools` both pass against code
 * that is never wired together. These are the tests for the seam: that the tools
 * the app ships still reach the model, that switching a capability off takes them
 * out immediately, and that the decision survives a restart.
 */

import { describe, expect, it } from "vitest";

import { LocalHost, type HostServices } from "./local.js";
import { MemorySecretStore } from "../secrets/secret-store.js";
import { SettingsStore } from "../settings/store.js";
import { migratedTestDatabase } from "../storage/sqlite.test-support.js";
import { describePlatform } from "../platform/platform.js";
import type { DatabasePort } from "../storage/database.js";
import type { ExtensionManifest } from "../extensions/manifest.js";

const services = (over: Partial<HostServices> = {}): HostServices =>
  ({
    platform: describePlatform("linux", "x64"),
    env: {},
    ownKeys: {},
    shell: undefined,
    dirs: undefined,
    fs: {
      read: async () => "",
      list: async () => [],
      stat: async () => null,
      exists: async () => false,
    },
    process: {
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      spawn: () => {
        throw new Error("not used here");
      },
      background: async () => ({ pid: 1, stop: () => {} }),
    },
    ...over,
  }) as unknown as HostServices;

async function harness(options: {
  extensions?: readonly ExtensionManifest[];
  initial?: Record<string, unknown>;
  db?: DatabasePort;
}) {
  const db = options.db ?? (await migratedTestDatabase());
  const secrets = new MemorySecretStore();
  /*
   * `load` rather than a fresh store whenever a database is being reused.
   *
   * A store constructed from a seed reads none of what is on disk, so a "restart"
   * built that way would start from defaults -- and the test asserting that a
   * switch survived would pass or fail on the seed, not on persistence. The two
   * disagreeing about what is stored is precisely what this file is checking.
   */
  const settings =
    options.db && options.initial === undefined
      ? await SettingsStore.load(db)
      : new SettingsStore(db, {
          providerId: "opencode-zen",
          ...(options.initial ?? {}),
        });
  const host = new LocalHost({
    db,
    secrets,
    settings,
    services: services(),
    ...(options.extensions ? { extensions: options.extensions } : {}),
  });
  return { db, host, secrets, settings };
}

describe("the built-in tools still reach the model", () => {
  it("registers them all, with the same names as before", async () => {
    // The refactor's whole risk. If a tool were dropped on the way through the
    // manifest layer, the failure would surface as a model quietly not doing
    // something the user asked for, with nothing in the logs.
    const { host } = await harness({});
    const tools = await host.listTools("code");
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("bash");
    expect(tools.find((tool) => tool.name === "bash")?.description).toBeTruthy();
  });

  it("describes them through the same registry the settings panel will read", async () => {
    const { host } = await harness({});
    const extensions = await host.listExtensions();
    const shell = extensions.find((extension) => extension.id === "atomic.shell");
    expect(shell).toBeDefined();
    expect(shell?.available).toBe(true);
    expect(shell?.enabled).toBe(true);
    expect(shell?.missing).toEqual([]);
    expect(shell?.toolNames).toContain("bash");
  });
});

describe("switching a capability off", () => {
  it("takes its tools out of the model's list at once", async () => {
    // Not at the next launch, and not at the next run. Between the click and the
    // next message is exactly the window a user would notice, and a tool that is
    // still callable after being switched off is the whole failure.
    const { host } = await harness({});
    expect((await host.listTools("code")).map((tool) => tool.name)).toContain("bash");

    expect(await host.setExtensionEnabled("atomic.shell", false)).toBe(true);

    const after = (await host.listTools("code")).map((tool) => tool.name);
    expect(after).not.toContain("bash");
    // The rest survive: switching off the shell is not switching off Code mode.
    expect(after).toContain("read_file");
  });

  it("shows as off in the same list it was switched from", async () => {
    const { host } = await harness({});
    await host.setExtensionEnabled("atomic.files.write", false);
    const write = (await host.listExtensions()).find(
      (extension) => extension.id === "atomic.files.write",
    );
    expect(write?.enabled).toBe(false);
    expect(write?.available).toBe(true);
  });

  it("leaves read and write alone when only one is switched off", async () => {
    // One switch per capability, and a user who wants a read-only agent should be
    // able to get one without also losing the ability to look.
    const { host } = await harness({});
    await host.setExtensionEnabled("atomic.files.write", false);
    const names = (await host.listTools("code")).map((tool) => tool.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
  });

  it("refuses, and writes nothing, for a capability this build cannot run", async () => {
    // Recording "off" for something that was never available would make the next
    // install of it inherit a switch the user never set.
    const { host, settings } = await harness({});
    expect(await host.setExtensionEnabled("example.browser", true)).toBe(false);
    expect(settings.get().disabledExtensions).toEqual([]);
  });

  it("comes back on when switched on again", async () => {
    const { host } = await harness({});
    await host.setExtensionEnabled("atomic.shell", false);
    expect(await host.setExtensionEnabled("atomic.shell", true)).toBe(true);
    expect((await host.listTools("code")).map((tool) => tool.name)).toContain("bash");
  });
});

describe("the decision survives a restart", () => {
  it("does not re-offer a capability the user switched off", async () => {
    // The regression this pins: a host that applies the stored switches before it
    // subscribes to changes reports them as off in the settings panel while every
    // tool is still registered. Both halves look right on their own.
    const first = await harness({});
    await first.host.setExtensionEnabled("atomic.shell", false);
    expect((await first.host.listTools("code")).map((tool) => tool.name)).not.toContain("bash");

    const second = await harness({ db: first.db });
    const names = (await second.host.listTools("code")).map((tool) => tool.name);
    expect(names).not.toContain("bash");
    expect(names).toContain("read_file");

    const shell = (await second.host.listExtensions()).find(
      (extension) => extension.id === "atomic.shell",
    );
    expect(shell?.enabled).toBe(false);
    expect(shell?.available).toBe(true);
  });

  it("stores the refusal and nothing else", async () => {
    const first = await harness({});
    await first.host.setExtensionEnabled("atomic.files.write", false);
    const second = await harness({ db: first.db });
    expect(second.settings.get().disabledExtensions).toEqual(["atomic.files.write"]);
  });
});

describe("an extension handed to the host", () => {
  const manifest: ExtensionManifest = {
    id: "example.browser",
    name: "Example Browser",
    description: "A declared capability",
    icon: "globe",
    version: "1.0.0",
    publisher: "Example",
    platforms: [],
    lifecycle: { requiresProcess: false, requiresCredential: true, lazy: true },
    enablement: { requiresCredential: true, requiresService: [] },
    defaultEnabled: false,
    defaultHidden: false,
    contributions: {
      tools: [
        {
          name: "example_open",
          description: "Open something",
          parameters: { type: "object", properties: { url: { type: "string" } } },
          categories: ["browser"],
          modes: ["cowork"],
          allowSuggestion: { from: "url", kind: "domain" },
        },
      ],
    },
  };

  it("is listed, with its declared tools reported as missing", async () => {
    // The declaration is honoured and the absence is stated. The alternative --
    // registering the tool so the settings panel has something to show -- is a
    // model opening pages that never opened.
    const { host } = await harness({ extensions: [manifest] });
    const record = (await host.listExtensions()).find(
      (extension) => extension.id === "example.browser",
    );
    expect(record?.missing).toEqual(["example_open"]);
    expect(record?.enabled).toBe(false);
    // Credential-hungry and off by default: available but not switched on.
    expect(record?.available).toBe(true);
  });

  it("does not register its tools, because nothing implements them", async () => {
    const { host } = await harness({ extensions: [manifest] });
    expect((await host.listTools("cowork")).map((tool) => tool.name)).not.toContain("example_open");
  });

  it("is reported unavailable when the platform does not match", async () => {
    const { host } = await harness({
      extensions: [{ ...manifest, platforms: ["macos"] }],
    });
    const record = (await host.listExtensions()).find(
      (extension) => extension.id === "example.browser",
    );
    expect(record?.available).toBe(false);
    expect(record?.unavailable).toEqual({ kind: "platform", required: "macos" });
    expect(await host.setExtensionEnabled("example.browser", true)).toBe(false);
  });
});

describe("an unavailable built-in", () => {
  it("is absent rather than present and refusing", async () => {
    // The existing rule, checked here because this refactor moved registration.
    // A host with no process port must not hand the model a `bash` that always
    // reports failure.
    const db = await migratedTestDatabase();
    const host = new LocalHost({
      db,
      secrets: new MemorySecretStore(),
      settings: new SettingsStore(db, { providerId: "opencode-zen" }),
      services: services({ fs: undefined, process: undefined }),
    });
    expect(await host.listTools("code")).toEqual([]);
  });
});