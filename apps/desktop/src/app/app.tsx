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
import { startNewChat } from "./new-chat.js";
import { useModeResolutions, useModels } from "./use-models.js";
import {
  ModelSelect,
  AutoModelNote,
  OnlyFreeToggle,
} from "../components/model-select.js";
import { ApprovalCard } from "../components/approval-card.js";
import { PlanApproval } from "../components/plan-approval.js";
import { PaidModelPrompt } from "../components/paid-model-prompt.js";
import { ProviderOffer } from "../components/provider-offer.js";
import { Composer } from "../components/composer.js";
import { runSlashCommand } from "./slash-commands.js";
import { MessageList, type FailedMessage } from "../components/message-list.js";
import { Onboarding } from "../components/onboarding.js";
import { SettingsPanel } from "../components/settings-panel.js";
import { Icon, MODE_LABELS, Sidebar } from "../components/sidebar.js";
import { window as hostWindow } from "../lib/host.js";

type Overlay = "none" | "settings";

/**
 * How long "Already on a new chat." stays up.
 *
 * Long enough to be read at a glance, short enough that it is not still there
 * when the user comes back from whatever the note interrupted. It is also
 * announced, so this is not the only channel.
 */
const NEW_CHAT_NOTE_MS = 4000;

/**
 * True for the platform's "new" chord on the current keymap.
 *
 * `ctrlKey` on Linux/Windows, `metaKey` on macOS. Both are accepted on every
 * platform rather than sniffed: a wrong-platform chord is harmless here, and
 * sniffing the platform wrong is how a shortcut ends up dead on exactly the
 * platform it was written for.
 */
const isNewChatChord = (event: KeyboardEvent): boolean =>
  (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "n";

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
  /**
   * A failed action that must not take the window down with it.
   *
   * `fatal` is for the app being unable to start. "New chat" failing is a
   * button that did not work, and answering that by replacing the transcript
   * with "Atomic could not start" is the loudest possible way to say nothing
   * useful: the user's conversation is still on screen underneath and still
   * fine, so the error destroys working state to report a non-event.
   */
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * A brief "nothing changed, on purpose" note.
   *
   * Separate from `actionError` because it is not an error, and separate from
   * `fatal` because the app is fine. It exists for one case: pressing New chat
   * while already on a blank chat reuses that chat, which is correct behaviour
   * and looks exactly like a dead button. A user who cannot tell "that did
   * nothing" from "that is broken" will keep pressing it, or conclude the app is
   * broken, and both are reasonable given no feedback.
   *
   * Cleared by a timer rather than left to the next press, so it cannot go stale
   * and sit there explaining a press the user has forgotten.
   */
  const [newChatNote, setNewChatNote] = useState<string | null>(null);
  /**
   * Bumped to remount the composer, which is how a new chat gets an empty
   * composer.
   *
   * The composer owns its draft in local state and has no key, so it survives
   * everything above it: switching conversations, switching modes and pressing
   * "New chat" all left the half-typed message in the box. A remount clears the
   * text, the attachments and the command menu together, and takes focus with it
   * -- which is also the second thing that was broken, since focus was left on
   * the button the user had just pressed.
   */
  const [draftKey, setDraftKey] = useState(0);
  /**
   * The open conversation, readable from callbacks that must not re-create
   * themselves on every change.
   */
  const conversationRef = useRef<string | null>(null);
  conversationRef.current = conversation?.id ?? null;

  const run = useAgentRun(api);

  const newChatNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Shows the reuse note, and takes it away again.
   *
   * One timer, held here rather than handed back to the caller: a second press
   * while the first note is still up restarts the window instead of racing it,
   * and clearing it on unmount stops a note outliving the window it belongs to.
   */
  const flashNewChatNote = useCallback((text: string) => {
    setNewChatNote(text);
    if (newChatNoteTimer.current !== null) clearTimeout(newChatNoteTimer.current);
    newChatNoteTimer.current = setTimeout(() => {
      newChatNoteTimer.current = null;
      setNewChatNote((current) => (current === text ? null : current));
    }, NEW_CHAT_NOTE_MS);
  }, []);

  useEffect(
    () => () => {
      if (newChatNoteTimer.current !== null) clearTimeout(newChatNoteTimer.current);
    },
    [],
  );

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
    // Read through the ref: the composer's own text does not belong in this
    // function's dependencies, and reading state here would re-create the
    // callback on every keystroke for no benefit.
    const openId = conversationRef.current;
    const outcome = await startNewChat({
      api,
      mode,
      nameOf: (which) => MODE_LABELS[which],
      isOpen: (conversationId) => conversationId === openId,
      open: async (conversationId) => {
        await openConversation(conversationId);
      },
    });

    if (outcome.error !== undefined) {
      // Reported against the button that was pressed. `setFatal` here replaced
      // the whole window with "Atomic could not start", destroying a
      // conversation that was on screen and perfectly fine.
      setActionError(outcome.error);
      setNewChatNote(null);
      return;
    }
    setActionError(null);
    if (outcome.draftReset) setDraftKey((key) => key + 1);
    if (outcome.alreadyOnNewChat === true) {
      // The press was honoured and the state is right; there is simply nothing
      // that moved. Say so, rather than leaving the user to guess.
      flashNewChatNote("Already on a new chat.");
    } else {
      setNewChatNote(null);
    }
  }, [api, mode, openConversation, flashNewChatNote]);

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

  // ---- Ctrl/Cmd+N --------------------------------------------------------
  //
  // A document-level listener, not a prop on the composer: the shortcut has to
  // work wherever focus is. Deliberately NOT restricted to "focus is not in a
  // text field" -- that would make Ctrl+N dead precisely where the user spends
  // their time, which is in the composer, and a shortcut that only works when
  // you are not typing is not a shortcut anyone uses.
  //
  // What makes it safe to take from a text field is that `isNewChatChord`
  // requires the modifier. Bare "n" -- the only key anyone is actually typing
  // while composing a message -- never reaches `preventDefault` and is left
  // entirely alone.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isNewChatChord(event)) return;
      // A modifier-only press with no letter alongside it is not this gesture.
      if (event.key.length !== 1) return;
      // Respect a handler that got there first, so this does not fight another
      // library or the platform over the same chord.
      if (event.defaultPrevented) return;
      event.preventDefault();
      void newChat();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newChat]);

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
      on?: { readonly model: string; readonly providerId: string },
    ) => {
      if (!conversation) return;
      try {
        await api.sendMessage({
          conversationId: conversation.id,
          text,
          attachments,
          ...(allowPaidModel ? { allowPaidModel: true } : {}),
          // A named model and provider together, because a model id alone would
          // be re-resolved against the catalog and could land back on the
          // account that just failed.
          ...(on ? { model: on.model, providerId: on.providerId } : {}),
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
                /*
                 * The write can fail, and now that the store rolls back it is
                 * honest about having changed nothing -- so the error has to be
                 * shown. It used to be an unhandled rejection: the picker kept
                 * the new name because nothing re-rendered, the next message
                 * went to the old model, and the failure was invisible.
                 */
                setActionError(null);
                api
                  .setModelForMode(mode, id, providerId)
                  .then((next) => setSettings(next))
                  .catch((error: unknown) => {
                    setActionError(
                      `Could not save that model choice: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  });
              }}
            />
            {modelCatalog.usingAuto ? <AutoModelNote state={modelCatalog} /> : null}
            {/*
              The spending policy lives beside the model picker, because that is
              the choice it qualifies. It used to be a component that nothing
              rendered, so the promise this app makes about money had no control
              anywhere in the window.
            */}
            <OnlyFreeToggle state={modelCatalog} />
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
          notices={[run.modelSwitched, run.note].filter(
            (line): line is string => Boolean(line),
          )}
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
          {actionError ? (
            <p
              role="alert"
              className="border-border text-danger bg-danger/5 rounded-md border px-3 py-2 text-sm"
            >
              {actionError}
            </p>
          ) : null}
          {newChatNote ? (
            // `status` and not `alert`: nothing is wrong, and a screen reader
            // announcing this as an alert would be telling the user an emergency
            // where there was a deliberate no-op. `role="status"` is polite, so
            // it does not interrupt a message being read out either.
            <p
              role="status"
              className="border-border text-content-muted bg-surface-raised rounded-md border px-3 py-2 text-sm"
            >
              {newChatNote}
            </p>
          ) : null}
          {policyNotice ? (
            <p
              role="status"
              className="text-muted-foreground border-border bg-muted/40 rounded-md border px-3 py-2 text-sm"
            >
              {policyNotice}
            </p>
          ) : null}
          {/*
            Gated on the run alone. It used to require a ref holding the text
            the run had been sent, and that ref was cleared on every send: a
            second send before the offer was answered left the offer
            unrenderable, so the choice quietly disappeared and the run was
            stuck.
          */}
          {run.providerOffer ? (
            <ProviderOffer
              model={run.providerOffer.model}
              providerLabel={run.providerOffer.providerLabel}
              reason={run.providerOffer.reason}
              busy={run.isBusy}
              /*
               * Not `send`. The question behind this offer is already in the
               * transcript -- it was written down before the run that failed --
               * so re-sending the text appended it a second time. This re-runs
               * the turn that is already there, on the provider just agreed to.
               */
              onAccept={() => {
                if (!conversation) return;
                setActionError(null);
                api
                  .retryOnProvider({
                    conversationId: conversation.id,
                    model: run.providerOffer!.model,
                    providerId: run.providerOffer!.providerId,
                  })
                  .catch((error: unknown) => {
                    setActionError(
                      `Could not retry on ${run.providerOffer!.providerLabel}: ${
                        error instanceof Error ? error.message : String(error)
                      }`,
                    );
                  });
              }}
              onDecline={() => {
                // The run is over either way; the model list is where the choice
                // can actually be made.
                setOverlay("settings");
              }}
            />
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
          key={draftKey}
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
