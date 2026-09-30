import { describe, expect, it } from "vitest";
import { ZenProvider } from "./zen/provider.js";
import { isNonChatModel, resolveWireFormat } from "./zen/catalog.js";
import { ProviderError, isAbort, toProviderError } from "./errors.js";
import { parseSse } from "./sse.js";
import {
  redactUrl,
  extractProviderMessage,
  parseRetryAfter,
  computeBackoff,
} from "./http.js";
import {
  mapChatFinishReason,
  mapChatUsage,
  buildChatBody,
  finalizeToolCall,
} from "./wire/openai-chat.js";
import {
  mapResponsesFinishReason,
  mapResponsesUsage,
  buildResponsesBody,
} from "./wire/openai-responses.js";
import {
  mapAnthropicStopReason,
  mapAnthropicUsage,
  buildMessagesBody,
} from "./wire/anthropic-messages.js";
import {
  mapGoogleFinishReason,
  mapGoogleUsage,
  buildGenerateBody,
} from "./wire/google-generative.js";

describe("zen wire-format routing", () => {
  it("routes each family to the endpoint the docs specify", () => {
    expect(resolveWireFormat("gpt-5.5")).toBe("openai-responses");
    expect(resolveWireFormat("gpt-6-astra")).toBe("openai-responses");
    expect(resolveWireFormat("grok-4.7")).toBe("openai-responses");
    expect(resolveWireFormat("muse-spark-1.3")).toBe("openai-responses");

    expect(resolveWireFormat("claude-sonnet-5")).toBe("anthropic-messages");
    expect(resolveWireFormat("claude-opus-5-5")).toBe("anthropic-messages");
    expect(resolveWireFormat("qwen3.5-plus")).toBe("anthropic-messages");

    expect(resolveWireFormat("gemini-3.1-pro")).toBe("google-generative");

    expect(resolveWireFormat("deepseek-v4-pro")).toBe("openai-chat");
    expect(resolveWireFormat("glm-5.3")).toBe("openai-chat");
    expect(resolveWireFormat("kimi-k3")).toBe("openai-chat");
    expect(resolveWireFormat("minimax-m3")).toBe("openai-chat");
    expect(resolveWireFormat("big-pickle")).toBe("openai-chat");
  });

  it("falls back to a heuristic for models newer than this build", () => {
    expect(resolveWireFormat("claude-opus-9-9")).toBe("anthropic-messages");
    expect(resolveWireFormat("gemini-9-pro")).toBe("google-generative");
    expect(resolveWireFormat("gpt-9-turbo")).toBe("openai-responses");
    expect(resolveWireFormat("some-new-model")).toBe("openai-chat");
  });

  it("prefers models.dev metadata over the heuristic", () => {
    expect(resolveWireFormat("mystery-model", "@ai-sdk/anthropic")).toBe(
      "anthropic-messages",
    );
    expect(resolveWireFormat("mystery-model", "@ai-sdk/openai")).toBe(
      "openai-responses",
    );
    expect(resolveWireFormat("mystery-model", "@ai-sdk/google")).toBe(
      "google-generative",
    );
    expect(
      resolveWireFormat("mystery-model", "@ai-sdk/openai-compatible"),
    ).toBe("openai-chat");
  });

  it("marks structured-decision models as not chat models", () => {
    expect(isNonChatModel("jev-1.13")).toBe(true);
    expect(isNonChatModel("claude-sonnet-5")).toBe(false);
  });
});

describe("ZenProvider without a key", () => {
  it("sends no auth header when no key is saved, rather than refusing locally", async () => {
    // This used to assert that a missing key blocks the request outright. It
    // does not, and the reason is measured rather than assumed: Zen serves
    // `space-bunny-free` to unauthenticated clients, so a blanket block would
    // refuse a model that works. What must hold is the narrower promise -- no
    // credential is invented, and none is put on the wire.
    const sent: { authorization?: string | undefined } = {};
    const provider = new ZenProvider(
      { apiKey: null },
      {
        fetch: async (_url, init) => {
          sent.authorization = new Headers(init?.headers).get("authorization");
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "hi" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(provider.hasApiKey).toBe(false);
    const response = await provider.complete({
      providerId: provider.id,
      model: "space-bunny-free",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(response.message.content.map((part) => part.type === "text" ? part.text : "")).toContain("hi");
    // An empty `Bearer ` would be worse than nothing: it is a credential that
    // looks present, and it is refused the same way a wrong one is.
    expect(sent.authorization).toBeNull();
  });

  it("calls a 401 a missing credential when nothing was sent, and a bad one when something was", async () => {
    const unauthorized = async () =>
      new Response(JSON.stringify({ error: { message: "Missing API key." } }), {
        status: 401,
      });

    // Nothing was sent, so nothing can have been refused. Reporting `auth` here
    // tells the user to re-paste a key they never entered.
    await expect(
      new ZenProvider({ apiKey: null }, { fetch: unauthorized }).complete({
        providerId: "opencode-zen",
        model: "gpt-5.5",
        messages: [],
      }),
    ).rejects.toMatchObject({ kind: "missing-credential" });

    // A key that was sent and refused really is an auth problem.
    await expect(
      new ZenProvider(
        { apiKey: "sk-some-key" },
        {
          fetch: async () =>
            new Response(
              JSON.stringify({ error: { message: "Invalid API key" } }),
              { status: 401 },
            ),
        },
      ).complete({
        providerId: "opencode-zen",
        model: "gpt-5.5",
        messages: [],
      }),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("accepts an OpenCode Zen key from the environment", () => {
    const provider = new ZenProvider(
      { apiKey: null },
      { env: { OPENCODE_API_KEY: "sk-test" } },
    );
    expect(provider.hasApiKey).toBe(true);
  });
});

describe("http helpers", () => {
  it("redacts secrets in URLs", () => {
    expect(redactUrl("https://x.test/v1?key=supersecret&model=a")).toContain(
      "key=REDACTED",
    );
    expect(redactUrl("https://x.test/v1?model=a")).toBe(
      "https://x.test/v1?model=a",
    );
  });

  it("extracts a message from each provider's error envelope", () => {
    expect(extractProviderMessage('{"error":{"message":"bad key"}}')).toBe(
      "bad key",
    );
    expect(extractProviderMessage('{"message":"flat"}')).toBe("flat");
    expect(extractProviderMessage("plain text")).toBe("plain text");
    expect(extractProviderMessage("")).toBeUndefined();
  });

  it("parses Retry-After in both forms", () => {
    expect(parseRetryAfter("12")).toBe(12_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("garbage")).toBeUndefined();
  });

  it("backs off exponentially and honours Retry-After", () => {
    expect(computeBackoff(0)).toBeGreaterThan(0);
    expect(computeBackoff(0, 5_000)).toBe(5_000);
    expect(computeBackoff(10)).toBeLessThanOrEqual(30_000);
  });
});

describe("SSE parsing", () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[i++]!));
      },
    });
  }

  it("reassembles events split across chunk boundaries", async () => {
    const wire = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    const cut = wire.indexOf("[DONE]") - 3;
    const events: string[] = [];
    for await (const event of parseSse(
      streamOf([wire.slice(0, cut), wire.slice(cut)]),
    )) {
      events.push(event.data);
    }
    expect(events).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("handles CRLF and comment lines", async () => {
    const events: string[] = [];
    for await (const event of parseSse(
      streamOf([": ping\r\n\r\ndata: one\r\n\r\n"]),
    )) {
      events.push(event.data);
    }
    expect(events).toEqual(["one"]);
  });

  it("joins multi-line data payloads", async () => {
    const events: string[] = [];
    for await (const event of parseSse(streamOf(["data: a\ndata: b\n\n"]))) {
      events.push(event.data);
    }
    expect(events).toEqual(["a\nb"]);
  });

  it("yields a trailing event with no blank line", async () => {
    const events: string[] = [];
    for await (const event of parseSse(streamOf(["data: last\n"]))) {
      events.push(event.data);
    }
    expect(events).toEqual(["last"]);
  });
});

describe("request builders", () => {
  const messages = [
    { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
  ];

  it("puts the system prompt in the top-level field for Anthropic and Gemini", () => {
    const anthropic = buildMessagesBody(
      { providerId: "p", model: "m", messages, system: "be brief" },
      false,
    );
    expect(anthropic.system).toBe("be brief");
    expect(Array.isArray(anthropic.messages)).toBe(true);
    expect(JSON.stringify(anthropic.messages)).not.toContain("be brief");

    const google = buildGenerateBody({
      providerId: "p",
      model: "m",
      messages,
      system: "be brief",
    });
    expect(JSON.stringify(google)).toContain("be brief");
    expect(
      (google.generationConfig as Record<string, unknown>).systemInstruction,
    ).toBeDefined();
  });

  it("maps system content into the message list for OpenAI", () => {
    const body = buildChatBody(
      { providerId: "p", model: "m", messages, system: "be brief" },
      true,
    );
    expect((body.messages as unknown[])[0]).toEqual({
      role: "system",
      content: "be brief",
    });
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("maps tool results to the right shape per protocol", () => {
    const withTool: Parameters<typeof buildMessagesBody>[0] = {
      providerId: "p",
      model: "m",
      messages: [
        ...messages,
        {
          role: "tool",
          content: [{ type: "text", text: "done" }],
          toolCallId: "call_1",
          toolName: "read_file",
        },
      ],
    };
    const anthropic = buildMessagesBody(withTool, false);
    const last = (anthropic.messages as Record<string, unknown>[]).at(-1)!;
    expect(last.role).toBe("user");
    expect((last.content as { type: string }[])[0]!.type).toBe("tool_result");

    const google = buildGenerateBody(withTool);
    expect(JSON.stringify(google)).toContain("functionResponse");
  });

  it("strips JSON Schema keywords Gemini rejects", () => {
    const body = buildGenerateBody({
      providerId: "p",
      model: "m",
      messages,
      tools: [
        {
          name: "t",
          description: "d",
          parameters: {
            type: "object",
            additionalProperties: false,
            $schema: "x",
            properties: { a: { type: "string" } },
          },
        },
      ],
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain("additionalProperties");
    expect(json).not.toContain("$schema");
    expect(json).toContain('"type":"string"');
  });

  it("drops temperature when Anthropic thinking is enabled", () => {
    const body = buildMessagesBody(
      {
        providerId: "p",
        model: "m",
        messages,
        temperature: 0.7,
        reasoningEffort: "high",
        maxOutputTokens: 8192,
      },
      false,
    );
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 6144 });
  });
});

describe("usage and finish-reason mapping", () => {
  it("maps OpenAI usage", () => {
    const usage = mapChatUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 5 },
    });
    expect(usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 20,
      reasoningTokens: 5,
    });
  });

  it("maps OpenAI Responses usage", () => {
    const usage = mapResponsesUsage({
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 4 },
    });
    expect(usage.inputTokens).toBe(10);
    expect(usage.cacheReadTokens).toBe(4);
  });

  it("maps Anthropic usage including cache fields", () => {
    const usage = mapAnthropicUsage({
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    });
    expect(usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
  });

  it("maps Gemini usage including thought tokens", () => {
    const usage = mapGoogleUsage({
      promptTokenCount: 5,
      candidatesTokenCount: 6,
      thoughtsTokenCount: 4,
      totalTokenCount: 15,
    });
    expect(usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 6,
      reasoningTokens: 4,
      totalTokens: 15,
    });
  });

  it("returns zero usage rather than undefined for missing metadata", () => {
    expect(mapChatUsage(undefined).totalTokens).toBe(0);
    expect(mapAnthropicUsage(undefined).totalTokens).toBe(0);
    expect(mapGoogleUsage(null).totalTokens).toBe(0);
    expect(mapResponsesUsage(null).totalTokens).toBe(0);
  });

  it("maps finish reasons across protocols", () => {
    expect(mapChatFinishReason("tool_calls")).toBe("tool-calls");
    expect(mapChatFinishReason("length")).toBe("length");
    expect(mapChatFinishReason("content_filter")).toBe("content-filter");
    expect(mapChatFinishReason(null)).toBe("stop");

    expect(mapAnthropicStopReason("tool_use")).toBe("tool-calls");
    expect(mapAnthropicStopReason("max_tokens")).toBe("length");

    expect(mapResponsesFinishReason("completed")).toBe("stop");
    expect(mapResponsesFinishReason("incomplete")).toBe("length");
    expect(mapResponsesFinishReason("failed")).toBe("error");

    expect(mapGoogleFinishReason("MAX_TOKENS")).toBe("length");
    expect(mapGoogleFinishReason("SAFETY")).toBe("content-filter");
    expect(mapGoogleFinishReason("STOP")).toBe("stop");
  });
});

describe("tool-call argument parsing", () => {
  it("parses streamed JSON fragments and survives malformed input", () => {
    expect(
      finalizeToolCall(0, "call_1", "read", '{"path":"a.txt"}').args,
    ).toEqual({ path: "a.txt" });
    expect(finalizeToolCall(0, "call_1", "read", "{oops").args).toEqual({});
    expect(finalizeToolCall(0, "", "read", "{}").id).toBe("call_0");
    expect(finalizeToolCall(2, "c", "x", "[1,2]").args).toEqual({});
  });
});

describe("errors", () => {
  it("classifies retryable failures", () => {
    expect(
      new ProviderError("rate-limit", "http_429", "slow down").retryable,
    ).toBe(true);
    expect(new ProviderError("auth", "http_401", "bad key").retryable).toBe(
      false,
    );
  });

  it("produces an actionable user message", () => {
    expect(new ProviderError("auth", "http_401", "nope").userMessage).toContain(
      "Settings",
    );
    expect(
      new ProviderError("rate-limit", "http_429", "wait", {
        retryAfterMs: 20_000,
      }).userMessage,
    ).toContain("20s");
  });

  it("recognises aborts", () => {
    const abort = new Error("Aborted");
    abort.name = "AbortError";
    expect(isAbort(abort)).toBe(true);
    expect(toProviderError(abort).kind).toBe("cancelled");
  });
});

describe("responses body", () => {
  it("marks reasoning effort and disables server-side storage", () => {
    const body = buildResponsesBody(
      { providerId: "p", model: "m", messages: [], reasoningEffort: "high" },
      false,
    );
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "high" });
  });
});
