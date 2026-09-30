import { describe, expect, it } from "vitest";
import { authorizedRoots, hasAllowedFolders, withFolder } from "./roots.js";
import { describePlatform } from "../platform/platform.js";
import { DEFAULT_SETTINGS, SettingsSchema } from "./schema.js";

/**
 * The roots a conversation may use.
 *
 * Worth testing on its own because the ordering is a security property, not a
 * convenience: a path inside two roots is reported relative to whichever comes
 * first, and a duplicate is a folder the model will be told about twice.
 */
describe("authorizedRoots", () => {
  it("puts the workspace first", () => {
    // First means "owns the path". With the workspace first, a file inside both
    // it and an added subfolder comes back relative to the workspace, which is
    // the root the model already knows about.
    expect(authorizedRoots("/ws", ["/home/me/Code"])).toEqual(["/ws", "/home/me/Code"]);
  });

  it("works with no workspace, given folders", () => {
    expect(authorizedRoots(null, ["/home/me/Code"])).toEqual(["/home/me/Code"]);
  });

  it("is empty when nothing is open", () => {
    expect(authorizedRoots(null, [])).toEqual([]);
    expect(authorizedRoots(null, undefined)).toEqual([]);
    expect(authorizedRoots(undefined, undefined)).toEqual([]);
  });

  it("does not repeat a folder that is also the workspace", () => {
    // The two arrive from different places -- the conversation and Settings -- so
    // the same folder genuinely can appear twice, and resolving against it twice
    // would make the same path match two roots.
    expect(authorizedRoots("/ws", ["/ws"])).toEqual(["/ws"]);
  });

  it("treats a trailing separator as the same folder", () => {
    // Otherwise `/ws` and `/ws/` are two roots that look equal to a human and
    // produce two matches for every path.
    expect(authorizedRoots("/ws", ["/ws/"])).toEqual(["/ws"]);
    expect(authorizedRoots("/ws/", ["/ws"])).toEqual(["/ws/"]);
  });

  it("drops blanks and keeps a real folder that merely looks blank", () => {
    expect(authorizedRoots("/ws", ["", "   "])).toEqual(["/ws"]);
  });

  it("trims a pasted path that picked up whitespace", () => {
    // A folder dragged out of a terminal or a file manager arrives with trailing
    // whitespace often enough to be worth one `trim`, and an untrimmed root makes
    // every path inside it look like it is outside.
    expect(authorizedRoots("/ws", ["  /home/me/Code  "])).toEqual(["/ws", "/home/me/Code"]);
  });

  it("does not treat a name-prefixed sibling as a duplicate", () => {
    expect(authorizedRoots("/ws", ["/ws-secrets"])).toEqual(["/ws", "/ws-secrets"]);
  });
});

describe("hasAllowedFolders", () => {
  it("is false by default", () => {
    expect(hasAllowedFolders(DEFAULT_SETTINGS)).toBe(false);
  });

  it("is true once one is added", () => {
    expect(hasAllowedFolders(SettingsSchema.parse({ files: { allowedFolders: ["/x"] } }))).toBe(true);
  });

  it("tolerates settings stored before the field existed", () => {
    // Settings files written by an older build have no `files` key at all. Code
    // that reads this on the upgrade path must not throw on them.
    const legacy = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Record<string, unknown>;
    delete legacy.files;
    expect(hasAllowedFolders(legacy as never)).toBe(false);
    expect(authorizedRoots(legacy as never, undefined)).toEqual([]);
  });
});

describe("the files settings group", () => {
  it("defaults to no folders, so nobody is granted anything by upgrading", () => {
    // The important default. A field that defaulted to something permissive would
    // quietly widen access for every existing install on first launch.
    expect(SettingsSchema.parse({}).files.allowedFolders).toEqual([]);
  });

  it("survives a round trip with a folder in it", () => {
    const settings = SettingsSchema.parse({ files: { allowedFolders: ["/home/me/Code"] } });
    expect(SettingsSchema.parse(settings).files.allowedFolders).toEqual(["/home/me/Code"]);
  });

  it("refuses an empty folder name, which would resolve to the wrong place", () => {
    // `""` as a root means "the process working directory" to a path join, which
    // is a different thing from the folder the user thinks they added.
    expect(() => SettingsSchema.parse({ files: { allowedFolders: [""] } })).toThrow();
  });

  it("gives each parse its own array", () => {
    // Zod reuses a literal default across parses, so two settings objects would
    // otherwise share one array and a push to one would appear in the other.
    const a = SettingsSchema.parse({});
    const b = SettingsSchema.parse({});
    a.files.allowedFolders.push("/leak");
    expect(b.files.allowedFolders).toEqual([]);
  });
});

/*
 * The two switches that govern the agent adding folders.
 *
 * The defaults are the security posture, so they are asserted here rather than
 * left to the UI: a form that renders two correct switches on top of permissive
 * defaults looks identical to one that renders them correctly, and the only
 * difference shows up later as a folder the agent opened without asking.
 */
describe("agent folder access settings", () => {
  it("lets the agent ask, by default", () => {
    // Asking is not a grant. The model can name a path, the user reads it, and
    // the user decides. Defaulting this to false would mean the model could not
    // even bring a folder up for discussion, which is the more common case.
    expect(SettingsSchema.parse({}).files.agentCanRequestFolders).toBe(true);
  });

  it("does not let the agent add folders on its own, by default", () => {
    // The one default that must not drift. If this is ever true by default,
    // the agent is one turn from reading anything on the disk, and the user
    // never clicked anything.
    expect(SettingsSchema.parse({}).files.agentAddsFoldersWithoutAsking).toBe(false);
    expect(DEFAULT_SETTINGS.files.agentAddsFoldersWithoutAsking).toBe(false);
  });

  it("fills both in for a settings file written before they existed", () => {
    // An existing user's file has no keys for these. Parsing has to supply the
    // defaults rather than leaving them undefined, or the check `if
    // (settings.files.agentAddsFoldersWithoutAsking)` would quietly read a
    // missing key as permissive at the type level and restrictive at runtime.
    const parsed = SettingsSchema.parse({ files: { allowedFolders: ["/home/me/Code"] } });
    expect(parsed.files.agentCanRequestFolders).toBe(true);
    expect(parsed.files.agentAddsFoldersWithoutAsking).toBe(false);
  });

  it("keeps the autonomy switch meaningless when requesting is off", () => {
    // Not enforced by the schema: the UI hides it, and the host simply has no
    // tool to add. Asserted here so the two settings stay visibly independent
    // rather than someone later tying autonomy to be implied by requesting.
    const both = SettingsSchema.parse({ files: { agentAddsFoldersWithoutAsking: true } });
    expect(both.files.agentAddsFoldersWithoutAsking).toBe(true);
  });
});

/*
 * Adding a folder to the authorized list.
 *
 * The comparison rule here is the part that can be wrong in a way nobody notices
 * until a user hits it: a folder that is already authorized has to be *detected*
 * as such, and one that is genuinely a different folder has to be added. Getting
 * either backwards means the agent is told it has access it does not have, or
 * told it already has access it does not.
 */
describe("withFolder", () => {
  const linuxPlatform = describePlatform("linux", "x86_64", "Arch Linux");
  const windowsPlatform = describePlatform("windows", "x86_64", "Windows 11");

  it("adds a folder that is not there yet", () => {
    const next = withFolder(["/home/me/Docs"], "/home/me/Code", linuxPlatform);
    expect(next).toEqual(["/home/me/Docs", "/home/me/Code"]);
  });

  it("reports an already-authorized folder as nothing to do", () => {
    expect(withFolder(["/home/me/Code"], "/home/me/Code", linuxPlatform)).toBeNull();
  });

  it("sees a trailing separator as the same folder", () => {
    // A path from a file picker, a drag, or a model that added a slash. Two
    // spellings of one folder in the list would make every path inside it
    // resolve twice.
    expect(withFolder(["/home/me/Code"], "/home/me/Code/", linuxPlatform)).toBeNull();
    expect(withFolder(["/home/me/Code/"], "/home/me/Code", linuxPlatform)).toBeNull();
  });

  it("keeps two folders that differ only in case, on a case-sensitive filesystem", () => {
    // These are two real directories on Linux. Folding them into one would drop
    // the second, and the agent would be told it had access to a folder it
    // cannot read -- a false report about access, which is the failure that
    // matters here.
    const next = withFolder(["/home/me/Code"], "/home/me/code", linuxPlatform);
    expect(next).toEqual(["/home/me/Code", "/home/me/code"]);
  });

  it("sees the two spellings as one folder where the filesystem does", () => {
    // The other half of the rule, so the test above cannot be satisfied by
    // simply never folding.
    expect(withFolder(["C:\\Users\\Me\\Code"], "c:/users/me/Code", windowsPlatform)).toBeNull();
  });

  it("stores the path as given, not normalized into something else", () => {
    // What the user reads in Settings should be what the host confirmed on the
    // filesystem. Rewriting the spelling here would be storing a path nothing
    // has verified.
    const next = withFolder([], "/home/me/Code", linuxPlatform);
    expect(next).toEqual(["/home/me/Code"]);
  });

  it("adds to an empty list", () => {
    expect(withFolder([], "/home/me/Code", linuxPlatform)).toEqual(["/home/me/Code"]);
  });

  it("refuses an empty or separator-only path", () => {
    expect(withFolder(["/home/me/Code"], "   ", linuxPlatform)).toBeNull();
    expect(withFolder(["/home/me/Code"], "///", linuxPlatform)).toBeNull();
  });
});
