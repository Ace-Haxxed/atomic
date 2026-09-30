/**
 * The live state of the current agent run.
 *
 * Everything the chat screen shows mid-run comes from the event stream, not from
 * the database: the rows are only written when the run settles. This hook is
 * the single reducer for those events, so "what is on screen" and "what the run
 * is doing" cannot drift apart.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type {
  AgentEvent,
  HostApi,
  Mode,
  PendingApproval,
  Usage,
} from "@atomic/core";
import { EMPTY_USAGE, addUsage } from "@atomic/core";

export type RunStatus =
  | "idle"
  | "running"
  | "awaiting-approval"
  | "done"
  | "error";

export interface ToolActivity {
  readonly callId: string;
  readonly name: string;
  readonly summary: string;
  readonly status: "running" | "ok" | "error";
  readonly detail?: string;
}

/**
 * Another provider could answer this one, if the user says so.
 *
 * Everything the retry needs is in here, so accepting the offer cannot depend
 * on state that has since been cleared -- the run is over by the time the
 * button is pressed.
 */
export interface ProviderOffer {
  readonly model: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly reason: string;
}

export interface RunState {
  readonly runId: string | null;
  readonly conversationId: string | null;
  readonly mode: Mode | null;
  readonly model: string;
  readonly status: RunStatus;
  readonly step: number;
  /** Total steps in a finished run; 0 while it is still going. */
  readonly steps: number;
  /** Assistant text accumulated from deltas, shown as the live bubble. */
  readonly text: string;
  /** Reasoning, kept separate so the UI can collapse it. */
  readonly reasoning: string;
  readonly tools: readonly ToolActivity[];
  readonly pendingApprovals: readonly PendingApproval[];
  readonly usage: Usage;
  readonly error: string | null;
  readonly errorKind: string | null;
  /**
   * Set when the run answered with a different model than the one it started
   * with, naming both the model and -- when it changed too -- the provider.
   *
   * The loop has emitted `model-switch` for a while and the UI dropped it, so a
   * rate limit silently changed which model and which account produced the
   * answer. Shown above the reply rather than in a log nobody opens.
   */
  readonly modelSwitched: string | null;
  /**
   * Something worth saying about a run that otherwise succeeded.
   *
   * Held apart from `error` on purpose. A free model that publishes no price is
   * a fact about the model, not a failure, and putting it in `error` painted a
   * successful answer red and made the reply look lost.
   */
  readonly note: string | null;
  /**
   * A provider the run needs but will not use without permission.
   *
   * A question, not a notice and not an error: the run is over, nothing failed
   * for a reason the user can act on, and the only way forward is a button that
   * re-sends their own message to the provider they approve. Kept out of
   * `error` so it does not read as a crash.
   */
  readonly providerOffer: ProviderOffer | null;
  /**
   * True when the last run was cut off at the provider's output-token limit.
   *
   * The turn still "succeeded" as far as the host is concerned, so nothing else
   * would distinguish it from a finished answer -- and the user is left reading
   * a reply that stops mid-sentence with no way to ask for the rest.
   */
  readonly truncated: boolean;
  /** True once run-finish has been applied. Makes settling idempotent. */
  readonly settled: boolean;
  /** Increments on every run-finish so the screen knows to reload history. */
  readonly settledAt: number;
}

export const IDLE: RunState = {
  runId: null,
  conversationId: null,
  mode: null,
  model: "",
  status: "idle",
  step: 0,
  steps: 0,
  text: "",
  reasoning: "",
  tools: [],
  pendingApprovals: [],
  usage: EMPTY_USAGE,
  error: null,
  errorKind: null,
  modelSwitched: null,
  note: null,
  providerOffer: null,
  truncated: false,
  settled: false,
  settledAt: 0,
};

function upsertTool(
  tools: readonly ToolActivity[],
  next: ToolActivity,
): readonly ToolActivity[] {
  const index = tools.findIndex((tool) => tool.callId === next.callId);
  if (index === -1) return [...tools, next];
  const copy = tools.slice();
  copy[index] = { ...copy[index]!, ...next };
  return copy;
}

/**
 * Exported for tests. The reducer is the only place that interprets run events,
 * so it is where a "streamed text vanished" bug would live.
 */
export function reduce(state: RunState, event: AgentEvent): RunState {
  switch (event.type) {
    case "run-start":
      // A new run clears everything; a stale approval must never survive it.
      return {
        ...IDLE,
        runId: event.runId,
        conversationId: event.conversationId,
        mode: event.mode,
        model: event.model,
        status: "running",
        // A new run resets `settled` and the counter, because the history
        // reload they trigger belongs to this run alone.
        settledAt: 0,
      };
    case "model-switch":
      return state.runId === event.runId
        ? {
            ...state,
            modelSwitched: `Switched to ${event.to}${event.providerLabel ? ` on ${event.providerLabel}` : ""} because ${event.reason}.`,
            // Kept in step with what is actually answering, so the header does
            // not name the model that just failed.
            model: event.to,
          }
        : state;
    case "step-start":
      return state.runId === event.runId ? { ...state, step: event.step } : state;
    case "text-delta":
      return state.runId === event.runId
        ? { ...state, text: state.text + event.text, status: "running" }
        : state;
    case "reasoning-delta":
      return state.runId === event.runId
        ? { ...state, reasoning: state.reasoning + event.text }
        : state;
    case "assistant-message":
      // The authoritative text arrives here; deltas may have been dropped.
      return state.runId === event.runId
        ? { ...state, text: event.text, status: "running" }
        : state;
    case "tool-call":
      return state.runId === event.runId
        ? {
            ...state,
            tools: upsertTool(state.tools, {
              callId: event.call.id,
              name: event.call.name,
              summary: event.summary,
              status: "running",
            }),
          }
        : state;
    case "tool-result":
      return state.runId === event.runId
        ? {
            ...state,
            tools: upsertTool(state.tools, {
              callId: event.callId,
              name: event.tool,
              summary: event.summary,
              status: event.isError ? "error" : "ok",
              ...(event.display === undefined
                ? {}
                : { detail: describeDisplay(event.display) }),
            }),
          }
        : state;
    case "tool-approval-requested":
      return state.runId === event.runId
        ? {
            ...state,
            status: "awaiting-approval",
            pendingApprovals: [
              ...state.pendingApprovals,
              {
                runId: event.runId,
                callId: event.callId,
                tool: event.tool,
                args: event.args,
                summary: event.summary,
                createdAt: Date.now(),
                ...(event.suggestion ? { suggestion: event.suggestion } : {}),
              },
            ],
          }
        : state;
    case "tool-approval-resolved":
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter(
          (approval) => approval.callId !== event.callId,
        ),
        status: state.status === "awaiting-approval" ? "running" : state.status,
      };
    case "usage":
      return state.runId === event.runId
        ? { ...state, usage: addUsage(state.usage, event.usage) }
        : state;
    case "provider-switch-required":
      return state.runId === event.runId
        ? {
            ...state,
            providerOffer: {
              model: event.to,
              providerId: event.providerId,
              providerLabel: event.providerLabel,
              reason: event.reason,
            },
          }
        : state;
    case "run-note":
      // Only the first note of a run: the loop may review every step, and the
      // sentence would otherwise repeat on every tool call.
      return state.runId === event.runId && state.note === null
        ? { ...state, note: event.message }
        : state;
    case "compacted":
    case "run-error":
      if (state.runId !== event.runId) return state;
      return event.type === "run-error"
        ? {
            ...state,
            status: "error",
            error: event.userMessage || event.message,
            errorKind: event.kind,
          }
        : state;
    case "run-finish":
      if (state.runId !== event.runId) return state;
      // A duplicate finish for a run already counted would reload the history a
      // second time, so settling is idempotent. `settled` rather than `status`,
      // because a run that failed still has to settle.
      if (state.settled) return state;
      return {
        ...state,
        status: state.error ? "error" : "done",
        steps: event.steps,
        usage: event.usage,
        // "length" is the provider saying it ran out of room, not that it
        // finished. Everything else, including a tool-calls stop, is a
        // deliberate end to the turn.
        truncated: event.reason === "length",
        settled: true,
        settledAt: state.settledAt + 1,
        // The next run starts clean even if nothing resets it.
        pendingApprovals: [],
      };
    default:
      return state;
  }
}

/** Tool results are `unknown`; only a short, safe string is ever rendered. */
function describeDisplay(display: unknown): string | undefined {
  if (typeof display === "string") return truncate(display, 400);
  if (display === null || display === undefined) return undefined;
  try {
    return truncate(JSON.stringify(display), 400);
  } catch {
    return undefined;
  }
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

export interface AgentController extends RunState {
  readonly isBusy: boolean;
  cancel(): void;
  resolveApproval(callId: string, decision: "allow" | "deny" | "allow-always"): Promise<void>;
}

export function useAgentRun(api: HostApi): AgentController {
  const [state, dispatch] = useReducer(reduce, IDLE);

  // One subscription for the lifetime of the app. Re-subscribing on every render
  // would drop events in the gap and lose streamed text.
  useEffect(() => {
    const iterator = api.streamEvents()[Symbol.asyncIterator]();
    let cancelled = false;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await iterator.next();
          if (cancelled || done) return;
          dispatch(value);
        }
      } catch {
        // The stream only ends if the host is torn down; the UI recovers by
        // re-reading history, so there is nothing useful to report here.
      }
    })();
    return () => {
      cancelled = true;
      void iterator.return?.();
    };
  }, [api]);

  // Read inside callbacks, written in an effect: assigning a ref during render
  // is a side effect that React is free to discard.
  const runIdRef = useRef<string | null>(null);
  useEffect(() => {
    runIdRef.current = state.runId;
  }, [state.runId]);

  const cancel = useCallback(() => {
    const runId = runIdRef.current;
    if (runId) api.cancelRun(runId);
  }, [api]);

  const resolveApproval = useCallback(
    async (callId: string, decision: "allow" | "deny" | "allow-always") => {
      // Drop it locally first: the round trip can take longer than the user
      // expects, and a second click on the same card is a bug, not a decision.
      dispatch({
        type: "tool-approval-resolved",
        runId: runIdRef.current ?? "",
        callId,
        decision: decision === "deny" ? "deny" : "allow",
        rule: "ui",
      });
      await api.resolveApproval(callId, decision);
    },
    [api],
  );

  return useMemo(
    () => ({
      ...state,
      isBusy: state.status === "running" || state.status === "awaiting-approval",
      cancel,
      resolveApproval,
    }),
    [state, cancel, resolveApproval],
  );
}
