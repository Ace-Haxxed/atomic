/**
 * The SQL behind `/diff` and the checkpoint list.
 *
 * These run against real SQLite rather than a recorded-call fake, because the
 * failure modes that matter are all in the SQL itself: a wrong `ORDER BY` shows
 * changes in the wrong order, a missing `tool_name` filter puts a terminal
 * transcript in front of the user as if it were a file edit, and a boundary
 * that is off by one silently drops a change.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { ConversationRepository, RunRepository } from "./repositories.js";
import { migratedTestDatabase } from "./sqlite.test-support.js";
import type { Database } from "./database.js";

let db: Database;
let conversations: ConversationRepository;
let runs: RunRepository;

const CONVERSATION = "c1";

/** A write card exactly as `write_file` and `edit_file` persist it. */
function writeDisplay(path: string, extra: Record<string, unknown> = {}) {
  return { kind: "file-write", path, bytes: 10, created: true, ...extra };
}

beforeEach(async () => {
  db = await migratedTestDatabase();
  conversations = new ConversationRepository(db);
  runs = new RunRepository(db);
  await conversations.create({ id: CONVERSATION, mode: "code", workspace: "/w" });
});

describe("changesInRun", () => {
  it("returns nothing for a run that changed no files", async () => {
    // An empty card list renders as blank space, which reads as a failure.
    expect(await conversations.changesInRun(CONVERSATION, "r1")).toEqual([]);
  });;

  it("returns nothing for a run that does not exist", async () => {
    await conversations.addMessage({
      id: "m1",
      conversationId: CONVERSATION,
      role: "tool",
      toolName: "write_file",
      runId: "other",
      display: writeDisplay("a.ts"),
    });
    expect(await conversations.changesInRun(CONVERSATION, "missing")).toEqual([]);
  });

  it("returns one change per file, in the order they were made", async () => {
    for (const [id, path] of [["m1", "a.ts"], ["m2", "b.ts"], ["m3", "c.ts"]]) {
      await conversations.addMessage({
        id: id!,
        conversationId: CONVERSATION,
        role: "tool",
        toolName: "write_file",
        runId: "r1",
        display: writeDisplay(path!),
      });
    }

    const changes = await conversations.changesInRun(CONVERSATION, "r1");
    expect(changes.map((change) => (change.display as { path: string }).path)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  it("keeps repeated edits to the same file as separate changes", async () => {
    // A file edited three times is three reviewable steps. Collapsing them would
    // hide the intermediate states the user approved.
    for (const id of ["m1", "m2", "m3"]) {
      await conversations.addMessage({
        id,
        conversationId: CONVERSATION,
        role: "tool",
        toolName: "edit_file",
        runId: "r1",
        display: writeDisplay("a.ts"),
      });
    }
    expect(await conversations.changesInRun(CONVERSATION, "r1")).toHaveLength(3);
  });

  it("distinguishes a created file from a modified one", async () => {
    await conversations.addMessage({
      id: "m1",
      conversationId: CONVERSATION,
      role: "tool",
      toolName: "write_file",
      runId: "r1",
      display: writeDisplay("new.ts", { created: true }),
    });
    await conversations.addMessage({
      id: "m2",
      conversationId: CONVERSATION,
      role: "tool",
      toolName: "edit_file",
      runId: "r1",
      display: writeDisplay("old.ts", { created: false }),
    });

    const changes = await conversations.changesInRun(CONVERSATION, "r1");
    expect(changes.map((c) => (c.display as { created: boolean }).created)).toEqual([true, false]);
  });

  it("excludes tool results that are not file changes", async () => {
    // A terminal transcript or a todo list is not a diff. Showing one in /diff
    // would be noise, and for bash it would be actively misleading about what
    // changed on disk.
    await conversations.addMessage({
      id: "m1",
      conversationId: CONVERSATION,
      role: "tool",
      toolName: "bash",
      runId: "r1",
      display: { kind: "terminal", command: "rm -rf build" },
    });
    await conversations.addMessage({
      id: "m2",
      conversationId: CONVERSATION,
      role: "tool",
      toolName: "todo_write",
      runId: "r1",
      display: { kind: "todos", items: [] },
    });
    expect(await conversations.changesInRun(CONVERSATION, "r1")).toEqual([]);
  });

  it("excludes user and assistant messages even when they carry a run id", async () => {
    await conversations.addMessage({
      id: "m1",
      conversationId: CONVERSATION,
      role: "user",
      runId: "r1",
      content: [{ type: "text", text: "make a file" }],
    });
    await conversations.addMessage({
      id: "m2",
      conversationId: CONVERSATION,
      role: "assistant",
      runId: "r1",
      content: [{ type: "text", text: "made it" }],
    });
    expect(await conversations.changesInRun(CONVERSATION, "r1")).toEqual([]);
  });;

  it("keeps only the run asked for", async () => {
    // This is the whole reason `run_id` exists: showing changes from the last
    // two runs together would attribute one run's edits to another.
    await conversations.addMessage({
      id: "m1",
      conversationId: CONVERSATION,
      role: "tool",
      toolName: "write_file",
      runId: "r1",
      display: writeDisplay("first.ts"),
    });
    await conversations.addMessage({
      id: "m2",
      conversationId: CONVERSATION,
      role: "tool",
      toolName: "write_file",
      runId: "r2",
      display: writeDisplay("second.ts"),
    });

    const first = await conversations.changesInRun(CONVERSATION, "r1");
    expect(first).toHaveLength(1);
    expect((first[0]?.display as { path: string }).path).toBe("first.ts");
  });

  it("keeps conversations apart", async () => {
    await conversations.create({ id: "c2", mode: "code" });
    await conversations.addMessage({
      id: "m1",
      conversationId: CONVERSATION,
      role: "tool",
      toolName: "write_file",
      runId: "r1",
      display: writeDisplay("a.ts"),
    });
    expect(await conversations.changesInRun("c2", "r1")).toEqual([]);
  });

  it("skips a tool row with no stored display rather than returning a blank card", async () => {
    // A row whose display is null used to become `parseJson("")` -> null and
    // then rendered as an empty card, which looks like a corrupt diff.
    await conversations.addMessage({
      id: "m1",
      conversationId: CONVERSATION,
      role: "tool",
      toolName: "write_file",
      runId: "r1",
      content: [{ type: "text", text: "wrote it" }],
    });
    expect(await conversations.changesInRun(CONVERSATION, "r1")).toEqual([]);
  });;

  it("names the tool that made each change, for the card heading", async () => {
    await conversations.addMessage({
      id: "m1",
      conversationId: CONVERSATION,
      role: "tool",
      toolName: "edit_file",
      runId: "r1",
      display: writeDisplay("a.ts"),
    });
    const [change] = await conversations.changesInRun(CONVERSATION, "r1");
    expect(change?.toolName).toBe("edit_file");
  });

  it("carries the text the model saw, so the card can fall back to it", async () => {
    await conversations.addMessage({
      id: "m1",
      conversationId: CONVERSATION,
      role: "tool",
      toolName: "write_file",
      runId: "r1",
      content: [{ type: "text", text: "Created a.ts (10 bytes)." }],
      display: writeDisplay("a.ts"),
    });
    const [change] = await conversations.changesInRun(CONVERSATION, "r1");
    expect(change?.text).toBe("Created a.ts (10 bytes).");
  });

  it("survives a round trip through storage, so a reload still shows the diff", async () => {
    await conversations.addMessage({
      id: "m1",
      conversationId: CONVERSATION,
      role: "tool",
      toolName: "edit_file",
      runId: "r1",
      content: [{ type: "text", text: "Edited a.ts" }],
      display: writeDisplay("a.ts", { warning: "Couldn't back up a.ts; /undo won't restore it" }),
    });

    // Read back through the normal transcript query, which is what the UI does
    // on load. If display were not persisted this is where it would go missing.
    const reloaded = await conversations.messages(CONVERSATION);
    expect((reloaded[0]?.display as { warning: string }).warning).toContain("won't restore it");
  });
});

describe("RunRepository.list, which backs the checkpoint list", () => {
  /** Insert a run with an explicit start time, since that is the sort key. */
  async function runAt(id: string, startedAt: number) {
    await db.execute(
      `INSERT INTO runs (id, conversation_id, mode, status, steps, started_at)
       VALUES (?, ?, 'code', 'done', 1, ?)`,
      [id, CONVERSATION, startedAt],
    );
  }

  it("returns runs newest first, however they were inserted", async () => {
    // Inserted oldest-first on purpose. `list` backs `/undo`, which takes the
    // first entry, so an ascending sort would restore the wrong run.
    await runAt("r1", 1_000);
    await runAt("r3", 3_000);
    await runAt("r2", 2_000);

    expect((await runs.list(CONVERSATION)).map((run) => run.id)).toEqual(["r3", "r2", "r1"]);
  });

  it("honours the limit, so a long conversation does not load every run", async () => {
    for (let index = 1; index <= 5; index += 1) await runAt(`r${index}`, index * 100);
    expect(await runs.list(CONVERSATION, 2)).toHaveLength(2);
  });

  it("clamps a limit the caller could use to pull the whole table", async () => {
    expect((await runs.list(CONVERSATION, 100_000)).length).toBeLessThanOrEqual(500);
  });

  it("returns nothing for a conversation with no runs", async () => {
    expect(await runs.list(CONVERSATION)).toEqual([]);
  });

  it("keeps runs of different conversations apart", async () => {
    await conversations.create({ id: "c2", mode: "code" });
    await runAt("r1", 1_000);
    await db.execute(
      `INSERT INTO runs (id, conversation_id, mode, status, steps, started_at)
       VALUES ('r2', 'c2', 'code', 'done', 1, 2000)`,
    );
    expect((await runs.list("c2")).map((run) => run.id)).toEqual(["r2"]);
  });

  it("reports a run's status, which decides whether it is worth offering to undo", async () => {
    await runs.start({ id: "r1", conversationId: CONVERSATION, mode: "code" });
    expect((await runs.list(CONVERSATION))[0]?.status).toBe("running");
    await runs.finish("r1", "error", 3, "boom");
    const finished = await runs.list(CONVERSATION);
    expect(finished[0]?.status).toBe("error");
    expect(finished[0]?.finishedAt).toBeTypeOf("number");
  });

  it("records a cancelled run rather than leaving it looking like it is still going", async () => {
    await runs.start({ id: "r1", conversationId: CONVERSATION, mode: "code" });
    await runs.finish("r1", "cancelled", 2);
    expect((await runs.list(CONVERSATION))[0]?.status).toBe("cancelled");
  });
});

describe("supersedeBefore, which compaction and therefore /undo both depend on", () => {
  async function seed(count: number) {
    for (let index = 1; index <= count; index += 1) {
      await conversations.addMessage({
        id: `m${index}`,
        conversationId: CONVERSATION,
        role: index % 2 === 0 ? "assistant" : "user",
        content: [{ type: "text", text: `message ${index}` }],
      });
    }
  }

  it("marks the rows before the boundary and leaves the rest", async () => {
    await seed(6);
    const changed = await conversations.supersedeBefore(CONVERSATION, 4);

    expect(changed).toBe(3);
    const kept = (await conversations.messages(CONVERSATION)).filter((m) => !m.superseded);
    expect(kept.map((m) => m.content[0]?.text)).toEqual(["message 4", "message 5", "message 6"]);
  });

  it("keeps the superseded rows, so the user can still scroll back", async () => {
    await seed(4);
    await conversations.supersedeBefore(CONVERSATION, 3);
    // Deleting them would make a mistaken /compact irreversible. The point of
    // the flag is that clearing it restores the conversation.
    expect(await conversations.messages(CONVERSATION)).toHaveLength(4);
  });

  it("marks every row below a boundary that is past the end", async () => {
    // The boundary is an exclusive upper bound, not a message to keep. This is
    // why `compactionBoundary` falls back to 0 rather than a large number: a
    // boundary past the end here means the whole conversation is folded away.
    await seed(3);
    expect(await conversations.supersedeBefore(CONVERSATION, 999)).toBe(3);
  });

  it("marks nothing at a boundary of zero, which is the fail-safe backstop", async () => {
    await seed(3);
    expect(await conversations.supersedeBefore(CONVERSATION, 0)).toBe(0);
  });

  it("marks nothing when the boundary is the first message", async () => {
    await seed(3);
    expect(await conversations.supersedeBefore(CONVERSATION, 1)).toBe(0);
  });
});
