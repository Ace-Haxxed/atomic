/**
 * The application shell.
 *
 * Owns exactly three pieces of state — the active conversation, the mode, and
 * which overlay is open — because everything else already lives in the host. The
 * screen is therefore a projection of the host plus the run stream, and there is
 * no second copy of the truth in React.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Conversation,
  ConversationSummary,
  HostApi,
  Mode,
  Settings,
  StoredMessage,
} from "@atomic/core";
import {
  FreePolicyError,
  SettingsSchema,
  hasTools,
  permissionFor,
  pickConversationForMode,
  pruneEmptyConversations,
} from "@atomic/core";
import { Badge, Button, Select, Spinner, cn } from "@atomic/ui";

import { useAgentRun } from "./use-agent-run.js";
import { useModeResolutions, useModels } from "./use-models.js";
import { ModelSelect, AutoModelNote } from "../components/model-select.js";
import { ApprovalCard } from "../components/approval-card.js";
import { PlanApproval } from "../components/plan-approval.js";
import { PaidModelPrompt } from "../components/paid-model-prompt.js";
import { Composer } from "../components/composer.js";
import { runSlashCommand } from "./slash-commands.js";
import { MessageList, type FailedMessage } from "../components/message-list.js";
import { Onboarding } from "../components/onboarding.js";
import { SettingsPanel } from "../components/settings-panel.js";
import { Icon, Sidebar } from "../components/sidebar.js";
import { window as hostWindow } from "../lib/host.js";

type Overlay = "none" | "settings";

export interface AppProps {
  readonly api: HostApi;
  /** Non-null when the database is in memory only. Never hidden from the user. */
  readonly degraded?: { readonly reason: string } | null;
}

export function App({ api, degraded = null }: AppProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mode, setMode] = useState<Mode>("chat");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<readonly StoredMessage[]>([]);
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  const run = useAgentRun(api);

  // ---- load settings once ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setMode(loaded.lastMode);
        setSidebarCollapsed(loaded.app.sidebarCollapsed);
        // Match the OS: the setting is the user's intent, the plugin is reality.
        void hostWindow.setCloseToTray(loaded.app.closeToTray).catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFatal(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Models load independently of settings, so a catalog failure shows up as a
  // retryable message on the picker instead of blocking the whole window.
  const modelCatalog = useModels(api, {
    enabled: settings !== null,
    mode: mode ?? "chat",
    ...(settings ? { configured: settings.models[mode ?? "chat"] } : {}),
    onlyFree: settings?.autoSelectFreeModelsOnly ?? true,
  });

  // Asked of the host rather than derived here, and only about the mode on
  // screen: a notice about `code` while someone is chatting is noise, and the
  // header for that mode will say it when they switch.
  // Parsed defaults, not a hand-written object: the hook reads nested model and
  // provider settings, and a literal missing one of those would be a crash on a
  // path that exists precisely so startup cannot crash.
  const resolutions = useModeResolutions(api, settings ?? SettingsSchema.parse({}));
  const missingSelection =
    mode === null
      ? null
      : (resolutions.find((row) => row.mode === mode) ?? null);

  // Nothing is wrong with a pinned model. The notice is only for a mode pointed
  // at something that is gone.
  const missingNotice =
    missingSelection && missingSelection.notice ? missingSelection : null;

  // ---- conversation lifecycle -------------------------------------------
  const openConversation = useCallback(
    async (id: string) => {
      try {
        const [found, history] = await Promise.all([
          api.getConversation(id),
          api.getMessages(id),
        ]);
        if (!found) return;
        setConversation(found);
        setMessages(history);
      } catch (error) {
        setFatal(error instanceof Error ? error.message : String(error));
      }
    },
    [api],
  );

  /**
   * A blank chat for this mode.
   *
   * Reuses the existing empty chat when there is one, so pressing "New chat"
   * three times does not leave three identical `Untitled` rows. The moment the
   * chat has any content it stops being empty and the next press makes a new
   * one, which is the behaviour you want once you are actually working.
   */
  const newChat = useCallback(async () => {
    try {
      const all = await api.listConversations().catch(() => []);
      const { reuse, prune } = pickConversationForMode(all, mode);
      for (const id of prune) {
        await api.deleteConversation(id).catch(() => undefined);
      }
      if (reuse) {
        await openConversation(reuse.id);
        return;
      }
      const created = await api.createConversation({ mode });
      setConversation(created);
      setMessages([]);
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error));
    }
  }, [api, mode, openConversation]);

  /**
   * Open the right conversation for a mode: a real chat if there is one, else the
   * blank chat that already exists, else a new one.
   *
   * Creating a fresh chat here is what produced the pile of empty `Untitled`
   * rows: every launch added one, every mode switch added another, and the
   * blank chat you just made was never the blank chat you got back.
   */
  const openForMode = useCallback(
    async (target: Mode, all: readonly ConversationSummary[]): Promise<void> => {
      const { reuse, prune } = pickConversationForMode(all, target);
      for (const id of prune) {
        // Best effort: a leftover row is untidy, not worth failing a launch over.
        await api.deleteConversation(id).catch(() => undefined);
      }
      if (reuse) await openConversation(reuse.id);
      else await api.createConversation({ mode: target }).then(setConversation).catch(() => undefined);
    },
    [api, openConversation],
  );

  // Open the last chat on launch, or start one, so the window is never empty.
  //
  // The ref guard matters: `changeMode` clears the conversation and then loads
  // one itself, and this effect would otherwise see `null` and create a second
  // conversation for the same mode.
  const switchingMode = useRef(false);
  useEffect(() => {
    if (!settings || conversation || switchingMode.current) return;
    let cancelled = false;
    void (async () => {
      // Unfiltered, so one pass can both choose this mode's chat and clean up
      // the surplus blanks the other modes left behind.
      const all = await api.listConversations().catch(() => []);
      if (cancelled) return;
      for (const id of pruneEmptyConversations(all)) {
        await api.deleteConversation(id).catch(() => undefined);
      }
      await openForMode(mode, all);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, settings, conversation, mode, openForMode]);

  // Switching mode filters the transcript, so the old chat is not left on screen.
  const changeMode = useCallback(
    async (next: Mode) => {
      if (next === mode) return;
      switchingMode.current = true;
      setMode(next);
      setConversation(null);
      setMessages([]);
      try {
        await api.updateSettings({ lastMode: next });
        const all = await api.listConversations();
        await openForMode(next, all);
      } catch (error) {
        setFatal(error instanceof Error ? error.message : String(error));
      } finally {
        switchingMode.current = false;
      }
    },
    [api, mode, openForMode],
  );

  // ---- turn handling -----------------------------------------------------
  // The run writes rows asynchronously; re-reading on `settledAt` is the only
  // way to be sure the transcript matches what was persisted.
  useEffect(() => {
    if (!conversation || run.settledAt === 0) return;
    let cancelled = false;
    void api
      .getMessages(conversation.id)
      .then((history) => {
        if (!cancelled) setMessages(history);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, conversation, run.settledAt]);

  /**
   * A model the policy would not run, awaiting an answer.
   *
   * Kept as state rather than handled inside `send`, because answering means
   * sending the same message again and the message itself is not available at
   * the point the prompt is rendered.
   */
  const [pendingPaid, setPendingPaid] = useState<{
    model: string;
    reason: string;
    text: string;
    attachments: Parameters<HostApi["sendMessage"]>[0]["attachments"];
  } | null>(null);
  /** A refusal the user cannot argue with, shown inline rather than as a crash. */
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);
  const [continuePending, setContinuePending] = useState(false);
  /**
   * The last message that failed to send, kept so it can be shown and retried.
   *
   * `null` when there is nothing outstanding. The text is held here rather than
   * left in the composer so it cannot be overwritten by the next thing typed.
   */
  const [failedMessage, setFailedMessage] = useState<FailedMessage | null>(null);

  const send = useCallback(
    async (
      text: string,
      attachments: Parameters<HostApi["sendMessage"]>[0]["attachments"] = [],
      allowPaidModel = false,
    ) => {
      if (!conversation) return;
      try {
        await api.sendMessage({
          conversationId: conversation.id,
          text,
          attachments,
          ...(allowPaidModel ? { allowPaidModel: true } : {}),
        });
        setPendingPaid(null);
        setPolicyNotice(null);
        // Only cleared on success: clearing it on failure would take the user's
        // text with it.
        setFailedMessage(null);
      } catch (error) {
        if (error instanceof FreePolicyError) {
          // Neither of these is a crash, and treating either as one replaced the
          // whole app with an error page -- for what is either a question or a
          // sentence of explanation.
          if (error.decision === "confirm") {
            setPolicyNotice(null);
            setPendingPaid({
              model: error.model,
              reason: error.detail,
              text,
              attachments,
            });
          } else {
            setPendingPaid(null);
            setPolicyNotice(error.message);
          }
          return;
        }
        // A send failure is about one message, not about the app. It is shown
        // against that message and stays there until it is retried or discarded;
        // replacing the window with "Atomic could not start" tells the user
        // something untrue and discards what they wrote.
        setFailedMessage({
          text,
          attachmentNames: attachments.map((a) => a.name),
          error: error instanceof Error ? error.message : String(error),
          pending: false,
          onRetry: () => void send(text, attachments, allowPaidModel),
          onDiscard: () => setFailedMessage(null),
        });
      }
    },
    [api, conversation],
  );

  /**
   * Ask for the rest of a truncated answer.
   *
   * Sent as its own host call rather than as text in the composer: the user
   * never typed a follow-up question, and recording one would put words in their
   * voice into their own transcript.
   */
  const continueAnswer = useCallback(async () => {
    if (!conversation || continuePending) return;
    setContinuePending(true);
    try {
      await api.continueMessage({ conversationId: conversation.id });
    } catch (error) {
      setPolicyNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setContinuePending(false);
    }
  }, [api, conversation, continuePending]);

  // ---- tray and menu navigation -----------------------------------------
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<string>("atomic:navigate", (event) => {
          if (event.payload === "settings") setOverlay("settings");
          else if (event.payload === "new-chat") void newChat();
        }),
      )
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {
        // Outside a Tauri window there is no tray to listen to.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [newChat]);

  // ---- render ------------------------------------------------------------
  if (fatal) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface p-6">
        {/*
          Left-aligned and wider than the rest of this screen on purpose: a
          schema failure is reported in full, naming the migration and what to
          do about it, and a single centred line of wrapped 12px text hides
          exactly the part the user needs to read.
        */}
        <div className="max-w-lg space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-danger">
            <Icon name="alert" className="size-4 shrink-0" />
            Atomic could not start
          </p>
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-content-muted">
            {fatal}
          </p>
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <Spinner className="size-5 text-content-muted" />
      </div>
    );
  }

  if (!settings.onboardingCompleted) {
    return (
      <Onboarding
        api={api}
        settings={settings}
        onDone={(next) => setSettings(next)}
      />
    );
  }

  const permission = permissionFor(settings, mode);
  const streaming =
    run.status === "running" &&
    run.conversationId === conversation?.id &&
    (run.text.length > 0 || run.reasoning.length > 0);

  return (
    <div className="flex h-screen overflow-hidden bg-surface text-content">
      <Sidebar
        api={api}
        mode={mode}
        level={permission.level}
        activeId={conversation?.id ?? null}
        collapsed={sidebarCollapsed}
        onModeChange={(next) => void changeMode(next)}
        onSelect={(id) => void openConversation(id)}
        onNewChat={() => void newChat()}
        onOpenSettings={() => setOverlay("settings")}
        onCollapse={() => {
          setSidebarCollapsed(true);
          void api.updateSettings({ app: { ...settings.app, sidebarCollapsed: true } });
        }}
        onExpand={() => {
          setSidebarCollapsed(false);
          void api.updateSettings({ app: { ...settings.app, sidebarCollapsed: false } });
        }}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border-base px-3">
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {conversation?.title ?? "New chat"}
          </h1>

          {/*
            Always rendered. Hiding it on an empty list is what made a failed
            fetch look like a broken app rather than a fixable network problem.
          */}
          <span className="flex min-w-0 flex-col items-end gap-0.5">
            <ModelSelect
              label={`Model for ${mode} mode`}
              state={modelCatalog}
              value={settings.models[mode] || ""}
              settings={settings}
              mode={mode}
              onChange={(id, providerId) => {
                void api.setModelForMode(mode, id, providerId).then((next) => setSettings(next));
              }}
            />
            {modelCatalog.usingAuto ? <AutoModelNote state={modelCatalog} /> : null}
          </span>

          {/* Only where tools exist; see hasTools(). */}
          {permission.level === "bypass" && hasTools(mode) ? (
            <Badge tone="danger" className="animate-pulse">
              bypass
            </Badge>
          ) : null}

          {conversation?.workspace ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void api.revealPath(conversation.workspace!)}
              title="Reveal workspace"
            >
              <Icon name="folder" />
              <span className="max-w-32 truncate text-[11px]">
                {conversation.workspace.split(/[\\/]/).pop()}
              </span>
            </Button>
          ) : null}

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setOverlay(overlay === "settings" ? "none" : "settings")}
            title="Settings"
          >
            <Icon name="gear" />
          </Button>
        </header>

        {/*
          The banner is about tool calls, so it is scoped to the modes that have
          tools. Chat cannot run any, and warning there would train people to
          ignore the one indicator that matters.
        */}
        {permission.level === "bypass" && hasTools(mode) ? (
          <p
            role="status"
            className={cn(
              "flex items-center gap-1.5 border-b border-danger/40 bg-danger/10 px-3 py-1",
              "text-[11px] font-medium text-danger",
            )}
          >
            <Icon name="alert" className="size-3" />
            Permission checks are off. Every tool call runs without asking.
          </p>
        ) : null}

        {missingNotice ? (
          // Not dismissible, because there is nothing to dismiss it *to*: the
          // mode is pointed at a model that does not exist, and the next send
          // would quietly use something else. Naming the replacement is the
          // difference between a warning and a surprise.
          <p
            role="status"
            className={cn(
              "flex items-start gap-1.5 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5",
              "text-[11px] font-medium text-amber-700 dark:text-amber-400",
            )}
          >
            <Icon name="alert" className="mt-px size-3 shrink-0" />
            <span className="min-w-0 flex-1">
              {missingNotice.notice}
              <button
                type="button"
                className="ml-2 underline underline-offset-2"
                onClick={() => setOverlay("settings")}
              >
                Choose a model
              </button>
            </span>
          </p>
        ) : null}

        {degraded ? (
          // Deliberately above everything and never dismissible: if the database
          // is in memory, every conversation and setting is about to be lost.
          <p
            role="alert"
            className={cn(
              "flex items-start gap-1.5 border-b border-danger/40 bg-danger/10 px-3 py-1.5",
              "text-[11px] font-medium text-danger",
            )}
          >
            <Icon name="alert" className="mt-px size-3 shrink-0" />
            <span>
              Not saving. {degraded.reason} Conversations and settings will be
              lost when you quit.
            </span>
          </p>
        ) : null}

        <MessageList
          messages={messages}
          liveText={run.text}
          liveReasoning={run.reasoning}
          tools={run.tools}
          streaming={Boolean(streaming)}
          pendingApproval={run.pendingApprovals.length > 0}
          error={run.error}
          usage={run.usage}
          notice={run.modelSwitched}
          truncated={run.truncated}
          onContinue={conversation ? () => void continueAnswer() : undefined}
          failedMessage={failedMessage}
        />

        <div className="mx-auto w-full max-w-3xl space-y-2 px-4">
          {run.pendingApprovals.map((approval) => (
            <ApprovalCard
              key={approval.callId}
              approval={approval}
              onResolve={(callId, decision) => void run.resolveApproval(callId, decision)}
            />
          ))}
        </div>

        <div className="mx-auto w-full max-w-3xl space-y-2 px-4">
          {policyNotice ? (
            <p
              role="status"
              className="text-muted-foreground border-border bg-muted/40 rounded-md border px-3 py-2 text-sm"
            >
              {policyNotice}
            </p>
          ) : null}
          {pendingPaid ? (
            <PaidModelPrompt
              model={pendingPaid.model}
              reason={pendingPaid.reason}
              busy={run.isBusy}
              onAllow={() =>
                void send(pendingPaid.text, pendingPaid.attachments, true)
              }
              onDecline={() => {
                // The model list lives in Settings, so that is where the choice
                // can actually be made.
                setPendingPaid(null);
                setOverlay("settings");
              }}
            />
          ) : null}
        </div>

        <div className="px-4">
          <PlanApproval
            planning={permission.level === "plan"}
            settled={run.status === "done" || run.status === "error"}
            busy={run.isBusy}
            hasPlan={messages.length > 0}
            onApprove={async (level) => {
              try {
                const next = await api.setPermission(mode, { level });
                setSettings(next);
                if (conversation) {
                  await api.sendMessage({
                    conversationId: conversation.id,
                    text: "Plan approved. Carry it out.",
                    attachments: [],
                  });
                }
              } catch (error) {
                setFatal(error instanceof Error ? error.message : String(error));
              }
            }}
            onLeavePlanning={() => {
              void api
                .setPermission(mode, { level: "ask" })
                .then(setSettings)
                .catch((error: unknown) =>
                  setFatal(error instanceof Error ? error.message : String(error)),
                );
            }}
          />
        </div>

        <Composer
          disabled={run.isBusy || conversation === null}
          sendKey={settings.sendKey}
          workspace={conversation?.workspace ?? null}
          mode={mode}
          onCommand={(command, argument) =>
            runSlashCommand(command, argument, {
              api,
              mode,
              settings,
              conversationId: conversation?.id ?? null,
              newChat,
              setModel: async (id) => {
                // A typed id names a model, not a provider, so the host resolves
                // which configured provider serves it.
                const providerId = await api.providerForModel(id);
                const next = await api.setModelForMode(mode, id, providerId);
                setSettings(next);
              },
              setLevel: async (level) => {
                const next = await api.setPermission(mode, { level });
                setSettings(next);
              },
              fail: setFatal,
            })
          }
          onSend={(text, attachments) => void send(text, attachments)}
          onStop={run.cancel}
          onAttach={() => api.pickFiles({ multiple: true })}
          onPickFolder={async () => {
            const folder = await api.pickFolder("Choose a workspace folder");
            if (folder && conversation) {
              await api
                .updateSettings({ lastWorkspace: folder })
                .then(() => openConversation(conversation.id));
            }
            return folder;
          }}
        />
      </main>

      {overlay === "settings" ? (
        <aside className="flex w-[26rem] shrink-0 flex-col border-l border-border-base">
          <SettingsPanel
            api={api}
            initial={settings}
            mode={mode}
            onModeChange={(next) => void changeMode(next)}
            onClose={() => setOverlay("none")}
            onSettings={setSettings}
          />
        </aside>
      ) : null}
    </div>
  );
}
