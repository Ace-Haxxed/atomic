import { describe, expect, it } from "vitest";
import { authorizedRoots, hasAllowedFolders } from "./roots.js";
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
