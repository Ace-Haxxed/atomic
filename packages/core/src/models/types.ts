/**
 * Wire-format-neutral model types.
 *
 * Every provider adapter converts to and from these, so the agent loop never
 * knows whether the model behind it speaks OpenAI Chat Completions, the OpenAI
 * Responses API, Anthropic Messages, or Google Generative Language.
 */

import { z } from "zod";

export const RoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type Role = z.infer<typeof RoleSchema>;

/** A tool declaration in provider-neutral form (JSON Schema in, JSON Schema out). */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema (draft 2020-12 subset) describing the arguments object. */
  readonly parameters: Record<string, unknown>;
}

export type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; /** base64 payload or data URL */ readonly data: string; readonly mimeType: string }
  | { readonly type: "file"; readonly data: string; readonly mimeType: string; readonly name?: string }
  | { readonly type: "thinking"; readonly text: string; readonly signature?: string };

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Parsed arguments. Empty object when the model sent none. */
  readonly args: Record<string, unknown>;
  /** Raw JSON string as sent by the model, kept for auditing and retries. */
  readonly rawArgs: string;
  /** Index within the assistant message, needed to merge streamed deltas. */
  readonly index: number;
}

export interface ModelMessage {
  readonly role: Role;
  readonly content: readonly ContentPart[];
  /** Present on assistant messages. */
  readonly toolCalls?: readonly ToolCall[];
  /** Present on tool messages; references `ToolCall.id`. */
  readonly toolCallId?: string;
  /** Present on tool messages; identifies the tool that produced it. */
  readonly toolName?: string;
  /** Anthropic-style thinking blocks to round-trip on the next request. */
  readonly reasoning?: { readonly text: string; readonly signature: string } | null;
}

export const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export interface ModelRequest {
  readonly providerId: string;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly system?: string;
  readonly tools?: readonly ToolSpec[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: ReasoningEffort;
  /** Stable prefix so providers with prompt caching can reuse it. */
  readonly cacheKey?: string;
  readonly signal?: AbortSignal;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens: number;
}

export const EMPTY_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export type StreamEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "tool-call-start"; readonly index: number; readonly id: string; readonly name: string }
  | { readonly type: "tool-call-delta"; readonly index: number; readonly argsDelta: string }
  | { readonly type: "tool-call-end"; readonly index: number; readonly call: ToolCall }
  | { readonly type: "usage"; readonly usage: Usage }
  | { readonly type: "done"; readonly message: ModelMessage; readonly usage: Usage; readonly finishReason: FinishReason };

export type FinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "error" | "cancelled";

export interface ModelResponse {
  readonly message: ModelMessage;
  readonly usage: Usage;
  readonly finishReason: FinishReason;
  /** Provider-native id, e.g. `chatcmpl-…` / `msg_…`. */
  readonly responseId?: string;
}

export type { ContentPart as MessagePart };
