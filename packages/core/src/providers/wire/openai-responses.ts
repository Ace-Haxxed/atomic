/**
 * OpenAI Responses API wire format.
 *
 * Serves Zen's GPT family, Grok, Muse Spark. `POST {base}/responses` with
 * `stream: true`. Events are typed (`response.output_text.delta`,
 * `response.function_call_arguments.delta`, …) and items are indexed, so tool
 * calls are assembled per output item rather than per array index.
 */

import { ProviderError, ProviderErrorKind } from "../errors.js";
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

export interface OpenAiResponsesOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly http: HttpClient;
  readonly providerId: string;
  readonly ownKey?: string | undefined;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

const EFFORT_VALUES: Record<
  Exclude<ReasoningEffort, "none">,
  "low" | "medium" | "high"
> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "high",
};

export function buildResponsesUrl(baseUrl: string): string {
  return `${trimSlash(baseUrl)}/responses`;
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function mapMessagesToResponses(
  messages: readonly ModelMessage[],
  system?: string,
): unknown[] {
  const input: unknown[] = [];
  if (system) input.push({ role: "system", content: system });

  for (const message of messages) {
    switch (message.role) {
      case "system":
        input.push({ role: "system", content: textOf(message.content) });
        break;
      case "user":
        input.push({ role: "user", content: mapUserContent(message.content) });
        break;
      case "assistant": {
        const text = textOf(message.content);
        if (text) input.push({ role: "assistant", content: text });
        for (const call of message.toolCalls ?? []) {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: call.rawArgs || "{}",
          });
        }
        break;
      }
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: message.toolCallId ?? "",
          output: textOf(message.content) || "(no output)",
        });
        break;
    }
  }
  return input;
}

function mapUserContent(content: readonly ContentPart[]): unknown {
  const parts: unknown[] = [];
  for (const part of content) {
    if (part.type === "text")
      parts.push({ type: "input_text", text: part.text });
    else if (part.type === "image") {
      parts.push({
        type: "input_image",
        image_url: part.data.startsWith("data:")
          ? part.data
          : `data:${part.mimeType};base64,${part.data}`,
      });
    } else if (part.type === "file") {
      parts.push({
        type: "input_file",
        filename: part.name ?? "attachment",
        file_data: part.data.startsWith("data:")
          ? part.data
          : `data:${part.mimeType};base64,${part.data}`,
      });
    }
  }
  return parts.length ? parts : [{ type: "input_text", text: "" }];
}

export function mapToolsToResponses(tools: readonly ToolSpec[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function buildResponsesBody(
  request: ModelRequest,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    input: mapMessagesToResponses(request.messages, request.system),
    stream,
    store: false,
  };
  if (request.tools?.length) {
    body.tools = mapToolsToResponses(request.tools);
    body.tool_choice = "auto";
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined)
    body.max_output_tokens = request.maxOutputTokens;
  if (request.reasoningEffort && request.reasoningEffort !== "none") {
    body.reasoning = { effort: EFFORT_VALUES[request.reasoningEffort] };
  }
  return body;
}

export function buildResponsesHeaders(
  options: OpenAiResponsesOptions,
): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    // See `buildChatHeaders`: no key means no header, not an empty token.
    ...((options.ownKey ?? options.apiKey)
      ? { authorization: `Bearer ${options.ownKey ?? options.apiKey}` }
      : {}),
    ...(options.extraHeaders ?? {}),
  };
}

export async function* streamResponsesApi(
  options: OpenAiResponsesOptions,
  request: ModelRequest,
): AsyncGenerator<StreamEvent> {
  const url = buildResponsesUrl(options.baseUrl);
  const response = await options.http.request(
    {
      method: "POST",
      url,
      headers: buildResponsesHeaders(options),
      body: JSON.stringify(buildResponsesBody(request, true)),
      signal: request.signal,
      retries: 0,
      diagnostics: { dialect: "openai-responses", authHeader: "authorization" },
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
  let text = "";
  let reasoning = "";
  let usage: Usage = EMPTY_USAGE;
  let finishReason: FinishReason = "stop";

  for await (const event of parseSse(response.body, request.signal)) {
    if (event.data === SSE_DONE) break;
    const type = event.event || readType(event.data);
    if (!type) continue;

    switch (type) {
      case "response.output_text.delta": {
        const delta = readString(event.data, "delta");
        if (delta) {
          text += delta;
          yield { type: "text-delta", text: delta };
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const delta = readString(event.data, "delta");
        if (delta) {
          reasoning += delta;
          yield { type: "reasoning-delta", text: delta };
        }
        break;
      }
      case "response.output_item.added": {
        const item = readObject(event.data, "item");
        if (item?.type === "function_call") {
          const index = numberOr(
            readNumber(event.data, "output_index"),
            calls.size,
          );
          const entry = {
            id: stringOr(item.call_id, stringOr(item.id, `call_${index}`)),
            name: stringOr(item.name, ""),
            args: "",
          };
          calls.set(index, entry);
          if (entry.name) {
            yield {
              type: "tool-call-start",
              index,
              id: entry.id,
              name: entry.name,
            };
          }
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const index = numberOr(readNumber(event.data, "output_index"), 0);
        const delta = readString(event.data, "delta");
        if (delta) {
          const entry = calls.get(index) ?? {
            id: `call_${index}`,
            name: "",
            args: "",
          };
          entry.args += delta;
          calls.set(index, entry);
          yield { type: "tool-call-delta", index, argsDelta: delta };
        }
        break;
      }
      case "response.function_call_arguments.done": {
        const index = numberOr(readNumber(event.data, "output_index"), 0);
        const entry = calls.get(index);
        if (entry) {
          const doneArgs = readString(event.data, "arguments");
          if (doneArgs) entry.args = doneArgs;
        }
        break;
      }
      case "response.output_item.done": {
        const item = readObject(event.data, "item");
        if (item?.type === "function_call") {
          const index = numberOr(
            readNumber(event.data, "output_index"),
            calls.size,
          );
          const entry = calls.get(index) ?? {
            id: stringOr(item.call_id, stringOr(item.id, `call_${index}`)),
            name: "",
            args: "",
          };
          entry.name = stringOr(item.name, entry.name);
          if (typeof item.arguments === "string" && item.arguments)
            entry.args = item.arguments;
          entry.id = stringOr(item.call_id, entry.id);
          calls.set(index, entry);
        }
        break;
      }
      case "response.completed": {
        const payload = readObject(event.data, "response");
        if (payload) {
          usage = mapResponsesUsage(payload.usage);
          finishReason = mapResponsesFinishReason(
            stringOr(payload.status, "completed"),
          );
        }
        break;
      }
      case "response.incomplete":
      case "response.failed": {
        const payload = readObject(event.data, "response");
        finishReason = type === "response.failed" ? "error" : "length";
        if (payload) usage = mapResponsesUsage(payload.usage);
        break;
      }
      case "error": {
        const message = extractErrorMessage(event.data);
        throw new ProviderError(
          ProviderErrorKind.server,
          "responses_error",
          message,
        );
      }
      default:
        break;
    }
  }

  const toolCalls: ToolCall[] = [];
  for (const [index, entry] of [...calls.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const parsed =
      safeJsonParse<Record<string, unknown>>(entry.args || "{}") ?? {};
    const call: ToolCall = {
      id: entry.id || `call_${index}`,
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
    ...(reasoning ? { reasoning: { text: reasoning, signature: "" } } : {}),
  };
  yield { type: "usage", usage };
  yield {
    type: "done",
    message,
    usage,
    finishReason: toolCalls.length ? "tool-calls" : finishReason,
  };
}

export async function completeResponsesApi(
  options: OpenAiResponsesOptions,
  request: ModelRequest,
): Promise<ModelResponse> {
  const url = buildResponsesUrl(options.baseUrl);
  const response = await options.http.request(
    {
      method: "POST",
      url,
      headers: buildResponsesHeaders(options),
      body: JSON.stringify(buildResponsesBody(request, false)),
      signal: request.signal,
      retries: 0,
      diagnostics: { dialect: "openai-responses", authHeader: "authorization" },
    },
    options.providerId,
  );
  await assertOk(response, redactUrl(url));
  const payload = (await response.json()) as ResponsesPayload;

  let text = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  (payload.output ?? []).forEach((item, index) => {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) text += part.text;
      }
    } else if (item.type === "function_call") {
      const parsed =
        safeJsonParse<Record<string, unknown>>(item.arguments || "{}") ?? {};
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call_${index}`,
        name: item.name ?? "",
        args:
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
            ? parsed
            : {},
        rawArgs: item.arguments || "{}",
        index,
      });
    } else if (item.type === "reasoning") {
      for (const summary of item.summary ?? [])
        if (summary.text) reasoning += summary.text;
    }
  });

  return {
    message: {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(reasoning ? { reasoning: { text: reasoning, signature: "" } } : {}),
    },
    usage: mapResponsesUsage(payload.usage),
    finishReason: toolCalls.length
      ? "tool-calls"
      : mapResponsesFinishReason(payload.status ?? "completed"),
    ...(payload.id ? { responseId: payload.id } : {}),
  };
}

export function mapResponsesUsage(usage: unknown): Usage {
  const record = asRecord(usage);
  if (!record) return EMPTY_USAGE;
  const input = num(record.input_tokens);
  const output = num(record.output_tokens);
  const cached = num(
    record.input_tokens_details
      ? asRecord(record.input_tokens_details)?.cached_tokens
      : 0,
  );
  const reasoning = num(
    record.output_tokens_details
      ? asRecord(record.output_tokens_details)?.reasoning_tokens
      : 0,
  );
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: num(record.total_tokens) || input + output,
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  };
}

export function mapResponsesFinishReason(status: string): FinishReason {
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return status === "cancelled" ? "cancelled" : "error";
    default:
      return "stop";
  }
}

function readType(data: string): string | undefined {
  const record = safeJsonParse<Record<string, unknown>>(data);
  return record ? stringOr(record.type) : undefined;
}

function readObject(
  data: string,
  key: string,
): Record<string, unknown> | undefined {
  const record = safeJsonParse<Record<string, unknown>>(data);
  return record ? asRecord(record[key]) : undefined;
}

function readString(data: string, key: string): string {
  const record = safeJsonParse<Record<string, unknown>>(data);
  return record ? stringOr(record[key]) : "";
}

function readNumber(data: string, key: string): number | undefined {
  const record = safeJsonParse<Record<string, unknown>>(data);
  return record ? maybeNum(record[key]) : undefined;
}

function extractErrorMessage(data: string): string {
  const record = safeJsonParse<Record<string, unknown>>(data);
  const errorNode = record ? asRecord(record.error) : undefined;
  return stringOr(errorNode?.message, "Provider stream reported an error");
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
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function maybeNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
function numberOr(value: number | undefined, fallback: number): number {
  return value ?? fallback;
}

interface ResponsesPayload {
  id?: string;
  status?: string;
  usage?: unknown;
  output?: {
    type: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    summary?: { text?: string }[];
    content?: { type: string; text?: string }[];
  }[];
}
