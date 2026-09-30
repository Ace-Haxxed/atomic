/**
 * The agent loop.
 *
 *   model call -> tool execution -> permission gate -> result back to model -> repeat
 *
 * Two guarantees hold for every tool call regardless of mode:
 *  - it passes through `PermissionGate.check`
 *  - it is written to the audit log
 *
 * Cancellation is cooperative and always available: the UI holds an
 * `AbortController` per run and the loop honours it between every step.
 */

import { ProviderError, isAbort, toProviderError } from "../providers/errors.js";
import type { PermissionGate, PermissionOutcome } from "../permissions/gate.js";
import { isReadOnlyTool } from "../permissions/gate.js";
import type { Provider } from "../models/provider.js";
import {
  EMPTY_USAGE,
  addUsage,
  type FinishReason,
  type ModelMessage,
  type ReasoningEffort,
  type ToolCall,
  type Usage,
} from "../models/types.js";
import type { ToolRegistry, ToolResult } from "../tools/registry.js";
import { compactMessages, planCompaction, type CompactionOptions } from "./compaction.js";
import type { TurnCostReview } from "../models/free-policy.js";
import type { AgentEventBus, AgentEvent } from "./events.js";
import type { Mode } from "../settings/schema.js";
import type { ApprovalBroker, ApprovalDecision } from "./approval.js";

export interface AgentRunDeps {
  readonly provider: Provider;
  /**
   * Every provider a run may reach, for a fallback that changes provider.
   *
   * Optional: without it, fallbacks stay on `provider`, which is the behaviour
   * from before fallbacks could cross providers.
   */
  readonly providers?: readonly Provider[];
  readonly registry: ToolRegistry;
  readonly gate: PermissionGate;
  readonly events: AgentEventBus;
  readonly approval: ApprovalBroker;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Called with every tool result so the host can persist it and audit it. */
  readonly onToolResult?: (input: {
    conversationId: string;
    messageId: string;
    runId: string;
    call: ToolCall;
    result: ToolResult;
    outcome: PermissionOutcome;
  }) => void | Promise<void>;
  /** Persist the assistant message once complete. */
  readonly onAssistantMessage?: (input: {
    conversationId: string;
    messageId: string;
    runId: string;
    message: ModelMessage;
    usage: Usage;
  }) => void | Promise<void>;
  /**
   * Vets each step's usage before the run continues.
   *
   * Called after the usage is known and before any tool runs, because the
   * moment a step turns out to have cost money is the last moment it can be
   * stopped cheaply.
   *
   * Three outcomes, and the middle one is the reason this is a union rather than
   * a string. `objection` halts the run and the step's text is kept, since
   * throwing away a real answer because of a pricing surprise would be a worse
   * lie than showing it with a warning attached. A `note` is not a halt: it is
   * something the user should know that does not make the answer wrong, like a
   * free model that publishes no price. Collapsing that into "a string means
   * stop" is what turned a successful free reply into a red banner.
   */
  readonly reviewUsage?: (input: {
    readonly conversationId: string;
    readonly runId: string;
    readonly model: string;
    readonly usage: Usage;
  }) => Promise<TurnCostReview | null> | TurnCostReview | null;
  /**
   * Whether a model is still worth trying, checked as each fallback is reached.
   *
   * Not a filter on the list up front. The list is ranked once, before the run
   * starts, and a model can be found unusable part-way through it -- the first
   * failure is itself evidence. Consulting it per attempt is what keeps a run
   * from walking into a model it has just learned cannot answer.
   */
  readonly isModelUsable?: (modelId: string) => boolean | Promise<boolean>;
  readonly compaction?: CompactionOptions | undefined;
  /** Summariser for compaction; defaults to a non-streaming provider call. */
  readonly summarize?: (transcript: string, signal?: AbortSignal) => Promise<string>;
}

/**
 * A fallback that names the provider serving it.
 *
 * Preferred over a bare id, and accepted alongside one so a caller that only has
 * single-provider alternatives does not have to wrap them.
 */
export interface FallbackModel {
  readonly model: string;
  readonly providerId: string;
  /** Shown in the model-switch notice, so the user can see who is answering. */
  readonly providerLabel?: string;
}

export interface AgentRunInput {
  readonly conversationId: string;
  readonly runId: string;
  readonly mode: Mode;
  readonly model: string;
  readonly system: string | undefined;
  readonly messages: readonly ModelMessage[];
  readonly workspace: string | null;
  /**
   * Folders the user authorized outside the workspace. See `ToolContext`.
   *
   * A function rather than an array, and the reason is `add_folder`: a folder
   * the agent requests and the user approves partway through this same run has
   * to be usable by the very next tool call. Captured once at the start of the
   * run, the new folder would be authorized in the settings and still refused by
   * the gate until the next message -- so the tool would appear to succeed and
   * change nothing, which is the most confusing failure available.
   *
   * A static list is still accepted so callers that cannot change mid-run do not
   * have to wrap theirs in a closure.
   */
  readonly extraRoots?: readonly string[] | (() => readonly string[]);
  readonly temperature?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxSteps?: number;
  readonly signal: AbortSignal;
  /** Skip the runtime model fallback for this run (e.g. the user pinned a model). */
  readonly allowModelFallback?: boolean;
  /**
   * Ordered alternative models to try when the chosen one is unavailable.
   *
   * Only consulted for errors that a different model would plausibly survive --
   * rate limits, missing models, and quota. An auth or network failure is not
   * the model's fault, and retrying it elsewhere just burns time.
   */
  readonly fallbackModels?: readonly (string | FallbackModel)[] | undefined;
  /**
   * Look up the provider that serves a fallback model.
   *
   * A bare model id is not enough once a fallback may be a different provider's
   * model, which is the whole point of falling back after a 429: the provider
   * that is rate limiting us is not going to serve the next one either. Without
   * this, a cross-provider fallback would be sent to the provider that just
   * failed and fail identically.
   *
   * Omitting it is not an error -- it just means fallbacks stay on the current
   * provider, which is the old behaviour.
   */
  readonly providerForFallback?: (modelId: string) => Provider | undefined;

  /** Override the gate's decision for a specific call, e.g. from an approval UI. */
  readonly approve?: (call: ToolCall, outcome: PermissionOutcome) => Promise<boolean>;
}

export interface AgentRunResult {
  readonly runId: string;
  readonly steps: number;
  readonly usage: Usage;
  /**
   * `length` means the provider stopped because it hit the output-token limit,
   * not because the model finished. The two are indistinguishable downstream
   * unless they are kept apart, and the difference is the whole point of the
   * Continue action.
   */
  readonly reason: "stop" | "tool-calls" | "cancelled" | "limit" | "length" | "error";
  readonly messages: ModelMessage[];
}

export class AgentLoop {
  #deps: AgentRunDeps;
  #newId: () => string;

  constructor(deps: AgentRunDeps) {
    this.#deps = deps;
    this.#newId = deps.newId ?? defaultId;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { provider, registry, gate, events, approval } = this.#deps;
    const maxSteps = input.maxSteps ?? 200;
    const tools = registry.specs(input.mode);

    const working: ModelMessage[] = [...input.messages];
    let usage: Usage = EMPTY_USAGE;
    let steps = 0;
    let reason: AgentRunResult["reason"] = "stop";
    let noted = false;

    events.emit({
      type: "run-start",
      runId: input.runId,
      conversationId: input.conversationId,
      mode: input.mode,
      model: input.model,
    });


    try {
      for (;;) {
        if (input.signal.aborted) {
          reason = "cancelled";
          break;
        }
        if (steps >= maxSteps) {
          reason = "limit";
          break;
        }
        steps++;
        events.emit({ type: "step-start", runId: input.runId, step: steps });

        const maybeCompacted = await this.#maybeCompact(input, working);
        if (maybeCompacted) {
          usage = addUsage(usage, EMPTY_USAGE);
          working.length = 0;
          working.push(...maybeCompacted);
        }

        const messageId = this.#newId();
        // Kept so the run can tell a complete answer from a truncated one.
        const message = await this.#withModelFallback({
          input,
          tools,
          messageId,
          working,
          currentModel: input.model,
        });

        usage = message.usage;
        events.emit({
          type: "usage",
          runId: input.runId,
          usage,
          model: message.modelId,
        });
        await this.#deps.onAssistantMessage?.({
          conversationId: input.conversationId,
          messageId,
          runId: input.runId,
          message: message.message,
          usage,
        });
        working.push(message.message);

        // After the answer is saved, before anything more is spent.
        const review = await this.#deps.reviewUsage?.({
          conversationId: input.conversationId,
          runId: input.runId,
          model: message.modelId,
          usage,
        });
        if (review && !review.ok) {
          events.emit({
            type: "run-error",
            runId: input.runId,
            message: review.reason,
            userMessage: review.reason,
            kind: "free-policy",
          });
          return {
            runId: input.runId,
            steps,
            usage,
            reason: "error",
            messages: working,
          };
        }

        // A note, not a halt. The step succeeded, and the thing worth saying is
        // something the user should know, not something that went wrong. Emitted
        // once per run because a step-by-step note would repeat the same
        // sentence on every tool call for the rest of the turn.
        if (review?.ok && review.note && !noted) {
          noted = true;
          events.emit({
            type: "run-note",
            runId: input.runId,
            message: review.note,
          });
        }

        if (message.message.toolCalls?.length) {
          await this.#runTools({
            input,
            messageId,
            calls: message.message.toolCalls,
            working,
          });
          continue;
        }

        // A provider that ran out of output tokens has not finished the answer.
        // Collapsing this into "stop" is what makes a truncated reply look
        // complete, with no indication that anything is missing.
        reason = message.finishReason === "length" ? "length" : "stop";
        break;
      }
    } catch (error) {
      if (isAbort(error)) {
        reason = "cancelled";
      } else if (error instanceof CrossProviderSwitchRequired) {
        // Already reported as an offer with a button, so it must not also be
        // rendered as a failure. The run is over either way.
        reason = "error";
      } else {
        const providerError = toProviderError(error);
        events.emit({
          type: "run-error",
          runId: input.runId,
          message: providerError.message,
          userMessage: providerError.userMessage,
          kind: providerError.kind,
        });
        events.emit({
          type: "run-finish",
          runId: input.runId,
          reason: "error",
          steps,
          usage,
        });
        return { runId: input.runId, steps, usage, reason: "error", messages: working };
      }
    }

    events.emit({
      type: "run-finish",
      runId: input.runId,
      reason: reason === "limit" || reason === "length" ? "length" : reason,
      steps,
      usage,
    });
    return { runId: input.runId, steps, usage, reason, messages: working };
  }

  /**
   * Stream one turn, retrying on a different model if this one is unavailable.
   *
   * Capped at `MAX_MODEL_FALLBACKS` attempts and never applied to a pinned
   * model: if the user chose a specific model, quietly answering with a
   * different one is not a fallback, it is a substitution. The user is told
   * through `model-switch` so the transcript never claims a model that was not
   * used.
   */
  async #withModelFallback(args: {
    input: AgentRunInput;
    tools: ReturnType<ToolRegistry["specs"]>;
    messageId: string;
    working: ModelMessage[];
    currentModel: string;
  }): Promise<{
    message: ModelMessage;
    usage: Usage;
    modelId: string;
    finishReason: FinishReason;
  }> {
    const { input, currentModel } = args;
    const events = this.#deps.events;
    // `usageRef` is not read by `#streamOnce`; it is threaded for the signature
    // the loop already had. Passed through so the shape stays stable.
    const fallbacks = input.allowModelFallback === false ? [] : (input.fallbackModels ?? []);
    let model = currentModel;
    let attempt = 0;
    // Not a parameter of `#streamOnce` on purpose: the run's own provider is the
    // right one for the model the user asked for, and only a fallback may need
    // to be sent somewhere else. Rebinding it here keeps the call sites above
    // from having to thread a provider through for the common case.
    let provider = this.#deps.provider;

    for (;;) {
      try {
        return await this.#streamOnce({
          input: args.input,
          tools: args.tools,
          messageId: args.messageId,
          working: args.working,
          usageRef: EMPTY_USAGE,
          model,
          ...(provider !== this.#deps.provider ? { provider } : {}),
        });
      } catch (error) {
        if (isAbort(error)) throw error;
        const providerError = toProviderError(error);
        // Only a model-scoped failure justifies switching. Auth, network and
        // parse errors would fail identically on the next model.
        if (attempt >= MAX_MODEL_FALLBACKS || !isModelScopedError(providerError.kind)) {
          throw error;
        }
        // Walk forward past anything already known to be unusable, including the
        // model that just failed. Skipping keeps the counter honest: these are
        // not attempts, and charging them against the cap would silently shorten
        // how far a run can recover.
        // Same provider: staying is a fallback, and the user asked for a model
        // on this provider, so being sent a different one from it needs no
        // further permission. A *different* provider is a different thing --
        // a different account, a different key, a different bill, a different
        // data processor. That is never done behind the user's back, so it is
        // collected and offered rather than taken.
        //
        // The two passes do not consume the list. A single pass that skipped
        // same-provider entries would have already spent the ones it skipped, so
        // a fallback list of [other-provider, same-provider] would silently lose
        // its second entry -- which is exactly the list Auto produces, ranked
        // across providers.
        const usable: { model: string; provider: Provider }[] = [];
        for (let index = attempt; index < fallbacks.length; index++) {
          const entry = fallbacks[index];
          if (entry === undefined) continue;
          const candidate = typeof entry === "string" ? entry : entry.model;
          if (candidate === model) continue;
          const candidateProvider =
            typeof entry === "string"
              ? (input.providerForFallback?.(candidate) ?? provider)
              : this.#providerFor(entry, provider);
          // A provider that could not be resolved is unusable, not "same
          // provider": it is skipped here and the search carries on.
          if (!candidateProvider) continue;
          // No hook means nothing is known, and "not known" is not "known bad".
          // Defaulting the other way would disable fallback entirely.
          if ((await this.#deps.isModelUsable?.(candidate)) === false) continue;
          usable.push({ model: candidate, provider: candidateProvider });
        }
        // Same provider first, and the cross-provider entry is only reached when
        // the run cannot be finished by this account at all.
        const next =
          usable.find((entry) => entry.provider === provider) ??
          usable.find((entry) => entry.provider !== provider);
        if (!next) throw error;

        // The cross-provider case, offered rather than taken.
        if (next.provider !== provider) {
          events.emit({
            type: "provider-switch-required",
            runId: input.runId,
            from: model,
            to: next.model,
            providerId: next.provider.id,
            providerLabel: next.provider.name,
            reason: modelSwitchReason(providerError.kind, providerError.userMessage),
          });
          throw new CrossProviderSwitchRequired(
            next.model,
            next.provider.id,
            next.provider.name,
          );
        }
        // Every entry up to and including the chosen one is spent; the ones
        // scanned past it are not, so a later failure can still reach them.
        const chosenAt = fallbacks.findIndex(
          (entry, index) =>
            index >= attempt &&
            (typeof entry === "string" ? entry : entry.model) === next.model,
        );
        if (chosenAt >= 0) attempt = chosenAt + 1;
        this.#deps.events.emit({
          type: "model-switch",
          runId: input.runId,
          from: model,
          to: next.model,
          reason: modelSwitchReason(providerError.kind, providerError.userMessage),
          // Named in the notice because a switch to another provider is a
          // different fact from a switch to another model, and the user cannot
          // otherwise tell a rate limit on Zen from one on OpenRouter.
          ...(next.provider !== provider ? { providerLabel: next.provider.name } : {}),
        });
        model = next.model;
        if (next.provider !== provider) provider = next.provider;
      }
    }
  }

  /**
   * Resolve a fallback entry to a provider.
   *
   * Only entries that name a provider are resolved; a bare id is the old
   * single-provider form and stays on the current provider. Returning undefined
   * for an unresolvable provider is deliberate -- it makes the entry unusable
   * rather than silently sending it somewhere it may not exist.
   */
  #providerFor(entry: FallbackModel, current: Provider): Provider | undefined {
    if (entry.providerId === current.id) return current;
    return this.#deps.providers?.find((candidate) => candidate.id === entry.providerId);
  }

  async #streamOnce(args: {
    input: AgentRunInput;
    tools: ReturnType<ToolRegistry["specs"]>;
    messageId: string;
    working: ModelMessage[];
    usageRef: Usage;
    model: string;
    /**
     * The provider to call. Omitted for the run's own provider; supplied only
     * when a cross-provider fallback is being tried, which is the one case where
     * the model and the provider are not the pair the run started with.
     */
    readonly provider?: Provider;
  }): Promise<{
    message: ModelMessage;
    usage: Usage;
    modelId: string;
    /** The provider's own account of why it stopped. */
    finishReason: FinishReason;
  }> {
    const { input, tools, messageId, working } = args;
    const { events } = this.#deps;
    const provider = args.provider ?? this.#deps.provider;

    let text = "";
    let reasoning = "";
    let usage: Usage = EMPTY_USAGE;
    // Only this value distinguishes a complete answer from one the provider cut
    // off at its output-token limit.
    let finishReason: FinishReason = "stop";
    const calls: ToolCall[] = [];

    for await (const event of provider.stream(
      {
        providerId: provider.id,
        model: args.model,
        messages: working,
        ...(input.system ? { system: input.system } : {}),
        ...(tools.length ? { tools } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        signal: input.signal,
      },
      { signal: input.signal },
    )) {
      switch (event.type) {
        case "text-delta":
          text += event.text;
          events.emit({ type: "text-delta", runId: input.runId, messageId, text: event.text });
          break;
        case "reasoning-delta":
          reasoning += event.text;
          events.emit({ type: "reasoning-delta", runId: input.runId, messageId, text: event.text });
          break;
        case "tool-call-end":
          calls.push(event.call);
          break;
        case "usage":
          usage = event.usage;
          break;
        case "done":
          usage = event.usage;
          finishReason = event.finishReason;
          break;
        default:
          break;
      }
    }

    const message: ModelMessage = {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      ...(calls.length ? { toolCalls: calls } : {}),
      ...(reasoning ? { reasoning: { text: reasoning, signature: "" } } : {}),
    };
    events.emit({
      type: "assistant-message",
      runId: input.runId,
      messageId,
      text,
      // Same value the run reports: a turn cut off at the token limit is not a
      // completed turn, and the transcript records what the provider said.
      finishReason: calls.length ? "tool-calls" : finishReason,
    });
    // Reported so usage and any model switch are attributed to the model that
    // actually produced the turn, not the one the run started on.
    return { message, usage, modelId: args.model, finishReason };
  }

  async #runTools(args: {
    input: AgentRunInput;
    messageId: string;
    calls: readonly ToolCall[];
    working: ModelMessage[];
  }): Promise<void> {
    const { input, messageId, calls, working } = args;
    const { registry, gate, events, approval } = this.#deps;

    // Tool calls in one assistant turn are independent: run them in parallel
    // unless a tool opts out via `sequential`.
    for (const call of calls) {
      const tool = registry.get(call.name);
      if (!tool) {
        working.push(toolMessage(call, `Unknown tool "${call.name}". It is not available in this mode.`, true));
        continue;
      }

      const outcome = gate.check({
        mode: input.mode,
        tool,
        args: call.args,
        workspace: input.workspace,
        extraRoots: resolveExtraRoots(input.extraRoots),
        conversationId: input.conversationId,
        runId: input.runId,
      });

      events.emit({
        type: "tool-call",
        runId: input.runId,
        messageId,
        call,
        summary: describeCall(call),
      });

      let allowed = outcome.decision === "allow";
      if (outcome.decision === "deny") {
        events.emit({
          type: "tool-approval-resolved",
          runId: input.runId,
          callId: call.id,
          decision: "deny",
          rule: outcome.rule,
        });
        working.push(
          toolMessage(call, `Permission denied: ${outcome.reason} The agent may try a different approach.`, true),
        );
        await this.#deps.onToolResult?.({
          conversationId: input.conversationId,
          messageId,
          runId: input.runId,
          call,
          result: { content: outcome.reason, isError: true },
          outcome,
        });
        continue;
      }

      if (!allowed) {
        events.emit({
          type: "tool-approval-requested",
          runId: input.runId,
          callId: call.id,
          tool: call.name,
          args: call.args,
          summary: outcome.reason,
          ...(outcome.allowSuggestion ? { suggestion: outcome.allowSuggestion } : {}),
        });
        const decision: ApprovalDecision = input.approve
          ? (await input.approve(call, outcome))
            ? "allow"
            : "deny"
          : await approval.request({
              runId: input.runId,
              callId: call.id,
              tool: call.name,
              args: call.args,
              summary: outcome.reason,
              ...(outcome.allowSuggestion ? { suggestion: outcome.allowSuggestion } : {}),
              signal: input.signal,
            });
        // "allow-always" is an allow. It was compared against `"allow"` alone for
        // the whole life of this function, so the Allow always button in the
        // approval card denied the action it was meant to permit: `allowed` came
        // out false, the tool was reported as refused, and the user was left
        // believing the agent had ignored them.
        allowed = decision !== "deny";
        events.emit({
          type: "tool-approval-resolved",
          runId: input.runId,
          callId: call.id,
          decision: allowed ? "allow" : "deny",
          rule: allowed ? "user_approved" : outcome.rule,
        });
      }

      if (!allowed) {
        working.push(toolMessage(call, "The user denied this action. Do not retry it; continue or explain.", true));
        await this.#deps.onToolResult?.({
          conversationId: input.conversationId,
          messageId,
          runId: input.runId,
          call,
          result: { content: "Denied by user.", isError: true },
          outcome,
        });
        continue;
      }

      if (input.signal.aborted) {
        working.push(toolMessage(call, "Cancelled by the user before the action ran.", true));
        return;
      }

      let result: ToolResult;
      try {
        const args = tool.parse ? tool.parse(call.args) : (call.args as never);
        result = await tool.execute(args, {
          conversationId: input.conversationId,
          messageId,
          runId: input.runId,
          mode: input.mode,
          signal: input.signal,
          workspace: input.workspace,
          extraRoots: () => resolveExtraRoots(input.extraRoots),
          describe: (a) => describeCall({ name: call.name, args: a } as ToolCall),
        });
      } catch (error) {
        const providerError = toProviderError(error, "parse");
        result = { content: `Tool "${call.name}" failed: ${providerError.message}`, isError: true };
      }

      working.push(toolMessage(call, truncateForModel(result.content), result.isError === true));
      events.emit({
        type: "tool-result",
        runId: input.runId,
        callId: call.id,
        tool: call.name,
        isError: result.isError === true,
        summary: summarizeResult(result.content),
        ...(result.display === undefined ? {} : { display: result.display }),
      });
      await this.#deps.onToolResult?.({
        conversationId: input.conversationId,
        messageId,
        runId: input.runId,
        call,
        result,
        outcome,
      });
    }
  }

  async #maybeCompact(input: AgentRunInput, working: ModelMessage[]): Promise<ModelMessage[] | null> {
    const options = this.#deps.compaction;
    if (!options) return null;
    const plan = planCompaction(working, options);
    if (!plan.needsCompaction) return null;

    const summarize =
      this.#deps.summarize ??
      (async (transcript: string) => {
        const response = await this.#deps.provider.complete(
          {
            providerId: this.#deps.provider.id,
            model: input.model,
            system:
              "Summarise the conversation so far. Keep decisions, file paths, identifiers, errors, and anything the assistant must remember to continue. Be terse and factual. Output plain text.",
            messages: [{ role: "user", content: [{ type: "text", text: transcript }] }],
            maxOutputTokens: 2048,
            signal: input.signal,
          },
          { signal: input.signal },
        );
        return response.message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n");
      });

    const result = await compactMessages(working, plan, summarize, input.signal);
    this.#deps.events.emit({
      type: "compacted",
      runId: input.runId,
      removedMessages: result.removedMessages,
      freedTokens: result.freedTokens,
    });
    return result.messages;
  }
}

/** Upper bound on model switches per turn, so a bad key cannot loop. */
const MAX_MODEL_FALLBACKS = 2;

/** Failures another model would plausibly avoid. */
function isModelScopedError(kind: string): boolean {
  // `forbidden` is per-model on Zen (a workspace admin can disable one model
  // while leaving the rest enabled), so a different model is a real fix rather
  // than a coin toss. `auth` stays off this list: a rejected key fails the same
  // way everywhere.
  return (
    kind === "rate-limit" ||
    kind === "not-found" ||
    kind === "unsupported-model" ||
    kind === "invalid-request" ||
    kind === "forbidden"
  );
}

/** One phrase, for the "Switched to X because Y" notice. */
/**
 * Thrown when a run cannot be finished by its own account and the only way
 * forward is a different provider.
 *
 * A distinct type because the catch above turns every other error into a
 * `run-error`, and this one has already been reported as an offer the user can
 * accept. Reported as a plain failure, the only thing the user could do was
 * read that it failed -- and the offer to fix it would have scrolled away with
 * the error banner.
 */
export class CrossProviderSwitchRequired extends Error {
  readonly model: string;
  readonly providerId: string;
  readonly providerLabel: string;

  constructor(model: string, providerId: string, providerLabel: string) {
    super(
      `${providerLabel} can answer this one. Atomic will not send it there without permission, because that is a different account and a different bill.`,
    );
    this.name = "CrossProviderSwitchRequired";
    this.model = model;
    this.providerId = providerId;
    this.providerLabel = providerLabel;
  }
}

function modelSwitchReason(kind: string, userMessage: string): string {
  switch (kind) {
    case "rate-limit":
      return "it hit a rate limit";
    case "not-found":
    case "unsupported-model":
      return "the provider no longer serves it";
    case "invalid-request":
      return `the provider rejected the request (${userMessage})`;
    default:
      return userMessage;
  }
}

function toolMessage(call: ToolCall, content: string, isError: boolean): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "text", text: content }],
    toolCallId: call.id,
    toolName: call.name,
  };
}

/**
 * Read the authorized folders as they are *now*, not as they were when the run
 * began. `add_folder` changes this list from inside the loop, and a value read
 * once at entry would leave the next call in the same run working from a list
 * that no longer describes what the user approved.
 */
function resolveExtraRoots(
  extraRoots: readonly string[] | (() => readonly string[]) | undefined,
): readonly string[] {
  if (typeof extraRoots === "function") return extraRoots();
  return extraRoots ?? [];
}

function describeCall(call: ToolCall): string {
  const args = call.args ?? {};
  for (const key of ["command", "url", "path", "file_path", "pattern", "query"]) {
    const value = args[key];
    if (typeof value === "string" && value) {
      return `${call.name}: ${value.length > 120 ? `${value.slice(0, 120)}…` : value}`;
    }
  }
  return call.name;
}

function summarizeResult(content: string): string {
  const firstLine = content.split("\n", 1)[0] ?? "";
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}

/** Keep a single tool result from flooding the context window. */
const MAX_TOOL_RESULT_CHARS = 60_000;

function truncateForModel(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  const head = content.slice(0, Math.floor(MAX_TOOL_RESULT_CHARS * 0.7));
  const tail = content.slice(-Math.floor(MAX_TOOL_RESULT_CHARS * 0.25));
  return `${head}\n\n… [${content.length - head.length - tail.length} characters truncated] …\n\n${tail}`;
}

function defaultId(): string {
  const crypto = globalThis.crypto;
  if (crypto && "randomUUID" in crypto) return crypto.randomUUID();
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export { ProviderError, isReadOnlyTool };
