/**
 * Google Generative Language wire format.
 *
 * Serves Zen's Gemini family. Unlike the OpenAI family, Gemini has no
 * `system` role inside `contents`; the system instruction is a top-level field.
 * Function calls arrive pre-parsed (no argument streaming).
 *
 * The API key goes in the `x-goog-api-key` header — never the query string, so
 * it cannot leak through proxy or server logs.
 */

import { ProviderError, ProviderErrorKind } from "../errors.js";
import { HttpClient, assertOk, redactUrl } from "../http.js";
import { createThinkTagSplitter } from "../reasoning-tags.js";
import { parseJsonLines, safeJsonParse } from "../sse.js";
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

export interface GoogleOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly http: HttpClient;
  readonly providerId: string;
  readonly ownKey?: string | undefined;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

const THINKING_BUDGET: Record<Exclude<ReasoningEffort, "none">, number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
  max: 32768,
};

export function buildGenerateUrl(
  baseUrl: string,
  model: string,
  stream: boolean,
): string {
  const base = trimSlash(baseUrl);
  const method = stream ? "streamGenerateContent" : "generateContent";
  const suffix = stream ? "?alt=sse" : "";
  return `${base}/models/${encodeURIComponent(model)}:${method}${suffix}`;
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Gemini expects the model id without the `models/` prefix in some deployments. */
export function normalizeGoogleModel(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

export function mapMessagesToGoogle(
  messages: readonly ModelMessage[],
  system?: string,
): unknown[] {
  const contents: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: message.toolName ?? "",
              response: { result: textOf(message.content) || "(no output)" },
            },
          },
        ],
      });
      continue;
    }
    const role = message.role === "assistant" ? "model" : "user";
    const parts: unknown[] = [];
    for (const part of message.content) {
      if (part.type === "text") parts.push({ text: part.text });
      else if (part.type === "image") {
        parts.push({
          inlineData: {
            mimeType: part.mimeType,
            data: stripDataUrl(part.data),
          },
        });
      } else if (part.type === "file") {
        parts.push({
          inlineData: {
            mimeType: part.mimeType,
            data: stripDataUrl(part.data),
          },
        });
      }
    }
    for (const call of message.toolCalls ?? []) {
      parts.push({ functionCall: { name: call.name, args: call.args } });
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

function stripDataUrl(data: string): string {
  const comma = data.indexOf(",");
  return data.startsWith("data:") && comma > -1 ? data.slice(comma + 1) : data;
}

export function mapToolsToGoogle(tools: readonly ToolSpec[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: stripUnsupportedSchema(tool.parameters),
      })),
    },
  ];
}

/**
 * Gemini rejects JSON Schema keywords it does not implement. Strip them rather
 * than let the whole request 400.
 */
function stripUnsupportedSchema(schema: unknown): unknown {
  const unsupported = new Set([
    "$schema",
    "$id",
    "additionalProperties",
    "examples",
    "default",
    "const",
    "oneOf",
    "allOf",
    "not",
    "patternProperties",
    "unevaluatedProperties",
    "definitions",
    "$defs",
  ]);
  if (Array.isArray(schema)) return schema.map(stripUnsupportedSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (unsupported.has(key)) continue;
      out[key] = stripUnsupportedSchema(value);
    }
    return out;
  }
  return schema;
}

export function buildGenerateBody(
  request: ModelRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: mapMessagesToGoogle(request.messages, request.system),
  };
  const config: Record<string, unknown> = {};
  if (request.system)
    config.systemInstruction = { parts: [{ text: request.system }] };
  if (request.tools?.length) {
    config.tools = mapToolsToGoogle(request.tools);
    config.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }
  if (request.temperature !== undefined)
    config.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined)
    config.maxOutputTokens = request.maxOutputTokens;
  if (request.reasoningEffort && request.reasoningEffort !== "none") {
    config.thinkingConfig = {
      thinkingBudget: Math.min(
        THINKING_BUDGET[request.reasoningEffort],
        request.maxOutputTokens ?? 32_768,
      ),
      includeThoughts: true,
    };
  }
  if (Object.keys(config).length) body.generationConfig = config;
  return body;
}

export function buildGoogleHeaders(
  options: GoogleOptions,
): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    // No key means no auth header at all -- never an empty credential.
    ...((options.ownKey ?? options.apiKey)
      ? { "x-goog-api-key": options.ownKey ?? options.apiKey }
      : {}),
    ...(options.extraHeaders ?? {}),
  };
}

export async function* streamGoogleGenerate(
  options: GoogleOptions,
  request: ModelRequest,
): AsyncGenerator<StreamEvent> {
  const url = buildGenerateUrl(
    options.baseUrl,
    normalizeGoogleModel(request.model),
    true,
  );
  const response = await options.http.request(
    {
      method: "POST",
      url,
      headers: buildGoogleHeaders(options),
      body: JSON.stringify(buildGenerateBody(request)),
      signal: request.signal,
      retries: 0,
      diagnostics: {
        dialect: "google-generative",
        authHeader: "x-goog-api-key",
      },
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

  const thinks = createThinkTagSplitter();
  let text = "";
  let reasoning = "";
  let usage: Usage = EMPTY_USAGE;
  let finishReason: FinishReason = "stop";
  const toolCalls: ToolCall[] = [];
  const seenToolCallIndexes = new Set<number>();
  let toolIndex = 0;

  for await (const chunk of parseJsonLines(response.body, request.signal)) {
    if (chunk === undefined) continue;
    const candidate = Array.isArray(chunk) ? chunk[0] : chunk;
    const payload = asRecord(candidate);
    if (!payload) continue;
    if (payload.error) {
      const error = asRecord(payload.error);
      throw new ProviderError(
        ProviderErrorKind.server,
        "google_error",
        stringOr(error?.message, "Provider stream reported an error"),
      );
    }
    usage = mergeUsage(usage, mapGoogleUsage(payload.usageMetadata));

    const candidates = payload.candidates;
    const first = Array.isArray(candidates)
      ? asRecord(candidates[0])
      : undefined;
    if (!first) continue;
    if (stringOr(first.finishReason))
      finishReason = mapGoogleFinishReason(stringOr(first.finishReason));
    const content = asRecord(first.content);
    for (const part of asArray(content?.parts)) {
      const record = asRecord(part);
      if (!record) continue;
      if (record.thought === true && typeof record.text === "string") {
        reasoning += record.text;
        yield { type: "reasoning-delta", text: record.text };
        continue;
      }
      if (typeof record.text === "string" && record.text && record.thought !== true) {
        // Gemini has a `thought` flag, but proxied OpenAI-compatible routes do
        // not, and those inline `<think>` in the text part.
        const split = thinks.push(record.text);
        if (split.text) {
          text += split.text;
          yield { type: "text-delta", text: split.text };
        }
        if (split.reasoning) {
          reasoning += split.reasoning;
          yield { type: "reasoning-delta", text: split.reasoning };
        }
        continue;
      }
      if (typeof record.text === "string" && record.text) {
        text += record.text;
        yield { type: "text-delta", text: record.text };
      }
      const functionCall = asRecord(record.functionCall);
      if (functionCall) {
        const callIndex = num(functionCall.id, -1);
        const index =
          callIndex >= 0 && !seenToolCallIndexes.has(callIndex)
            ? callIndex
            : toolIndex++;
        seenToolCallIndexes.add(index);
        const args = asRecord(functionCall.args) ?? {};
        const call: ToolCall = {
          id: `call_${index}_${stringOr(functionCall.name, "tool")}`,
          name: stringOr(functionCall.name),
          args,
          rawArgs: JSON.stringify(args),
          index,
        };
        toolCalls.push(call);
        yield { type: "tool-call-start", index, id: call.id, name: call.name };
        yield { type: "tool-call-end", index, call };
      }
    }
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

export async function completeGoogleGenerate(
  options: GoogleOptions,
  request: ModelRequest,
): Promise<ModelResponse> {
  const url = buildGenerateUrl(
    options.baseUrl,
    normalizeGoogleModel(request.model),
    false,
  );
  const response = await options.http.request(
    {
      method: "POST",
      url,
      headers: buildGoogleHeaders(options),
      body: JSON.stringify(buildGenerateBody(request)),
      signal: request.signal,
      retries: 0,
      diagnostics: {
        dialect: "google-generative",
        authHeader: "x-goog-api-key",
      },
    },
    options.providerId,
  );
  await assertOk(response, redactUrl(url));
  const payload = (await response.json()) as {
    candidates?: { finishReason?: string; content?: { parts?: unknown[] } }[];
    usageMetadata?: unknown;
  };
  const first = payload.candidates?.[0];
  let text = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  (first?.content?.parts ?? []).forEach((part, index) => {
    const record = asRecord(part);
    if (!record) return;
    if (record.thought === true && typeof record.text === "string")
      reasoning += record.text;
    else if (typeof record.text === "string") text += record.text;
    const functionCall = asRecord(record.functionCall);
    if (functionCall) {
      const args = asRecord(functionCall.args) ?? {};
      toolCalls.push({
        id: `call_${index}_${stringOr(functionCall.name, "tool")}`,
        name: stringOr(functionCall.name),
        args,
        rawArgs: JSON.stringify(args),
        index,
      });
    }
  });

  return {
    message: {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(reasoning ? { reasoning: { text: reasoning, signature: "" } } : {}),
    },
    usage: mapGoogleUsage(payload.usageMetadata),
    finishReason: toolCalls.length
      ? "tool-calls"
      : mapGoogleFinishReason(first?.finishReason ?? ""),
  };
}

export function mapGoogleUsage(usageMetadata: unknown): Usage {
  const record = asRecord(usageMetadata);
  if (!record) return EMPTY_USAGE;
  const input = num(record.promptTokenCount, 0);
  const output = num(record.candidatesTokenCount, 0);
  const cached = num(record.cachedContentTokenCount, 0);
  const thoughts = num(record.thoughtsTokenCount, 0);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: num(record.totalTokenCount, input + output + thoughts),
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(thoughts ? { reasoningTokens: thoughts } : {}),
  };
}

function mergeUsage(a: Usage, b: Usage): Usage {
  if (b.inputTokens === 0 && b.outputTokens === 0) return a;
  return {
    inputTokens: b.inputTokens || a.inputTokens,
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    totalTokens: b.totalTokens || Math.max(a.totalTokens, b.totalTokens),
    cacheReadTokens: b.cacheReadTokens ?? a.cacheReadTokens,
    reasoningTokens:
      Math.max(a.reasoningTokens ?? 0, b.reasoningTokens ?? 0) || undefined,
  };
}

export function mapGoogleFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
      return "content-filter";
    case "STOP":
      return "stop";
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
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
