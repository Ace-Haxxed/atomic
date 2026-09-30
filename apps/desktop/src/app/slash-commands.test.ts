/**
 * The commands that change something are the ones worth testing. The rest are
 * labels over an API call the UI already exercises.
 *
 * The fakes here are deliberately strict: an unexpected call throws, so a
 * command that quietly grows a side effect fails here rather than surprising
 * someone later.
 */

import { describe, expect, it, vi } from "vitest";
import type { HostApi, Mode, Settings, SlashCommand } from "@atomic/core";
import { SettingsSchema } from "@atomic/core";

import { runSlashCommand, type CommandContext, type SlashResult } from "./slash-commands.js";

/**
 * The text a command produced. Asserting on the whole result object would make
 * every test care about which field a command happens to use, so most of them
 * ask for the note and read it.
 */
async function noteOf(
  name: string,
  argument: string,
  context: CommandContext,
): Promise<string> {
  const result: SlashResult | null = await runSlashCommand(command(name), argument, context);
  return result?.note ?? "";
}

function command(name: string): SlashCommand {
  return { name, summary: "", mode: null };
}

function harness(overrides: Partial<CommandContext> = {}) {
  const calls: string[] = [];
  const context: CommandContext = {
    api: {
      compactConversation: vi.fn(async () => ({ removed: 4, freedTokens: 1200 })),
      latestRunChanges: vi.fn(async () => ({
        runId: "r2",
        changes: [
          { toolName: "edit_file", display: { kind: "file-write", path: "b.ts" } },
          { toolName: "write_file", display: { kind: "file-write", path: "a.ts" } },
        ],
      })),
      listCheckpoints: vi.fn(async () => [
        {
          runId: "r2",
          createdAt: 2,
          files: [
            { path: "b.ts", existed: true, bytes: 10 },
            { path: "c.ts", existed: false, bytes: 0 },
          ],
        },
        {
          runId: "r1",
          createdAt: 1,
          files: [{ path: "a.ts", existed: true, bytes: 5 }],
        },
      ]),
      restoreCheckpoint: vi.fn(async (input: { runId: string }) =>
        input.runId === "r2" ? ["b.ts", "c.ts"] : ["a.ts"],
      ),
    } as unknown as HostApi,
    mode: "code" as Mode,
    settings: SettingsSchema.parse({}) as Settings,
    conversationId: "c1",
    newChat: async () => {
      calls.push("newChat");
    },
    setModel: async (id) => {
      calls.push(`model:${id}`);
    },
    setLevel: async (level) => {
      calls.push(`level:${level}`);
    },
    fail: (message) => {
      calls.push(`fail:${message}`);
    },
    ...overrides,
  };
  return { context, calls };
}

describe("/undo", () => {
  it("restores the most recent run by default", async () => {
    const { context } = harness();
    const note = await noteOf("undo", "", context);
    expect(context.api.restoreCheckpoint).toHaveBeenCalledWith({ conversationId: "c1", runId: "r2" });
    expect(note).toContain("b.ts, c.ts");
  });

  it("restores the named run when given one", async () => {
    const { context } = harness();
    await runSlashCommand(command("undo"), "r1", context);
    expect(context.api.restoreCheckpoint).toHaveBeenCalledWith({ conversationId: "c1", runId: "r1" });
  });

  it("says so when there is nothing to undo, rather than restoring nothing quietly", async () => {
    const { context } = harness({
      api: {
        listCheckpoints: async () => [],
        restoreCheckpoint: vi.fn(),
      } as unknown as HostApi,
    });
    const note = await noteOf("undo", "", context);
    expect(note).toContain("nothing to undo");
    expect(context.api.restoreCheckpoint).not.toHaveBeenCalled();
  });

  it("does not restore when the named run is unknown", async () => {
    const { context, calls } = harness();
    await runSlashCommand(command("undo"), "nope", context);
    // Restoring a run that does not exist would otherwise look like a silent
    // no-op, and the user would think their file was put back.
    expect(context.api.restoreCheckpoint).not.toHaveBeenCalled();
    expect(calls.some((call) => call.startsWith("fail:"))).toBe(true);
  });

  it("does nothing without a conversation", async () => {
    const { context } = harness({ conversationId: null });
    const note = await noteOf("undo", "", context);
    expect(note).toContain("no conversation");
    expect(context.api.restoreCheckpoint).not.toHaveBeenCalled();
  });
});

describe("/checkpoints", () => {
  it("lists runs newest first with the files they touched", async () => {
    const { context } = harness();
    const note = await noteOf("checkpoints", "", context);
    expect(note).toContain("b.ts, c.ts");
    expect(note).toContain("a.ts");
    // Newest first: the list order is the whole value, since /undo takes the
    // first entry.
    expect(note.indexOf("b.ts")).toBeLessThan(note.indexOf("a.ts"));
  });

  it("handles a conversation with no runs", async () => {
    const { context } = harness({
      api: { listCheckpoints: async () => [] } as unknown as HostApi,
    });
    expect(await noteOf("checkpoints", "", context)).toContain("No runs");
  });
});

describe("/compact", () => {
  it("reports how much it folded away", async () => {
    const { context } = harness();
    const note = await noteOf("compact", "", context);
    expect(note).toContain("4 earlier messages");
    // The user should be told the transcript is still there, because losing
    // scrollback is the thing people fear when they compact.
    expect(note).toContain("still here");
  });

  it("says so when there was nothing to compact", async () => {
    const { context } = harness({
      api: { compactConversation: async () => ({ removed: 0, freedTokens: 0 }) } as unknown as HostApi,
    });
    expect(await noteOf("compact", "", context)).toContain("Nothing to compact");
  });
});

describe("/plan and /model", () => {
  it("turns on plan mode and says what it means", async () => {
    const { context, calls } = harness();
    const note = await noteOf("plan", "", context);
    expect(calls).toContain("level:plan");
    expect(note).toContain("cannot act on");
  });

  it("maps a bare word to Auto, because Auto is the default state", async () => {
    const { context, calls } = harness();
    await runSlashCommand(command("model"), "AUTO", context);
    expect(calls).toContain("model:");
  });

  it("points at the header when given no model", async () => {
    const { context, calls } = harness();
    const note = await noteOf("model", "", context);
    expect(calls).toEqual([]);
    expect(note).toContain("header");
  });
});

describe("/diff", () => {
  it("returns the last run's changes as cards, oldest first", async () => {
    const { context } = harness();
    const result = await runSlashCommand(command("diff"), "", context);
    expect(result!.cards).toEqual([
      { toolName: "edit_file", display: { kind: "file-write", path: "b.ts" } },
      { toolName: "write_file", display: { kind: "file-write", path: "a.ts" } },
    ]);
    expect(result!.note).toBeUndefined();
  });

  it("says so when the last run changed nothing", async () => {
    const { context } = harness({
      api: { latestRunChanges: async () => ({ runId: "r1", changes: [] }) } as unknown as HostApi,
    });
    // An empty card list would render as blank space and look like a failure.
    expect(await noteOf("diff", "", context)).toContain("did not write or edit any files");
  });

  it("says so when no run has finished yet", async () => {
    const { context } = harness({
      api: { latestRunChanges: async () => null } as unknown as HostApi,
    });
    expect(await noteOf("diff", "", context)).toContain("No run has finished");
  });
});

describe("the restore caveat", () => {
  it("is on the list of runs, where a user chooses to undo", async () => {
    const { context } = harness();
    const note = await noteOf("checkpoints", "", context);
    // Without this the user can reasonably read "/undo" as "put my run back".
    expect(note).toContain("file tools only");
  });

  it("is on the confirmation after a restore", async () => {
    const { context } = harness();
    expect(await noteOf("undo", "", context)).toContain("file tools only");
  });
});

describe("/clear", () => {
  it("starts a fresh conversation", async () => {
    const { context, calls } = harness();
    expect(await runSlashCommand(command("clear"), "", context)).toBeNull();
    expect(calls).toEqual(["newChat"]);
  });
});
