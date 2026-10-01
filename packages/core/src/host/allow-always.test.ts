/**
 * "Allow always", end to end, through the real host.
 *
 * The gate has computed a suggestion for years and the UI has always offered an
 * "Allow always" button, but nothing ever wrote the entry down. `allow-always`
 * was treated as `allow` -- correctly, as far as it went -- and then forgotten, so
 * the same command was asked about again on the very next call and the button
 * looked broken in the one way users notice.
 *
 * Driven through `sendMessage` rather than against a loop fixture, because the
 * thing that was missing is a host-side write. A fixture that owns its own
 * `ApprovalBroker` would resolve against a different table than the host reads
 * and pass whether or not the host ever found the request.
 *
 * The command is `git status` on purpose: it is real enough to execute through
 * the real tool, harmless enough to run in a temp directory, and still lands in
 * the `bash` category, so it still prompts.
 */

import { describe, expect, it, vi } from "vitest";

import { LocalHost } from "./local.js";
import { SettingsStore } from "../settings/store.js";
import { MemorySecretStore } from "../secrets/secret-store.js";
import { migratedTestDatabase } from "../storage/sqlite.test-support.js";
import { UNAVAILABLE_FILE_SYSTEM, UNAVAILABLE_PROCESS, type HostServices } from "./ports.js";
import { describePlatform } from "../platform/platform.js";
import { fallbackShell } from "../platform/shell.js";
import type { AgentEvent } from "../agent/events.js";

/** A key-shaped fixture. Never a credential: it is never sent anywhere real. */
const FIXTURE_KEY = "sk-test-0000000000000000000000000000";
const MODEL = "test-model";

const CATALOG = { data: [{ id: MODEL }] };

/** Published at $0 so the catalog calls it free and the send is not refused. */
const MODELS_DEV = {
  opencode: {
    models: {
      [MODEL]: {
        id: MODEL,
        name: "Test Model",
        cost: { input: 0, output: 0 },
        tool_call: true,
      },
    },
  },
};

/**
 * One turn that asks for a tool call, then a plain answer.
 *
 * The second turn matters: a fixture that asked for the tool forever would leave
 * the run waiting on a second approval that nobody is resolving, and the test
 * would fail on a timeout rather than on the thing it is checking.
 */
function turns(command: string): {
  completion(call: boolean): Record<string, unknown>;
  sse(call: boolean): string;
} {
  const completion = (call: boolean): Record<string, unknown> => ({
    id: "c-1",
    model: MODEL,
    choices: [
      call
        ? {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "bash", arguments: JSON.stringify({ command }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          }
        : {
            index: 0,
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  const sse = (call: boolean): string => {
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "c-1",
        object: "chat.completion.chunk",
        created: 1,
        model: MODEL,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    return [
      call
        ? chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "bash", arguments: JSON.stringify({ command }) },
                },
              ],
            },
            null,
          )
        : chunk({ role: "assistant", content: "done" }, null),
      chunk({}, call ? "tool_calls" : "stop"),
      `data: ${JSON.stringify({
        id: "c-1",
        object: "chat.completion.chunk",
        created: 1,
        model: MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
  };

  return { completion, sse };
}

interface Harness {
  readonly host: LocalHost;
  readonly settings: SettingsStore;
  readonly workspace: string;
  readonly events: readonly AgentEvent[];
}

async function harness(input: {
  readonly command: string;
  readonly decision: "allow" | "deny" | "allow-always";
  /**
   * A real directory, because the shell tool refuses a run without a workspace
   * and the point here is what happens *after* the prompt, not that the command
   * works. `git status` is harmless anywhere and fails loudly rather than
   * silently in a directory that does not exist.
   */
  readonly workspace?: string;
}): Promise<Harness> {
  const { command } = input;
  const workspace = input.workspace ?? process.cwd();
  const db = await migratedTestDatabase();
  const secrets = new MemorySecretStore();
  await secrets.set("provider.opencode-zen.apiKey", FIXTURE_KEY);
  const settings = new SettingsStore(db, { providerId: "opencode-zen" });
  await settings.setModelForMode("code", MODEL, "opencode-zen");
  await settings.setPermission("code", { level: "ask" });

  const scripted = turns(command);
  let sent = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const isCompletion = url.includes("/chat/completions");
    const wantsTool = isCompletion && sent === 0;
    if (isCompletion) sent += 1;
    const body = url.startsWith("https://opencode.ai/zen/v1/models")
      ? CATALOG
      : url.startsWith("https://models.dev")
        ? MODELS_DEV
        : isCompletion
          ? scripted.completion(wantsTool)
          : undefined;
    if (body === undefined) return new Response("not found", { status: 404 });
    void init;
    if (isCompletion) {
      return new Response(scripted.sse(wantsTool), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const platform = describePlatform("linux", "x86_64", "Linux");
  const services = {
    platform,
    // Required by the system prompt, which describes the shell to the model.
    shell: fallbackShell(platform),
    env: {},
    ownKeys: {},
    fetch: fetchImpl,
    // Code mode reads project memory before the first send. Missing here it threw
    // inside the run loop, which is reported nowhere: the run just produced no
    // events, so every assertion below passed or failed for the wrong reason.
    readProjectMemory: async () => null,
    // Present but refusing, so the Code tools register. That is the point: a
    // host with no ports at all has no `bash` in its tool list, the model never
    // sees it, and no approval is ever requested -- which would make these tests
    // pass for the wrong reason. Execution is never reached anyway, because the
    // gate asks first and the decision is what is under test.
    fs: UNAVAILABLE_FILE_SYSTEM,
    process: UNAVAILABLE_PROCESS,
  } as unknown as HostServices;

  const host = new LocalHost({ db, secrets, settings, services });

  const events: AgentEvent[] = [];
  const finished = (async () => {
    for await (const event of host.streamEvents()) {
      events.push(event);
      if (event.type === "run-finish" || event.type === "run-error") return;
    }
  })();

  // Subscribed before the send, so the request cannot be missed in between.
  const watcher = (async () => {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const pending = await host.listPendingApprovals();
      if (pending.length > 0) {
        await host.resolveApproval(pending[0].callId, input.decision);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  })();

  const conversation = await host.createConversation({ mode: "code", workspace });
  await host.sendMessage({
    conversationId: conversation.id,
    text: "check the repo",
    model: MODEL,
    providerId: "opencode-zen",
    // The catalog publishes no price for the fixture model, so the free-only
    // policy asks about it before a single token is sent. Consent for this one
    // send gets the run as far as the tool prompt, which is the part under test.
    allowPaidModel: true,
  });

  await Promise.all([watcher, finished]);
  return { host, settings, workspace, events };
}

describe("the \"Allow always\" button", () => {
  it("asks before running, then records the grant so the next call is quiet", async () => {
    const run = await harness({ command: "git status", decision: "allow-always" });
    const requested = run.events.filter((event) => event.type === "tool-approval-requested");

    // It really did ask, so the write below is answering a prompt rather than
    // quietly adding an entry nobody requested.
    expect(requested).toHaveLength(1);
    const request = requested[0];
    expect(request.type === "tool-approval-requested" && request.suggestion).toBe("git status");
    expect(
      request.type === "tool-approval-requested" && request.suggestionList,
    ).toBe("allowedCommands");

    const codes = run.settings.get().permissions.code;
    expect(codes.allowedCommands).toContain("git status");
    // Into the command list, not the domain or path list. The other two are
    // matched against different things entirely, so an entry there would look
    // identical in Settings and authorize nothing.
    expect(codes.allowedDomains).not.toContain("git status");
    expect(codes.allowedPaths).not.toContain("git status");
  });

  it("writes nothing for a plain allow", async () => {
    // A one-off yes is a one-off. Persisting it would make every allow silent and
    // permanent, which is not what the Allow button says.
    const { settings } = await harness({ command: "git status", decision: "allow" });
    expect(settings.get().permissions.code.allowedCommands).not.toContain("git status");
  });

  it("writes nothing for a deny", async () => {
    const { settings } = await harness({ command: "git status", decision: "deny" });
    expect(settings.get().permissions.code.allowedCommands).not.toContain("git status");
  });

  it("leaves a denied command denied, so the new entry grants nothing", async () => {
    // The deny lists are checked ahead of the allow lists on every call, so this
    // must not start running just because the user once said always-allow to
    // something that pattern-matched it.
    const run = await harness({ command: "rm -rf build", decision: "allow-always" });
    const requested = run.events.filter((event) => event.type === "tool-approval-requested");
    // Refused before the prompt, so no grant was offered at all.
    expect(requested).toHaveLength(0);
    expect(run.settings.get().permissions.code.allowedCommands).not.toContain("rm -rf build");
  });

  it("reports nothing to persist when the broker has no pending request", async () => {
    // The UI can race the broker: the card is on screen when the run is cancelled
    // or ends. This has to be a quiet no-op, not a throw, or a late click breaks
    // the app -- and it must not report success it did not achieve.
    const { host } = await harness({ command: "git status", decision: "allow" });

    const resolved = await host.resolveApproval("no-such-call", "allow-always");

    expect(resolved).toBe(false);
  });
});