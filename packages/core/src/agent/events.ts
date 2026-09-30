/**
 * Agent events.
 *
 * The UI subscribes to this. The same event union is what a future remote
 * client would receive over a socket, so it is JSON-serialisable and flat.
 */

import type { FinishReason, ToolCall, Usage } from "../models/types.js";
import type { Mode } from "../settings/schema.js";

export type AgentEvent =
  | { readonly type: "run-start"; readonly runId: string; readonly conversationId: string; readonly mode: Mode; readonly model: string }
  | { readonly type: "step-start"; readonly runId: string; readonly step: number }
  | { readonly type: "text-delta"; readonly runId: string; readonly messageId: string; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly runId: string; readonly messageId: string; readonly text: string }
  | { readonly type: "assistant-message"; readonly runId: string; readonly messageId: string; readonly text: string; readonly finishReason: FinishReason }
  | { readonly type: "tool-call"; readonly runId: string; readonly messageId: string; readonly call: ToolCall; readonly summary: string }
  | { readonly type: "tool-approval-requested"; readonly runId: string; readonly callId: string; readonly tool: string; readonly args: Record<string, unknown>; readonly summary: string; readonly suggestion?: string }
  | { readonly type: "tool-approval-resolved"; readonly runId: string; readonly callId: string; readonly decision: "allow" | "deny"; readonly rule: string }
  | { readonly type: "tool-result"; readonly runId: string; readonly callId: string; readonly tool: string; readonly isError: boolean; readonly summary: string; readonly display?: unknown }
  | { readonly type: "usage"; readonly runId: string; readonly usage: Usage; readonly model: string }
  | { readonly type: "compacted"; readonly runId: string; readonly removedMessages: number; readonly freedTokens: number }
  | { readonly type: "run-error"; readonly runId: string; readonly message: string; readonly userMessage: string; readonly kind: string }
  /** A runtime fallback swapped models mid-turn; the UI shows a one-line notice. */
  | {
      readonly type: "model-switch";
      readonly runId: string;
      readonly from: string;
      readonly to: string;
      readonly reason: string;
      /** Set when the switch also changed provider, so the UI can name it. */
      readonly providerLabel?: string;
    }
  | { readonly type: "run-finish"; readonly runId: string; readonly reason: FinishReason; readonly steps: number; readonly usage: Usage };

export type AgentEventType = AgentEvent["type"];

export type AgentEventListener = (event: AgentEvent) => void;

export class AgentEventBus {
  #listeners = new Set<AgentEventListener>();
  /** Bounded ring buffer so a reconnecting client can replay recent history. */
  #history: AgentEvent[] = [];
  #historyLimit: number;

  constructor(historyLimit = 500) {
    this.#historyLimit = historyLimit;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: AgentEvent): void {
    this.#history.push(event);
    if (this.#history.length > this.#historyLimit) {
      this.#history.splice(0, this.#history.length - this.#historyLimit);
    }
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        // One bad subscriber must not break the loop.
        console.error("[agent] event listener failed", error);
      }
    }
  }

  history(): readonly AgentEvent[] {
    return this.#history;
  }

  clear(): void {
    this.#history.length = 0;
  }
}
