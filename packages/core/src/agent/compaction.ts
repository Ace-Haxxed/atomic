/**
 * Context compaction.
 *
 * When a conversation grows past the model's usable window, older turns are
 * summarised away. The most recent turns are always kept verbatim so the agent
 * does not lose track of what it is doing right now.
 */

import type { ModelMessage, Usage } from "../models/types.js";
import { EMPTY_USAGE, addUsage } from "../models/types.js";

/** Rough token estimate. Deliberately cheap; no tokenizer dependency. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~4 chars per token for English prose, ~3 for code-heavy content.
  return Math.ceil(text.length / 3.5);
}

export function estimateMessageTokens(message: ModelMessage): number {
  let total = 4; // per-message overhead
  for (const part of message.content) {
    total += part.type === "text" || part.type === "thinking" ? estimateTokens(part.text) : 512;
  }
  for (const call of message.toolCalls ?? []) {
    total += estimateTokens(call.name) + estimateTokens(call.rawArgs);
  }
  if (message.reasoning?.text) total += estimateTokens(message.reasoning.text);
  return total;
}

export function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

export interface CompactionOptions {
  /** Total window across all messages. */
  readonly contextWindow: number;
  /** Reserve room for the next response and tool results. */
  readonly reserveTokens?: number;
  /** Never touch the last N messages. */
  readonly keepRecent?: number;
  /** Fraction of the window at which compaction triggers. */
  readonly triggerRatio?: number;
}

export interface CompactionPlan {
  /** Index of the first message to keep verbatim. */
  readonly keepFrom: number;
  readonly removeCount: number;
  readonly totalTokens: number;
  readonly threshold: number;
  readonly needsCompaction: boolean;
}

export function planCompaction(
  messages: readonly ModelMessage[],
  options: CompactionOptions,
): CompactionPlan {
  const keepRecent = Math.max(2, options.keepRecent ?? 8);
  const reserve = options.reserveTokens ?? 4096;
  const ratio = options.triggerRatio ?? 0.85;
  const totalTokens = estimateMessagesTokens(messages);
  const threshold = Math.max(1024, Math.floor((options.contextWindow - reserve) * ratio));

  if (totalTokens <= threshold || messages.length <= keepRecent) {
    return { keepFrom: 0, removeCount: 0, totalTokens, threshold, needsCompaction: false };
  }

  // Never split a tool call from its result: walk back to a message boundary
  // that leaves the most recent tool block intact.
  let keepFrom = messages.length - keepRecent;
  while (keepFrom > 0 && messages[keepFrom]?.role === "tool") keepFrom--;

  return {
    keepFrom,
    removeCount: keepFrom,
    totalTokens,
    threshold,
    needsCompaction: keepFrom > 0,
  };
}

export interface CompactionResult {
  readonly messages: ModelMessage[];
  readonly removedMessages: number;
  readonly freedTokens: number;
  readonly summary: string;
}

const SUMMARY_PREFIX = "Earlier in this conversation (compacted summary):";

/**
 * Replace older messages with a single summary message.
 * `summarize` is supplied by the caller so the provider used is swappable.
 */
export async function compactMessages(
  messages: readonly ModelMessage[],
  plan: CompactionPlan,
  summarize: (text: string, signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  if (!plan.needsCompaction) {
    return { messages: [...messages], removedMessages: 0, freedTokens: 0, summary: "" };
  }

  const older = messages.slice(0, plan.keepFrom);
  const kept = messages.slice(plan.keepFrom);
  const transcript = renderForSummary(older);
  const summaryText = await summarize(transcript, signal);
  const summary: ModelMessage = {
    role: "user",
    content: [{ type: "text", text: `${SUMMARY_PREFIX}\n${summaryText}` }],
  };

  const before = estimateMessagesTokens(older);
  const after = estimateMessageTokens(summary);
  return {
    messages: [summary, ...kept],
    removedMessages: older.length,
    freedTokens: Math.max(0, before - after),
    summary: summaryText,
  };
}

function renderForSummary(messages: readonly ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : part.type === "thinking" ? part.text : `[${part.type}]`))
      .join(" ")
      .trim();
    if (message.role === "tool") {
      lines.push(`tool(${message.toolName ?? "?"}): ${text.slice(0, 400)}`);
    } else if (message.role === "assistant" && message.toolCalls?.length) {
      lines.push(
        `assistant: ${text} [called ${message.toolCalls.map((c) => c.name).join(", ")}]`,
      );
    } else if (text) {
      lines.push(`${message.role}: ${text}`);
    }
  }
  return lines.join("\n");
}

/** Sum usage across a run for the "tokens used" footer. */
export function totalUsage(usages: readonly Usage[]): Usage {
  return usages.reduce(addUsage, EMPTY_USAGE);
}
