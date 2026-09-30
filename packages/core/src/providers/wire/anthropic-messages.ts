/**
 * Anthropic Messages wire format.
 *
 * Serves Zen's Claude family and some Qwen builds. `POST {base}/messages` with
 * `x-api-key`, `anthropic-version: 2023-06-01` and `stream: true`.
 *
 * Notes specific to this protocol:
 *  - the system prompt is a top-level field, not a message
 *  - tool results are `user` messages containing `tool_result` blocks
 *  - thinking blocks are content blocks with a `signature` that must be echoed
 *    back verbatim on the next turn
 */

import { ProviderError, ProviderErrorKind } from "../errors.js";
import { createThinkTagSplitter } from "../reasoning-tags.js";
import { HttpClient, assertOk, redactUrl } from "../http.js";
import { SSE_DONE, parseSse, safeJsonParse } from "../sse.js";
import {
  EMPTY_USAGE,
  type ContentPart,
  type FinishReason,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ReasoningEffort,
  type StreamEvent,
  type ToolCall,
  type ToolSpec,
  type Usage,
} from "../../models/types.js";

export const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS_FALLBACK = 8192;

export interface AnthropicOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly http: HttpClient;
  readonly providerId: string;
  readonly ownKey?: string | undefined;
  /** Zen fronts Anthropic itself, so a `Bearer` variant is also accepted. */
  readonly authStyle?: "x-api-key" | "bearer";
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export function buildMessagesUrl(baseUrl: string): string {
  return `${trimSlash(baseUrl)}/messages`;
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
}

export function mapMessagesToAnthropic(
  messages: readonly ModelMessage[],
): unknown[] {
  const out: unknown[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
        // Handled separately by the caller; keep it out of the message list.
        break;
      case "user":
        out.push({ role: "user", content: mapUserBlocks(message.content) });
        break;
      case "assistant": {
        const blocks: unknown[] = [];
        if (message.reasoning?.text) {
          blocks.push({
            type: "thinking",
            thinking: message.reasoning.text,
            signature: message.reasoning.signature || "",
          });
        }
        for (const part of message.content) {
          if (part.type === "text")
            blocks.push({ type: "text", text: part.text });
        }
        for (const call of message.toolCalls ?? []) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.args,
          });
        }
        if (blocks.length) out.push({ role: "assistant", content: blocks });
        break;
      }
      case "tool": {
        // Consecutive tool results belong in one user message.
        const result = {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content: textOf(message.content) || "(no output)",
          ...(message.toolName ? {} : {}),
        };
        const last = out[out.length - 1] as
          { role: string; content: unknown[] } | undefined;
        if (
          last &&
          last.role === "user" &&
          Array.isArray(last.content) &&
          isToolResultTurn(last.content)
        ) {
          last.content.push(result);
        } else {
          out.push({ role: "user", content: [result] });
        }
        break;
      }
    }
  }
  return out;
}

function isToolResultTurn(blocks: unknown[]): boolean {
  return (
    blocks.length > 0 &&
    blocks.every((block) => (block as AnthropicBlock)?.type === "tool_result")
  );
}

function mapUserBlocks(content: readonly ContentPart[]): unknown[] {
  const blocks: unknown[] = [];
  for (const part of content) {
    if (part.type === "text") blocks.push({ type: "text", text: part.text });
    else if (part.type === "image") {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: part.mimeType,
          data: stripDataUrl(part.data),
        },
      });
    } else if (part.type === "file") {
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: part.mimeType,
          data: stripDataUrl(part.data),
        },
      });
    }
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

function stripDataUrl(data: string): string {
  const comma = data.indexOf(",");
  return data.startsWith("data:") && comma > -1 ? data.slice(comma + 1) : data;
}

export function mapToolsToAnthropic(tools: readonly ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export function buildMessagesBody(
  request: ModelRequest,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? MAX_TOKENS_FALLBACK,
    messages: mapMessagesToAnthropic(request.messages),
  };
  if (request.system) body.system = request.system;
  if (request.tools?.length) {
    body.tools = mapToolsToAnthropic(request.tools);
    body.tool_choice = { type: "auto" };
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.reasoningEffort && request.reasoningEffort !== "none") {
    const budget = reasoningBudget(
      request.reasoningEffort,
      request.maxOutputTokens ?? MAX_TOKENS_FALLBACK,
    );
    if (budget > 0) body.thinking = { type: "enabled", budget_tokens: budget };
    if (request.temperature !== undefined) delete body.temperature;
  }
  return body;
}

function reasoningBudget(
  effort: Exclude<ReasoningEffort, "none">,
  maxTokens: number,
): number {
  const ratio =
    effort === "low"
      ? 0.25
      : effort === "medium"
        ? 0.5
        : effort === "high"
          ? 0.75
          : 0.9;
  const budget = Math.floor(maxTokens * ratio);
  // Anthropic requires budget_tokens < max_tokens and a minimum of 1024.
  return Math.max(1024, Math.min(budget, maxTokens - 1024));
}

export function buildMessagesHeaders(
  options: AnthropicOptions,
): Record<string, string> {
  const key = options.ownKey ?? options.apiKey;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": ANTHROPIC_VERSION,
    ...(options.extraHeaders ?? {}),
  };
  // No key means no auth header at all -- never an empty credential.
  if (key) {
    if (options.authStyle === "bearer") headers.authorization = `Bearer ${key}`;
    else headers["x-api-key"] = key;
  }
  return headers;
}

export async function* streamAnthropicMessages(
  options: AnthropicOptions,
  request: ModelRequest,
): AsyncGenerator<StreamEvent> {
  const url = buildMessagesUrl(options.baseUrl);
  const response = await options.http.request(
    {
      method: "POST",
      url,
      headers: buildMessagesHeaders(options),
      body: JSON.stringify(buildMessagesBody(request, true)),
      signal: request.signal,
      retries: 0,
      diagnostics: { dialect: "anthropic-messages", authHeader: "x-api-key" },
    },
    options.providerId,
  );
  if (!response.ok || !response.body) {
    await assertOk(response, redactUrl(url));
    throw new ProviderError(
      ProviderErrorKind.parse,
      "empty_body",
      "Provider returned no stream body",
    );
  }

  const calls = new Map<number, { id: string; name: string; args: string }>();
  const nextIndexByBlock = new Map<number, number>();
  let toolIndex = 0;
  // See openai-chat.ts: content may carry inline `<think>` reasoning.
  const thinks = createThinkTagSplitter();
  let text = "";
  let reasoning = "";
  let thinkingSignature = "";
  let usage: Usage = EMPTY_USAGE;
  let finishReason: FinishReason = "stop";

  for await (const event of parseSse(response.body, request.signal)) {
    if (event.data === SSE_DONE) break;
    const payload = safeJsonParse<Record<string, unknown>>(event.data);
    if (!payload) continue;
    const type = stringOr(payload.type, event.event ?? "");

    switch (type) {
      case "message_start": {
        const message = asRecord(payload.message);
        usage = mergeUsage(usage, mapAnthropicUsage(message?.usage));
        break;
      }
      case "content_block_start": {
        const block = asRecord(payload.content_block);
        const rawIndex = num(payload.index, 0);
        if (block?.type === "tool_use") {
          const index = toolIndex++;
          nextIndexByBlock.set(rawIndex, index);
          const entry = {
            id: stringOr(block.id, `toolu_${index}`),
            name: stringOr(block.name),
            args: "",
          };
          calls.set(index, entry);
          if (entry.name)
            yield {
              type: "tool-call-start",
              index,
              id: entry.id,
              name: entry.name,
            };
        } else if (block?.type === "thinking") {
          thinkingSignature = stringOr(block.signature, "");
        }
        break;
      }
      case "content_block_delta": {
        const delta = asRecord(payload.delta);
        const deltaType = stringOr(delta?.type);
        const rawIndex = num(payload.index, 0);
        if (deltaType === "text_delta") {
          // Anthropic has a first-class thinking channel, but models served
          // through Anthropic-compatible endpoints still sometimes inline
          // `<think>` in text, so content goes through the same splitter.
          const chunk = stringOr(delta?.text);
          if (chunk) {
            const split = thinks.push(chunk);
            if (split.text) {
              text += split.text;
              yield { type: "text-delta", text: split.text };
            }
            if (split.reasoning) {
              reasoning += split.reasoning;
              yield { type: "reasoning-delta", text: split.reasoning };
            }
          }
        } else if (deltaType === "thinking_delta") {
          const chunk = stringOr(delta?.thinking);
          if (chunk) {
            reasoning += chunk;
            yield { type: "reasoning-delta", text: chunk };
          }
        } else if (deltaType === "signature_delta") {
          thinkingSignature += stringOr(delta?.signature);
        } else if (deltaType === "input_json_delta") {
          const index = nextIndexByBlock.get(rawIndex) ?? 0;
          const chunk = stringOr(delta?.partial_json);
          if (chunk) {
            const entry = calls.get(index) ?? {
              id: `toolu_${index}`,
              name: "",
              args: "",
            };
            entry.args += chunk;
            calls.set(index, entry);
            yield { type: "tool-call-delta", index, argsDelta: chunk };
          }
        }
        break;
      }
      case "message_delta": {
        const delta = asRecord(payload.delta);
        finishReason = mapAnthropicStopReason(stringOr(delta?.stop_reason, ""));
        usage = mergeUsage(usage, mapAnthropicUsage(payload.usage));
        break;
      }
      case "message_stop":
        break;
      case "error": {
        const error = asRecord(payload.error);
        throw new ProviderError(
          ProviderErrorKind.server,
          "anthropic_error",
          stringOr(error?.message, "Provider stream reported an error"),
        );
      }
      default:
        break;
    }
  }

  // Release any partial tag held back at the end of the stream, so nothing the
  // model emitted goes missing from the saved message.
  const finalSplit = thinks.flush();
  if (finalSplit.text) {
    text += finalSplit.text;
    yield { type: "text-delta", text: finalSplit.text };
  }
  if (finalSplit.reasoning) {
    reasoning += finalSplit.reasoning;
    yield { type: "reasoning-delta", text: finalSplit.reasoning };
  }

  const toolCalls: ToolCall[] = [];
  for (const [index, entry] of [...calls.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const parsed =
      safeJsonParse<Record<string, unknown>>(entry.args || "{}") ?? {};
    const call: ToolCall = {
      id: entry.id || `toolu_${index}`,
      name: entry.name,
      args:
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? parsed
          : {},
      rawArgs: entry.args || "{}",
      index,
    };
    toolCalls.push(call);
    yield { type: "tool-call-end", index, call };
  }

  const message: ModelMessage = {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(reasoning
      ? { reasoning: { text: reasoning, signature: thinkingSignature } }
      : {}),
  };
  yield { type: "usage", usage };
  yield {
    type: "done",
    message,
    usage,
    finishReason: toolCalls.length ? "tool-calls" : finishReason,
  };
}

export async function completeAnthropicMessages(
  options: AnthropicOptions,
  request: ModelRequest,
): Promise<ModelResponse> {
  const url = buildMessagesUrl(options.baseUrl);
  const response = await options.http.request(
    {
      method: "POST",
      url,
      headers: buildMessagesHeaders(options),
      body: JSON.stringify(buildMessagesBody(request, false)),
      signal: request.signal,
      retries: 0,
      diagnostics: { dialect: "anthropic-messages", authHeader: "x-api-key" },
    },
    options.providerId,
  );
  await assertOk(response, redactUrl(url));
  const payload = (await response.json()) as {
    id?: string;
    stop_reason?: string;
    usage?: unknown;
    content?: AnthropicBlock[];
  };

  let text = "";
  let reasoning = "";
  let signature = "";
  const toolCalls: ToolCall[] = [];
  (payload.content ?? []).forEach((block, index) => {
    if (block.type === "text" && block.text) text += block.text;
    else if (block.type === "thinking") {
      reasoning += block.thinking ?? "";
      signature = block.signature ?? signature;
    } else if (block.type === "tool_use") {
      const input = (block.input ?? {}) as Record<string, unknown>;
      toolCalls.push({
        id: block.id ?? `toolu_${index}`,
        name: block.name ?? "",
        args: input,
        rawArgs: JSON.stringify(input),
        index,
      });
    }
  });

  return {
    message: {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(reasoning ? { reasoning: { text: reasoning, signature } } : {}),
    },
    usage: mapAnthropicUsage(payload.usage),
    finishReason: toolCalls.length
      ? "tool-calls"
      : mapAnthropicStopReason(payload.stop_reason ?? ""),
    ...(payload.id ? { responseId: payload.id } : {}),
  };
}

export function mapAnthropicUsage(usage: unknown): Usage {
  const record = asRecord(usage);
  if (!record) return EMPTY_USAGE;
  const input = num(record.input_tokens);
  const output = num(record.output_tokens);
  const cacheRead = num(record.cache_read_input_tokens);
  const cacheWrite = num(record.cache_creation_input_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

function mergeUsage(a: Usage, b: Usage): Usage {
  if (b.inputTokens === 0 && b.outputTokens === 0) return a;
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    totalTokens: Math.max(a.totalTokens, b.totalTokens),
    cacheReadTokens:
      Math.max(a.cacheReadTokens ?? 0, b.cacheReadTokens ?? 0) || undefined,
    cacheWriteTokens:
      Math.max(a.cacheWriteTokens ?? 0, b.cacheWriteTokens ?? 0) || undefined,
  };
}

export function mapAnthropicStopReason(reason: string): FinishReason {
  switch (reason) {
    case "tool_use":
      return "tool-calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content-filter";
    default:
      return "stop";
  }
}

function textOf(content: readonly ContentPart[]): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
