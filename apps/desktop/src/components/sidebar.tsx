/**
 * Conversation list, search, and the mode switcher.
 *
 * The mode switcher is the most consequential control in the app: it decides
 * which permission set a run will use, so it sits at the top with the permission
 * level spelled out next to it rather than buried in settings.
 */

import { useEffect, useState } from "react";
import type { ConversationSummary, HostApi, Mode, PermissionLevel } from "@atomic/core";
import { MODES, hasTools, isModeShipped } from "@atomic/core";

/**
 * Modes that exist in the product but cannot be selected yet.
 *
 * Code is deliberately absent: it has the full toolset, path scoping and the
 * permission gate behind it, so it is live. Cowork stays gated because its
 * multi-step task runner is not built, and shipping a second half-working tool
 * mode would teach people to distrust the gate.
 */

import { Badge, Button, Input, Separator, cn } from "@atomic/ui";

const MODE_LABELS: Readonly<Record<Mode, string>> = {
  chat: "Chat",
  cowork: "Cowork",
  code: "Code",
};

/**
 * The subtitle states the permission that is actually in force, not a marketing
 * sentence about the mode. A hardcoded "Asks before anything changes" was
 * displayed next to a bypass badge, so the two lines contradicted each other and
 * the reassuring one was the one that was wrong.
 */
/** What the mode is for. The permission line sits directly under this. */
const MODE_HINTS: Readonly<Record<Mode, string>> = {
  chat: "Answer questions",
  cowork: "Work on a task in a folder",
  code: "Read and edit a repository",
};

/** Spells out the level in force, so the badge is never the only source. */
const LEVEL_TEXT: Readonly<Record<PermissionLevel, string>> = {
  ask: "Asks before any change",
  "auto-accept": "Runs read-only tools without asking",
  plan: "Plans first, runs with your approval",
  bypass: "Runs everything without asking",
};

const LEVEL_TONE: Readonly<Record<PermissionLevel, "neutral" | "info" | "warning" | "danger">> = {
  ask: "neutral",
  "auto-accept": "info",
  plan: "warning",
  bypass: "danger",
};

export interface SidebarProps {
  readonly api: HostApi;
  readonly mode: Mode;
  readonly level: PermissionLevel;
  readonly activeId: string | null;
  readonly collapsed: boolean;
  readonly onModeChange: (mode: Mode) => void;
  readonly onSelect: (id: string) => void;
  readonly onNewChat: () => void;
  readonly onOpenSettings: () => void;
  readonly onCollapse: () => void;
  readonly onExpand: () => void;
}

export function Sidebar(props: SidebarProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reload whenever the mode changes: the list is filtered by mode, and a run
  // that finished in the background may have added a title.
  useEffect(() => {
    let cancelled = false;
    const query = search.trim();
    loadConversations(props.api, props.mode, query)
      .then((list) => {
        if (!cancelled) setConversations(list);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.api, props.mode, search, props.activeId]);

  if (props.collapsed) {
    return (
      <div className="flex w-12 shrink-0 flex-col items-center gap-2 border-r border-border-base bg-surface-sunken py-2">
        <Button variant="ghost" size="icon" onClick={props.onExpand} title="Expand sidebar">
          <Icon name="panel" />
        </Button>
        <Separator className="w-6" />
        {MODES.map((mode) => (
          <Button
            key={mode}
            variant={mode === props.mode ? "secondary" : "ghost"}
            size="icon"
            title={MODE_LABELS[mode]}
            onClick={() => props.onModeChange(mode)}
          >
            <ModeGlyph mode={mode} />
          </Button>
        ))}
        <div className="mt-auto">
          <Button variant="ghost" size="icon" onClick={props.onOpenSettings} title="Settings">
            <Icon name="gear" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border-base bg-surface-sunken">
      <header className="flex items-center gap-1.5 px-2 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-content">Atomic</p>
          <p className="truncate text-[11px] text-content-muted">{MODE_HINTS[props.mode]}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={props.onCollapse} title="Collapse sidebar">
          <Icon name="panel" />
        </Button>
      </header>

      <div className="px-2 pb-2">
        <ModeSwitcher mode={props.mode} level={props.level} onChange={props.onModeChange} />
      </div>

      <div className="px-2 pb-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
          className="h-7 text-xs"
        />
      </div>

      <div className="px-2 pb-2">
        <Button variant="primary" size="sm" block onClick={props.onNewChat}>
          <Icon name="plus" />
          New chat
        </Button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {error ? (
          <p className="px-2 py-1 text-[11px] text-danger">{error}</p>
        ) : null}
        {conversations.length === 0 && !error ? (
          <p className="px-2 py-1 text-[11px] text-content-muted">
            {search ? "No chats match." : "No chats yet."}
          </p>
        ) : null}
        <ul className="space-y-0.5">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                onClick={() => props.onSelect(conversation.id)}
                aria-current={conversation.id === props.activeId}
                className={cn(
                  "w-full rounded-md px-2 py-1.5 text-left transition-colors",
                  conversation.id === props.activeId
                    ? "bg-surface-raised text-content"
                    : "text-content-muted hover:bg-surface-raised/60 hover:text-content",
                )}
              >
                <span className="flex items-center gap-1.5">
                  {conversation.pinned ? <Icon name="pin" className="size-3" /> : null}
                  <span className="truncate text-xs font-medium">
                    {conversation.title ?? "Untitled"}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-content-muted">
                  {conversation.lastPreview ?? "No messages yet"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <footer className="border-t border-border-base px-2 py-2">
        <Button variant="ghost" size="sm" block onClick={props.onOpenSettings}>
          <Icon name="gear" />
          Settings
        </Button>
      </footer>
    </aside>
  );
}

function ModeSwitcher({
  mode,
  level,
  onChange,
}: {
  mode: Mode;
  level: PermissionLevel;
  onChange: (mode: Mode) => void;
}) {
  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Mode"
        className="grid grid-cols-3 gap-0.5 rounded-md border border-border-base bg-surface p-0.5"
      >
        {MODES.map((candidate) => {
          // Gated modes are announced as unavailable rather than hidden, so the
          // shape of the product is visible without implying they work.
          const soon = !isModeShipped(candidate);
          return (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={candidate === mode}
              aria-disabled={soon || undefined}
              disabled={soon}
              title={soon ? `${MODE_LABELS[candidate]} is coming soon` : undefined}
              onClick={() => onChange(candidate)}
              className={cn(
                "flex h-6 items-center justify-center gap-1 rounded text-[11px] font-medium transition-colors",
                candidate === mode
                  ? "bg-accent text-accent-foreground"
                  : "text-content-muted hover:text-content",
                soon && "cursor-not-allowed opacity-50 hover:text-content-muted",
              )}
            >
              <ModeGlyph mode={candidate} />
              {MODE_LABELS[candidate]}
              {soon ? <span className="text-[9px] uppercase tracking-wide">soon</span> : null}
            </button>
          );
        })}
      </div>
      {/*
        Permission is only shown where it means something. Chat has no tools, so
        a "bypass" badge there would be a warning about a risk that cannot occur
        -- but "ask" still applies to it, so the level is not hidden outright.
      */}
      {hasTools(mode) || level !== "bypass" ? (
        <div className="mt-1.5 flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <Badge tone={LEVEL_TONE[level]}>{level}</Badge>
            {level === "bypass" ? (
              <span className="text-[10px] font-medium text-danger">nothing asks</span>
            ) : null}
          </div>
          <p className="text-[10px] leading-[1.35] text-content-muted">{LEVEL_TEXT[level]}</p>
        </div>
      ) : null}
    </div>
  );
}

function ModeGlyph({ mode }: { mode: Mode }) {
  const name = mode === "chat" ? "chat" : mode === "code" ? "code" : "cowork";
  return <Icon name={name} />;
}

/** One place that decides what "no search" means for the repository. */
async function loadConversations(
  api: HostApi,
  mode: Mode,
  search: string,
): Promise<ConversationSummary[]> {
  return api.listConversations(search ? { mode, search } : { mode });
}

/** Inline SVG instead of an icon dependency: three glyphs, no bundle cost. */
export function Icon({ name, className }: { name: string; className?: string }) {
  const common = {
    className: cn("size-4", className),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "gear":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
        </svg>
      );
    case "panel":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      );
    case "chat":
      return (
        <svg {...common}>
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12Z" />
        </svg>
      );
    case "cowork":
      return (
        <svg {...common}>
          <rect x="3" y="7" width="18" height="13" rx="2" />
          <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" />
        </svg>
      );
    case "code":
      return (
        <svg {...common}>
          <path d="m9 8-5 4 5 4M15 8l5 4-5 4" />
        </svg>
      );
    case "pin":
      return (
        <svg {...common}>
          <path d="M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6ZM12 14v7" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="M4 12 20 4l-4 16-4-6-8-2Z" />
        </svg>
      );
    case "stop":
      return (
        <svg {...common}>
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      );
    case "attach":
      return (
        <svg {...common}>
          <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="m4 12 5 5L20 6" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      );
    case "alert":
      return (
        <svg {...common}>
          <path d="M12 4 2.5 20h19L12 4Z" />
          <path d="M12 10v4M12 17.5v.5" />
        </svg>
      );
    default:
      return null;
  }
}
