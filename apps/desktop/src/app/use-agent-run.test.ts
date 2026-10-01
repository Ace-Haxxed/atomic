/**
 * The run reducer decides what the user sees mid-run, so these tests are about
 * the states that are easy to get wrong: a new run starting while a previous one
 * is still on screen, events from a stale run arriving late, and an approval that
 * must not survive the run it belonged to.
 */

import { describe, expect, it } from "vitest";
import type { AgentEvent, Usage } from "@atomic/core";

import { IDLE, reduce, type RunState } from "./use-agent-run.js";

const apply = (state: RunState, ...events: AgentEvent[]): RunState =>
  events.reduce(reduce, state);

const runStart: AgentEvent = {
  type: "run-start",
  runId: "run-1",
  conversationId: "conv-1",
  mode: "code",
  model: "claude-sonnet",
};

const usage: Usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

describe("reduce", () => {
  it("accumulates text deltas in order", () => {
    const state = apply(
      IDLE,
      runStart,
      { type: "text-delta", runId: "run-1", messageId: "m1", text: "Hello" },
      { type: "text-delta", runId: "run-1", messageId: "m1", text: " world" },
    );
    expect(state.text).toBe("Hello world");
    expect(state.status).toBe("running");
  });

  it("lets the final assistant message replace the streamed text", () => {
    // Deltas can be dropped by a provider; the authoritative text wins.
    const state = apply(
      IDLE,
      runStart,
      { type: "text-delta", runId: "run-1", messageId: "m1", text: "par" },
      {
        type: "assistant-message",
        runId: "run-1",
        messageId: "m1",
        text: "the complete answer",
        finishReason: "stop",
      },
    );
    expect(state.text).toBe("the complete answer");
  });

  it("keeps reasoning separate from the answer", () => {
    const state = apply(
      IDLE,
      runStart,
      { type: "reasoning-delta", runId: "run-1", messageId: "m1", text: "thinking" },
      { type: "text-delta", runId: "run-1", messageId: "m1", text: "answer" },
    );
    expect(state.reasoning).toBe("thinking");
    expect(state.text).toBe("answer");
  });

  it("ignores events from a run that is not on screen", () => {
    const state = apply(IDLE, runStart, {
      type: "text-delta",
      runId: "run-other",
      messageId: "m1",
      text: "leaked",
    });
    expect(state.text).toBe("");
  });

  it("clears a previous run's text and approvals when a new run starts", () => {
    const first = apply(
      IDLE,
      runStart,
      { type: "text-delta", runId: "run-1", messageId: "m1", text: "stale" },
      {
        type: "tool-approval-requested",
        runId: "run-1",
        callId: "call-1",
        tool: "bash",
        args: { command: "ls" },
        mode: "code",
        summary: "ls",
      },
    );
    expect(first.pendingApprovals).toHaveLength(1);

    const second = reduce(first, { ...runStart, runId: "run-2" });
    expect(second.text).toBe("");
    expect(second.pendingApprovals).toEqual([]);
    expect(second.usage.totalTokens).toBe(0);
    expect(second.runId).toBe("run-2");
    expect(second.settled).toBe(false);
    expect(second.settledAt).toBe(0);
  });

  it("tracks a tool from running to a result", () => {
    const state = apply(
      IDLE,
      runStart,
      {
        type: "tool-call",
        runId: "run-1",
        messageId: "m1",
        summary: "read 3 files",
        call: { id: "c1", name: "read", args: {}, rawArgs: "{}", index: 0 },
      },
      {
        type: "tool-result",
        runId: "run-1",
        callId: "c1",
        tool: "read",
        isError: false,
        summary: "3 files",
        display: "a.ts",
      },
    );
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({
      callId: "c1",
      name: "read",
      status: "ok",
      detail: "a.ts",
    });
  });

  it("marks a failed tool as an error", () => {
    const state = apply(IDLE, runStart, {
      type: "tool-result",
      runId: "run-1",
      callId: "c1",
      tool: "bash",
      isError: true,
      summary: "exit 1",
    });
    expect(state.tools[0]?.status).toBe("error");
  });

  it("survives a tool result whose display is not serialisable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const state = apply(IDLE, runStart, {
      type: "tool-result",
      runId: "run-1",
      callId: "c1",
      tool: "read",
      isError: false,
      summary: "ok",
      display: circular,
    });
    // A circular structure must not take the run down with it.
    expect(state.tools[0]?.status).toBe("ok");
    expect(state.tools[0]?.detail).toBeUndefined();
  });

  it("blocks on an approval and resumes once it is resolved", () => {
    const waiting = apply(IDLE, runStart, {
      type: "tool-approval-requested",
      runId: "run-1",
      callId: "c1",
      tool: "bash",
      args: { command: "rm -rf build" },
      mode: "code",
      summary: "rm -rf build",
      suggestion: "rm -rf build",
    });
    expect(waiting.status).toBe("awaiting-approval");
    expect(waiting.pendingApprovals[0]?.suggestion).toBe("rm -rf build");

    const resumed = reduce(waiting, {
      type: "tool-approval-resolved",
      runId: "run-1",
      callId: "c1",
      decision: "allow",
      rule: "ui",
    });
    expect(resumed.pendingApprovals).toEqual([]);
    expect(resumed.status).toBe("running");
  });

  it("sums usage across steps", () => {
    const state = apply(
      IDLE,
      runStart,
      { type: "usage", runId: "run-1", usage, model: "m" },
      { type: "usage", runId: "run-1", usage, model: "m" },
    );
    expect(state.usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    });
  });

  it("keeps the error and reports it after the run finishes", () => {
    const failed = apply(IDLE, runStart, {
      type: "run-error",
      runId: "run-1",
      message: "401 Unauthorized",
      userMessage: "Your API key was rejected.",
      kind: "auth",
    });
    expect(failed).toMatchObject({
      status: "error",
      error: "Your API key was rejected.",
      errorKind: "auth",
    });

    const settled = reduce(failed, {
      type: "run-finish",
      runId: "run-1",
      reason: "error",
      steps: 1,
      usage,
    });
    // A run that failed must not flip to "done" when the finish event lands.
    expect(settled.status).toBe("error");
    // A failed run still settles, otherwise its rows would never be reloaded.
    expect(settled.settledAt).toBe(1);
    expect(settled.settled).toBe(true);
  });

  it("bumps settledAt once per finished run so the UI reloads history", () => {
    const finish: AgentEvent = {
      type: "run-finish",
      runId: "run-1",
      reason: "stop",
      steps: 3,
      usage,
    };
    const once = apply(IDLE, runStart, finish);
    expect(once.settledAt).toBe(1);
    expect(once.steps).toBe(3);
    // A duplicated finish must not reload the history twice.
    expect(reduce(once, finish).settledAt).toBe(1);
    expect(reduce(once, finish).settled).toBe(true);
  });

  it("records the step number while the run advances", () => {
    const state = apply(
      IDLE,
      runStart,
      { type: "step-start", runId: "run-1", step: 1 },
      { type: "step-start", runId: "run-1", step: 2 },
    );
    expect(state.step).toBe(2);
  });

  it("ignores an unknown event instead of throwing", () => {
    const state = reduce(IDLE, { type: "not-a-real-event" } as unknown as AgentEvent);
    expect(state).toBe(IDLE);
  });
});

/**
 * The model-switch notice.
 *
 * The loop has always emitted this event, and the UI used to drop it. A rate
 * limit therefore changed which model produced an answer with nothing on screen
 * saying so -- and after cross-provider fallback it also changes which account
 * was used, which is the fact a user least wants to infer.
 */
describe("a model switch", () => {
  const running = reduce(IDLE, {
    type: "run-start",
    runId: "r1",
    conversationId: "c1",
    mode: "chat",
    model: "space-bunny-free",
  });

  it("says what switched and why", () => {
    const next = reduce(running, {
      type: "model-switch",
      runId: "r1",
      from: "space-bunny-free",
      to: "local-qwen",
      reason: "it hit a rate limit",
    });
    expect(next.modelSwitched).toContain("local-qwen");
    expect(next.modelSwitched).toContain("rate limit");
  });

  it("names the provider when the switch also changed account", () => {
    const next = reduce(running, {
      type: "model-switch",
      runId: "r1",
      from: "zen-model",
      to: "router-model",
      reason: "it hit a rate limit",
      providerLabel: "OpenRouter",
    });
    // Without this the notice is identical for a Zen rate limit and an
    // OpenRouter one, and the user cannot tell what changed.
    expect(next.modelSwitched).toContain("OpenRouter");
    expect(next.modelSwitched).toContain("router-model");
  });

  it("keeps the header on the model that is actually answering", () => {
    const next = reduce(running, {
      type: "model-switch",
      runId: "r1",
      from: "space-bunny-free",
      to: "local-qwen",
      reason: "it hit a rate limit",
    });
    // Otherwise the header names the model that just failed while the reply
    // underneath came from somewhere else.
    expect(next.model).toBe("local-qwen");
  });

  it("ignores a switch belonging to another run", () => {
    const switched = reduce(running, {
      type: "model-switch",
      runId: "r1",
      from: "a",
      to: "b",
      reason: "rate limit",
    });
    const other = reduce(switched, {
      type: "model-switch",
      runId: "r2",
      from: "x",
      to: "y",
      reason: "rate limit",
    });
    // The event is rejected on runId, so this run's own notice survives intact
    // rather than being overwritten by another run's switch.
    expect(other.modelSwitched).toBe(switched.modelSwitched);
    expect(other.model).toBe("b");
  });

  it("is cleared by the next run", () => {
    const switched = reduce(running, {
      type: "model-switch",
      runId: "r1",
      from: "a",
      to: "b",
      reason: "rate limit",
    });
    const next = reduce(switched, {
      type: "run-start",
      runId: "r2",
      conversationId: "c2",
      mode: "chat",
      model: "fresh",
    });
    // A notice about last run's provider hanging around on a new one is worse
    // than no notice: it describes something that is no longer happening.
    expect(next.modelSwitched).toBeNull();
  });
});

/**
 * Truncation.
 *
 * The run "succeeded", so status alone cannot tell the user that the answer
 * stops early. Without this the reply looks finished and the only way to get the
 * rest is to rephrase the question from scratch.
 */
describe("a provider switch offer", () => {
  const offer: AgentEvent = {
    type: "provider-switch-required",
    runId: "run-1",
    from: "claude-sonnet",
    to: "gpt-4o",
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    reason: "it hit a rate limit",
  };

  it("names the model, the account, and why", () => {
    const state = apply(IDLE, runStart, offer);
    expect(state.providerOffer).toEqual({
      model: "gpt-4o",
      providerId: "openrouter",
      providerLabel: "OpenRouter",
      reason: "it hit a rate limit",
    });
  });

  /**
   * The offer is how the user finds out which account holds their conversation.
   * As an error it read as a crash with a cause they could not act on.
   */
  it("is a question, not an error", () => {
    const state = apply(IDLE, runStart, offer);
    expect(state.error).toBeNull();
    expect(state.status).not.toBe("error");
  });

  it("does not survive the next run", () => {
    const state = apply(IDLE, runStart, offer, {
      type: "run-start",
      runId: "run-2",
      conversationId: "conv-1",
      mode: "code",
      model: "claude-sonnet",
    });
    expect(state.providerOffer).toBeNull();
  });

  it("ignores an offer from a run that is no longer on screen", () => {
    const state = apply(IDLE, runStart, { ...offer, runId: "run-0" });
    expect(state.providerOffer).toBeNull();
  });
});

describe("a cost note", () => {
  /**
   * The note and the switch both want to be the one line above the transcript.
   * One slot for each meant whichever arrived second erased the first, so a
   * switch stopped being reported the moment a note became possible.
   */
  it("keeps the first note only, and does not error", () => {
    const state = apply(IDLE, runStart, {
      type: "run-note",
      runId: "run-1",
      message: "qwen3 does not publish a per-token price.",
    });
    expect(state.note).toBe("qwen3 does not publish a per-token price.");
    expect(state.error).toBeNull();

    const second = apply(state, {
      type: "run-note",
      runId: "run-1",
      message: "The same sentence again.",
    });
    expect(second.note).toBe("qwen3 does not publish a per-token price.");
  });
});

describe("a truncated turn", () => {
  const truncatedRun = reduce(
    reduce(IDLE, {
      type: "run-start",
      runId: "r1",
      conversationId: "c1",
      mode: "chat",
      model: "m",
    }),
    {
    type: "run-finish",
    runId: "r1",
    reason: "length",
    steps: 1,
      usage: { inputTokens: 10, outputTokens: 4096, totalTokens: 4106 },
    },
  );

  it("is flagged so the UI can offer Continue", () => {
    expect(truncatedRun.truncated).toBe(true);
    // Status stays "done": nothing failed, and showing an error for a
    // token-limit stop would be wrong.
    expect(truncatedRun.status).toBe("done");
  });

  it("is not flagged for a run stopped by one of the app's own limits", () => {
    // `run-finish` used to report every limit stop as `length`, because the
    // reason had nowhere else to put it. So hitting the step, runtime or spend
    // limit showed the user "This answer stopped at the model's output limit, so
    // it may be incomplete" -- a confident and wrong explanation of a run that
    // had simply worked too hard. The reason is now its own value, and this is
    // what that buys: the message does not appear, and the limit's own
    // explanation does.
    for (const reason of ["limit", "error", "cancelled"] as const) {
      const stopped = reduce(
        reduce(IDLE, {
          type: "run-start",
          runId: "r1",
          conversationId: "c1",
          mode: "chat",
          model: "m",
        }),
        {
          type: "run-finish",
          runId: "r1",
          reason,
          steps: 200,
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        },
      );
      expect(stopped.truncated, reason).toBe(false);
    }
  });

  it("is not flagged for an ordinary completion", () => {
    const done = reduce(
      reduce(IDLE, {
        type: "run-start",
        runId: "r1",
        conversationId: "c1",
        mode: "chat",
        model: "m",
      }),
      {
        type: "run-finish",
        runId: "r1",
        reason: "stop",
        steps: 1,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
    );
    expect(done.truncated).toBe(false);
  });

  it("is cleared by the next turn", () => {
    const next = reduce(truncatedRun, {
      type: "run-start",
      runId: "r2",
      conversationId: "c1",
      mode: "chat",
      model: "m",
    });
    // Otherwise a later, complete answer keeps offering to continue.
    expect(next.truncated).toBe(false);
  });
});
