import { describe, expect, it } from "vitest";
import { AgentEventBus } from "./events.js";
import { ApprovalBroker } from "./approval.js";
import {
  compactMessages,
  estimateMessagesTokens,
  estimateTokens,
  planCompaction,
  totalUsage,
} from "./compaction.js";
import { buildSystemPrompt, deriveTitle } from "./system-prompt.js";
import { redact, redactText } from "../audit/audit-log.js";
import { describePlatform } from "../platform/platform.js";
import { fallbackShell } from "../platform/shell.js";
import { SettingsSchema, isBypassActive, modelFor, DEFAULT_SETTINGS } from "../settings/schema.js";
import { maskSecret, MemorySecretStore, SecretKeys } from "../secrets/secret-store.js";
import { EMPTY_USAGE, type ModelMessage } from "../models/types.js";

describe("AgentEventBus", () => {
  it("delivers events to subscribers and survives a throwing listener", () => {
    const bus = new AgentEventBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    bus.subscribe((event) => seen.push(event.type));
    bus.emit({ type: "step-start", runId: "r", step: 1 });
    expect(seen).toEqual(["step-start"]);
  });

  it("unsubscribes cleanly", () => {
    const bus = new AgentEventBus();
    const seen: string[] = [];
    const off = bus.subscribe((event) => seen.push(event.type));
    off();
    bus.emit({ type: "step-start", runId: "r", step: 1 });
    expect(seen).toEqual([]);
  });

  it("bounds the replay buffer", () => {
    const bus = new AgentEventBus(3);
    for (let i = 0; i < 10; i++) bus.emit({ type: "step-start", runId: "r", step: i });
    expect(bus.history()).toHaveLength(3);
  });
});

describe("ApprovalBroker", () => {
  it("resolves a pending request from outside the run", async () => {
    const broker = new ApprovalBroker();
    const pending = broker.subscribe((list) => list);
    const promise = broker.request({ runId: "r", callId: "c1", tool: "bash", args: { command: "ls" }, summary: "Run ls" });
    expect(broker.list()).toHaveLength(1);
    expect(broker.resolve("c1", "allow")).toBe(true);
    expect(await promise).toBe("allow");
    expect(broker.list()).toHaveLength(0);
    pending();
  });

  it("returns false for an unknown call id", () => {
    expect(new ApprovalBroker().resolve("nope", "allow")).toBe(false);
  });

  it("denies everything when a run is cancelled", async () => {
    const broker = new ApprovalBroker();
    const a = broker.request({ runId: "r", callId: "a", tool: "t", args: {}, summary: "a" });
    const b = broker.request({ runId: "r", callId: "b", tool: "t", args: {}, summary: "b" });
    broker.denyAll();
    expect(await a).toBe("deny");
    expect(await b).toBe("deny");
  });
});

describe("compaction", () => {
  const messages: ModelMessage[] = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: [{ type: "text" as const, text: `message ${i} `.repeat(200) }],
  }));

  it("estimates tokens without a tokenizer", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(350))).toBe(100);
  });

  it("does not compact when under the threshold", () => {
    const plan = planCompaction(messages, { contextWindow: 1_000_000 });
    expect(plan.needsCompaction).toBe(false);
  });

  it("compacts and keeps the most recent turns verbatim", async () => {
    const plan = planCompaction(messages, { contextWindow: 8_000, keepRecent: 6 });
    expect(plan.needsCompaction).toBe(true);
    const result = await compactMessages(messages, plan, async () => "short summary");
    expect(result.removedMessages).toBeGreaterThan(0);
    expect(result.freedTokens).toBeGreaterThan(0);
    expect(result.messages).toHaveLength(1 + (messages.length - plan.keepFrom));
    expect(result.messages[0]!.content[0]!.text).toContain("short summary");
  });

  it("never splits a tool result from its call", () => {
    const withTool: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "go " }] },
      { role: "assistant", content: [], toolCalls: [{ id: "c", name: "t", args: {}, rawArgs: "{}", index: 0 }] },
      { role: "tool", content: [{ type: "text", text: "result " }], toolCallId: "c", toolName: "t" },
      { role: "assistant", content: [{ type: "text", text: "done " }] },
    ];
    const plan = planCompaction(withTool, { contextWindow: 1, keepRecent: 1 });
    expect(withTool[plan.keepFrom]?.role).not.toBe("tool");
  });

  it("sums usage across a run", () => {
    const total = totalUsage([
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    ]);
    expect(total).toMatchObject({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  });
});

describe("system prompt", () => {
  const windows = describePlatform("windows", "x86_64", "Windows 11");
  const linux = describePlatform("linux", "x86_64", "Arch Linux");

  it("states the OS and shell so the model writes the right commands", () => {
    const prompt = buildSystemPrompt({
      mode: "code",
      platform: windows,
      shell: fallbackShell(windows),
      workspace: "C:\\ws",
      customSystemPrompt: null,
      customInstructions: "",
      projectMemory: null,
      today: new Date("2026-01-15T10:00:00Z"),
    });
    expect(prompt).toContain("Windows 11");
    expect(prompt).toContain("PowerShell");
    expect(prompt).toContain("backslashes");
    expect(prompt).toContain("C:\\ws");
    expect(prompt).toContain("2026-01-15");
  });

  it("mentions POSIX conventions on Linux", () => {
    const prompt = buildSystemPrompt({
      mode: "code",
      platform: linux,
      shell: fallbackShell(linux),
      workspace: "/ws",
      customSystemPrompt: null,
      customInstructions: "",
      projectMemory: null,
      today: new Date(),
    });
    expect(prompt).toContain("case-sensitive");
    expect(prompt).toContain("forward slashes");
    expect(prompt).toContain("pacman");
  });

  it("injects AGENTS.md when present", () => {
    const prompt = buildSystemPrompt({
      mode: "code",
      platform: linux,
      shell: fallbackShell(linux),
      workspace: "/ws",
      customSystemPrompt: null,
      customInstructions: "",
      projectMemory: "Always run pnpm test before finishing.",
      today: new Date(),
    });
    expect(prompt).toContain("Always run pnpm test before finishing.");
  });

  it("restricts the agent in plan mode", () => {
    const prompt = buildSystemPrompt({
      mode: "code",
      platform: linux,
      shell: fallbackShell(linux),
      workspace: "/ws",
      customSystemPrompt: null,
      customInstructions: "",
      projectMemory: null,
      today: new Date(),
      planMode: true,
    });
    expect(prompt).toContain("plan mode");
    expect(prompt).toContain("read-only");
  });

  it("derives a short chat title", () => {
    expect(deriveTitle("How do I centre a div?")).toBe("How do I centre a div?");
    expect(deriveTitle("")).toBe("New chat");
    const long = deriveTitle("a ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("audit redaction", () => {
  it("scrubs bearer tokens", () => {
    expect(redactText("Authorization: Bearer sk-abcdef1234567890")).not.toContain("abcdef1234567890");
  });

  it("scrubs api keys in JSON-ish text", () => {
    expect(redactText('{"api_key":"supersecretvalue"}')).not.toContain("supersecretvalue");
  });

  it("scrubs keys in query strings", () => {
    expect(redactText("https://x.test/v1?api_key=leakme&model=a")).not.toContain("leakme");
  });

  it("scrubs nested objects by key name", () => {
    const result = redact({ headers: { authorization: "Bearer x" }, nested: { password: "hunter2" } }) as Record<string, never>;
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("leaves ordinary text alone", () => {
    expect(redactText("ran npm test in /ws")).toBe("ran npm test in /ws");
  });
});

describe("settings", () => {
  it("ships safe defaults", () => {
    expect(DEFAULT_SETTINGS.permissions.chat.level).toBe("ask");
    expect(DEFAULT_SETTINGS.permissions.cowork.level).toBe("ask");
    expect(DEFAULT_SETTINGS.permissions.code.level).toBe("ask");
    expect(isBypassActive(DEFAULT_SETTINGS)).toBe(false);
    expect(DEFAULT_SETTINGS.telemetryEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.permissions.code.bypassWarningAccepted).toBe(false);
    expect(DEFAULT_SETTINGS.permissions.code.deniedCommands).toContain("rm -rf /");
  });

  it("rejects out-of-range values instead of silently clamping", () => {
    expect(SettingsSchema.safeParse({ fontSize: 40 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ generation: { temperature: 5 } }).success).toBe(false);
    expect(SettingsSchema.safeParse({ permissions: { code: { level: "yolo" } } }).success).toBe(false);
  });

  it("fills in defaults for a partial document", () => {
    const settings = SettingsSchema.parse({ theme: "dark" });
    expect(settings.theme).toBe("dark");
    expect(settings.fontSize).toBe(14);
    expect(settings.permissions.code.level).toBe("ask");
  });

  it("does not share mutable default objects between parses", () => {
    const a = SettingsSchema.parse({});
    const b = SettingsSchema.parse({});
    a.permissions.code.deniedCommands.push("rm -rf /custom");
    expect(b.permissions.code.deniedCommands).not.toContain("rm -rf /custom");
  });

  it("detects bypass per mode and globally", () => {
    const settings = SettingsSchema.parse({ permissions: { cowork: { level: "bypass" } } });
    expect(isBypassActive(settings, "cowork")).toBe(true);
    expect(isBypassActive(settings, "code")).toBe(false);
    expect(isBypassActive(settings)).toBe(true);
  });

  it("resolves the model for a mode with a last-used fallback", () => {
    const settings = SettingsSchema.parse({ models: { code: "gpt-5.3-codex", lastUsed: "claude-sonnet-5" } });
    expect(modelFor(settings, "code")).toBe("gpt-5.3-codex");
    expect(modelFor(settings, "chat")).toBe("claude-sonnet-5");
  });
});

describe("secrets", () => {
  it("masks all but a short prefix and suffix", () => {
    expect(maskSecret("sk-1234567890abcdef")).toMatch(/^sk-•+cdef$/);
    expect(maskSecret("short")).toBe("•".repeat(8));
    expect(maskSecret(null)).toBe("");
  });

  it("stores and clears values without listing them", async () => {
    const store = new MemorySecretStore();
    await store.set(SecretKeys.zen, "key");
    expect(await store.get(SecretKeys.zen)).toBe("key");
    await store.delete(SecretKeys.zen);
    expect(await store.get(SecretKeys.zen)).toBeNull();
  });
});

describe("usage helpers", () => {
  it("starts at zero", () => {
    expect(EMPTY_USAGE.totalTokens).toBe(0);
  });

  it("estimates message tokens including tool calls", () => {
    const withTool = estimateMessagesTokens([
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "c", name: "read_file", args: { path: "a" }, rawArgs: '{"path":"a"}', index: 0 }],
      },
    ]);
    expect(withTool).toBeGreaterThan(estimateTokens("read_file"));
  });
});
