/**
 * OpenAI Chat Completions wire format.
 *
 * Serves the majority of Zen models: DeepSeek, GLM, Kimi, MiniMax, and the
 * free tier. `POST {base}/chat/completions` with `stream: true` and
 * `stream_options: { include_usage: true }` for token accounting.
 */

import { ProviderError, ProviderErrorKind } from "../errors.js";
import { assertOk, HttpClient, redactUrl } from "../http.js";
import { createThinkTagSplitter } from "../reasoning-tags.js";
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

export interface OpenAiChatOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly http: HttpClient;
  readonly providerId: string;
  /** Zen puts some models on a first-party API; the key can be overridden. */
  readonly ownKey?: string | undefined;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

const REASONING_EFFORT_VALUES: Record<
  Exclude<ReasoningEffort, "none">,
  string
> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "high",
};

export function buildChatUrl(baseUrl: string): string {
  return `${trimSlash(baseUrl)}/chat/completions`;
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function mapMessagesToChat(
  messages: readonly ModelMessage[],
  system?: string,
): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: textOf(message.content) });
        break;
      case "user":
        out.push({ role: "user", content: mapUserContent(message.content) });
        break;
      case "assistant": {
        const entry: Record<string, unknown> = {
          role: "assistant",
          content: textOf(message.content) || null,
        };
        if (message.reasoning?.text)
          entry.reasoning_content = message.reasoning.text;
        if (message.toolCalls?.length) {
          entry.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.rawArgs || "{}" },
          }));
        }
        out.push(entry);
        break;
      }
      case "tool":
        out.push({
          role: "tool",
          tool_call_id: message.toolCallId ?? "",
          content: textOf(message.content) || "(no output)",
        });
        break;
    }
  }
  return out;
}

function mapUserContent(content: readonly ContentPart[]): unknown {
  const images = content.filter((part) => part.type === "image");
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n");
  if (images.length === 0) return text;
  return [
    { type: "text", text },
    ...images.map((part) => {
      const image = part as Extract<ContentPart, { type: "image" }>;
      const url = image.data.startsWith("data:")
        ? image.data
        : `data:${image.mimeType};base64,${image.data}`;
      return { type: "image_url", image_url: { url } };
    }),
  ];
}

export function mapToolsToChat(tools: readonly ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function buildChatBody(
  request: ModelRequest,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: mapMessagesToChat(request.messages, request.system),
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (request.tools?.length) {
    body.tools = mapToolsToChat(request.tools);
    body.tool_choice = "auto";
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined)
    body.max_tokens = request.maxOutputTokens;
  if (request.reasoningEffort && request.reasoningEffort !== "none") {
    body.reasoning_effort = REASONING_EFFORT_VALUES[request.reasoningEffort];
  }
  return body;
}

export function buildChatHeaders(
  options: OpenAiChatOptions,
): Record<string, string> {
  const key = options.ownKey ?? options.apiKey;
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    // Omitted entirely when there is no key, rather than sent as an empty
    // `Bearer `. Several Zen models are reachable without any credential, and a
    // header that claims a token and supplies none is a worse signal than no
    // header at all -- it is also malformed.
    ...(key ? { authorization: `Bearer ${key}` } : {}),
    ...(options.extraHeaders ?? {}),
  };
}

export async function* streamChatCompletions(
  options: OpenAiChatOptions,
  request: ModelRequest,
): AsyncGenerator<StreamEvent> {
  const url = buildChatUrl(options.baseUrl);
  const body = JSON.stringify(buildChatBody(request, true));
  const response = await options.http.request(
    {
      method: "POST",
      url,
      headers: buildChatHeaders(options),
      body,
      signal: request.signal,
      retries: 0,
      diagnostics: { dialect: "openai-chat", authHeader: "authorization" },
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

  const toolBuffers = new Map<
    number,
    { id: string; name: string; args: string }
  >();
  // Several models put `<think>` reasoning in the content channel instead of a
  // reasoning field, so content is split before anything is emitted. A chunk
  // that is only half a tag must not reach the UI: showing `</think>` and then
  // retracting it is the flicker this avoids.
  const thinks = createThinkTagSplitter();
  let text = "";
  let reasoning = "";
  let usage: Usage = EMPTY_USAGE;
  let finishReason: FinishReason = "stop";

  for await (const event of parseSse(response.body, request.signal)) {
    if (event.data === SSE_DONE) break;
    const chunk = safeJsonParse<ChatChunk>(event.data);
    if (!chunk) continue;

    if (chunk.usage) usage = mapChatUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    // `choices: []` is a real chunk: the usage-only frame Zen and OpenRouter
    // send at the end. Usage above is read first, so skipping is safe.
    if (!choice) continue;
    if (choice.finish_reason)
      finishReason = mapChatFinishReason(choice.finish_reason);

    const delta = choice.delta;
    if (!delta) continue;

    // A single chunk can carry reasoning and content at once (the real Zen
    // space-bunny-free stream does), so both are read from every delta.
    const explicitReasoning = delta.reasoning_content ?? delta.reasoning;
    if (explicitReasoning) {
      reasoning += explicitReasoning;
      yield { type: "reasoning-delta", text: explicitReasoning };
    }
    if (delta.content) {
      const split = thinks.push(delta.content);
      if (split.text) {
        text += split.text;
        yield { type: "text-delta", text: split.text };
      }
      if (split.reasoning) {
        reasoning += split.reasoning;
        yield { type: "reasoning-delta", text: split.reasoning };
      }
    }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? toolBuffers.size;
      const existing = toolBuffers.get(index) ?? { id: "", name: "", args: "" };
      if (call.id) existing.id = call.id;
      if (call.function?.name) {
        if (!existing.name) {
          existing.name = call.function.name;
          toolBuffers.set(index, existing);
          yield {
            type: "tool-call-start",
            index,
            id: existing.id,
            name: existing.name,
          };
        }
      }
      if (call.function?.arguments) {
        existing.args += call.function.arguments;
        toolBuffers.set(index, existing);
        yield {
          type: "tool-call-delta",
          index,
          argsDelta: call.function.arguments,
        };
      }
    }
  }

  // End of stream: release a partial tag or an unterminated think block. Without
  // this, text the model actually emitted would be missing from the saved
  // message, since the splitter deliberately held it back.
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
  for (const [index, buffer] of [...toolBuffers.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const call = finalizeToolCall(index, buffer.id, buffer.name, buffer.args);
    toolCalls.push(call);
    yield { type: "tool-call-end", index, call };
  }

  const message: ModelMessage = {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(reasoning ? { reasoning: { text: reasoning, signature: "" } } : {}),
  };
  const finalFinish: FinishReason = toolCalls.length
    ? "tool-calls"
    : finishReason;
  yield { type: "usage", usage };
  yield { type: "done", message, usage, finishReason: finalFinish };
}

export async function completeChat(
  options: OpenAiChatOptions,
  request: ModelRequest,
): Promise<ModelResponse> {
  const url = buildChatUrl(options.baseUrl);
  const response = await options.http.request(
    {
      method: "POST",
      url,
      headers: buildChatHeaders(options),
      body: JSON.stringify(buildChatBody(request, false)),
      signal: request.signal,
      retries: 0,
      diagnostics: { dialect: "openai-chat", authHeader: "authorization" },
    },
    options.providerId,
  );
  await assertOk(response, redactUrl(url));
  const payload = (await response.json()) as ChatCompletion;
  const choice = payload.choices?.[0];
  const message = choice?.message;
  const toolCalls = (message?.tool_calls ?? []).map((call, index) =>
    finalizeToolCall(
      index,
      call.id ?? "",
      call.function?.name ?? "",
      call.function?.arguments ?? "",
    ),
  );
  return {
    message: {
      role: "assistant",
      content: message?.content
        ? [{ type: "text", text: message.content }]
        : [],
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(reasoningTextOf(message)
        ? { reasoning: { text: reasoningTextOf(message)!, signature: "" } }
        : {}),
    },
    usage: mapChatUsage(payload.usage),
    finishReason: toolCalls.length
      ? "tool-calls"
      : mapChatFinishReason(choice?.finish_reason ?? "stop"),
    ...(payload.id ? { responseId: payload.id } : {}),
  };
}

export function finalizeToolCall(
  index: number,
  id: string,
  name: string,
  rawArgs: string,
): ToolCall {
  const parsed = safeJsonParse<Record<string, unknown>>(rawArgs || "{}") ?? {};
  return {
    id: id || `call_${index}`,
    name,
    args:
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed
        : {},
    rawArgs: rawArgs || "{}",
    index,
  };
}

export function mapChatFinishReason(
  reason: string | null | undefined,
): FinishReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool-calls";
    case "length":
      return "length";
    case "content_filter":
      return "content-filter";
    case "stop":
      return "stop";
    default:
      return "stop";
  }
}

export function mapChatUsage(usage: ChatUsage | undefined): Usage {
  if (!usage) return EMPTY_USAGE;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cached || undefined,
    totalTokens: usage.total_tokens ?? input + output,
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
    // The one number here that is a bill rather than an estimate. Present on
    // OpenRouter and OpenCode Zen responses; absent on most, which is why it is
    // optional and why nothing can assume it exists.
    ...(typeof usage.cost === "number" && Number.isFinite(usage.cost)
      ? { reportedCost: usage.cost }
      : {}),
  };
}

/** Either reasoning spelling, so the two wire dialects behave identically. */
function reasoningTextOf(message:
  | {
      reasoning_content?: string | null;
      reasoning?: string | null;
    }
  | undefined): string {
  return message?.reasoning_content ?? message?.reasoning ?? "";
}

function textOf(content: readonly ContentPart[]): string {
  return content
    .filter((part) => part.type === "text" || part.type === "thinking")
    .map((part) => (part as { text: string }).text)
    .join("\n");
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** USD charged for this turn, where the provider reports it. */
  cost?: number;
}

interface ChatChunk {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      /** DeepSeek/GLM-style. */
      reasoning_content?: string | null;
      /** OpenRouter-style. */
      reasoning?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: ChatUsage;
}

interface ChatCompletion {
  id?: string;
  model?: string;
  choices: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: ChatUsage;
}
