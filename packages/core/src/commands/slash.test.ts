/**
 * The rule that matters most here is the one that keeps the parser honest: only
 * a message that is *entirely* a command becomes a command. Everything else is
 * a message, because a message the user cannot send is worse than a missing
 * feature.
 */

import { describe, expect, it } from "vitest";

import {
  SLASH_COMMANDS,
  commandsFor,
  helpText,
  matchCommands,
  parseSlash,
  resolveCommandLine,
} from "./slash.js";

describe("parseSlash", () => {
  it("reads a command with no argument", () => {
    const { parsed } = parseSlash("/undo", "code");
    expect(parsed.command?.name).toBe("undo");
    expect(parsed.argument).toBe("");
  });

  it("keeps the argument", () => {
    const { parsed } = parseSlash("/model  gpt-4o  ", "code");
    expect(parsed.command?.name).toBe("model");
    expect(parsed.argument).toBe("gpt-4o");
  });

  it("ignores leading whitespace", () => {
    expect(parseSlash("   /clear", "code").parsed.command?.name).toBe("clear");
  });

  it("treats ordinary prose as a message", () => {
    const { parsed } = parseSlash("run /help for me", "code");
    expect(parsed.command).toBeNull();
    expect(parsed.looksLikeCommand).toBe(false);
  });

  it("treats an unknown slash word as text, not as a command", () => {
    // `/usr/bin/env` is a path a user might genuinely want to discuss.
    const { parsed, unknown } = parseSlash("/usr/bin/env", "code");
    expect(parsed.command).toBeNull();
    expect(unknown).toBe("usr/bin/env");
  });

  it("refuses a command that does not belong to this mode", () => {
    const { unavailable } = parseSlash("/undo", "chat");
    expect(unavailable?.name).toBe("undo");
    expect(parseSlash("/undo", "chat").parsed.command).toBeNull();
  });

  it("allows the always-available commands in every mode", () => {
    for (const mode of ["chat", "code", "cowork"]) {
      expect(parseSlash("/clear", mode).parsed.command?.name).toBe("clear");
      expect(parseSlash("/help", mode).parsed.command?.name).toBe("help");
    }
  });

  it("is case sensitive about the name, so it cannot be guessed into a command", () => {
    expect(parseSlash("/UNDO", "code").parsed.command).toBeNull();
  });
});

describe("matchCommands", () => {
  it("lists everything for an empty query", () => {
    expect(matchCommands("", "code")).toHaveLength(commandsFor("code").length);
  });

  it("finds a command by its keyword, not only by its name", () => {
    expect(matchCommands("revert", "code")[0]?.name).toBe("undo");
    expect(matchCommands("tokens", "code")[0]?.name).toBe("compact");
  });

  it("works with or without the leading slash", () => {
    expect(matchCommands("/und", "code")[0]?.name).toBe("undo");
  });

  it("hides Code-only commands in Chat mode", () => {
    expect(matchCommands("undo", "chat")).toEqual([]);
    expect(matchCommands("", "chat").map((c) => c.name)).not.toContain("undo");
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(matchCommands("zzz", "code")).toEqual([]);
  });
});

describe("helpText", () => {
  it("lists only the commands for the current mode", () => {
    expect(helpText("code")).toContain("/undo");
    expect(helpText("chat")).not.toContain("/undo");
  });

  it("describes every available command", () => {
    const text = helpText("code");
    for (const command of commandsFor("code")) {
      expect(text).toContain(`/${command.name}`);
    }
  });
});

describe("the command list itself", () => {
  it("has no duplicate names", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks the ones that change files as destructive", () => {
    // Anything that writes or deletes has to be confirmable, and a command with
    // no flag to base that on is the thing to catch here.
    for (const name of ["undo", "compact"]) {
      expect(SLASH_COMMANDS.find((c) => c.name === name)?.destructive, name).toBe(true);
    }
    // `clear` keeps the old conversation, so it is not destructive and must not
    // make the user confirm a command that cannot lose anything.
    expect(SLASH_COMMANDS.find((c) => c.name === "clear")?.destructive).toBeUndefined();
  });
});

describe("resolveCommandLine", () => {
  it("resolves a bare command", () => {
    expect(resolveCommandLine("/undo", "code")?.command.name).toBe("undo");
  });


  it("keeps a multi-word argument intact", () => {
    expect(resolveCommandLine("/model the opus model", "code")?.argument).toBe("the opus model");
  });

  it("refuses a prefix, so a typo cannot execute the obvious command", () => {
    // `/hel` must not quietly run `/help`.
    expect(resolveCommandLine("/hel", "code")).toBeNull();
  });

  it("ignores surrounding whitespace and letter case", () => {
    expect(resolveCommandLine("  /Undo  ", "code")?.command.name).toBe("undo");
  });

  it("treats plain text as a message, not a command", () => {
    expect(resolveCommandLine("run the tests", "code")).toBeNull();
  });



  it("does not offer a command the current mode does not have", () => {
    // `/undo` is code-only; in chat mode it must stay sendable text.
    expect(resolveCommandLine("/undo", "chat")).toBeNull();
  });

  it("ignores a bare slash", () => {
    expect(resolveCommandLine("/", "code")).toBeNull();
  });
});
