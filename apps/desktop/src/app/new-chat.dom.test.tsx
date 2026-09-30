/**
 * @vitest-environment jsdom
 *
 * "New chat" has to do two things at once, and only one of them was testable.
 * That it ends up with a conversation was checked at the function level; that the
 * user can *type into it* was not checked anywhere, and it is the part that
 * fails in ways nobody notices -- focus stays on the button that was just
 * pressed, or the previous draft is still sitting in the box.
 *
 * The harness below mirrors `app.tsx`: `startNewChat` for the sequencing, the
 * `key` bump for the draft reset, and the real `Composer`. It is not the whole
 * app, because the whole app needs a Tauri host, and a test that has to stub all
 * of it to observe a textarea is testing the stub. What is under test is the
 * wiring between the two, which is the part that was wrong.
 */

import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Button } from "@atomic/ui";
import type { ConversationSummary, HostApi, Mode } from "@atomic/core";

import { startNewChat } from "./new-chat.js";
import { Composer } from "../components/composer.js";

/** The slice of the host this wiring touches. */
function fakeApi(conversations: ConversationSummary[]) {
  const list = [...conversations];
  const opened: string[] = [];
  let nextId = 1;
  const api = {
    async listConversations() {
      return [...list];
    },
    async createConversation({ mode }: { mode: Mode }) {
      const created: ConversationSummary = {
        id: `c-new-${nextId++}`,
        mode,
        title: "",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
      } as ConversationSummary;
      list.push(created);
      return created;
    },
    async deleteConversation(id: string) {
      const index = list.findIndex((row) => row.id === id);
      if (index >= 0) list.splice(index, 1);
    },
  };
  return {
    api: api as unknown as Pick<
      HostApi,
      "listConversations" | "createConversation" | "deleteConversation"
    >,
    opened,
    list,
  };
}

function emptyChat(id: string, mode: Mode = "chat"): ConversationSummary {
  return { id, mode, title: "", createdAt: 1, updatedAt: 1, messageCount: 0 } as ConversationSummary;
}

/** Newest first, which is the order `listConversations` returns. */
function newestFirst(...rows: ConversationSummary[]): ConversationSummary[] {
  return rows;
}

function Harness({
  api,
  initialConversationId,
  onOpen,
}: {
  readonly api: Parameters<typeof startNewChat>[0]["api"];
  readonly initialConversationId: string | null;
  /** Records which conversation was opened, and in what order. */
  readonly onOpen?: (id: string) => void;
}) {
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  // The same state `app.tsx` keeps, and for the same reason: remounting the
  // composer is what discards the old draft.
  const [draftKey, setDraftKey] = useState(0);

  return (
    <div>
      <Button
        onClick={() => {
          void startNewChat({
            api,
            mode: "chat",
            nameOf: () => "chat",
            open: async (id) => {
              onOpen?.(id);
              setConversationId(id);
            },
          }).then((outcome) => {
            if (outcome.draftReset) setDraftKey((key) => key + 1);
          });
        }}
      >
        New chat
      </Button>
      <p data-testid="open">{conversationId ?? "none"}</p>
      <Composer
        key={draftKey}
        disabled={conversationId === null}
        sendKey="enter"
        workspace={null}
        mode="chat"
        onSend={() => {}}
        onStop={() => {}}
        onAttach={async () => []}
        onPickFolder={async () => null}
        onCommand={async () => null}
      />
    </div>
  );
}

const composer = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("New chat", () => {
  it("opens a new conversation and focuses the composer when there is none to reuse", async () => {
    const { api, opened } = fakeApi([]);
    const user = userEvent.setup();
    render(<Harness api={api} initialConversationId={null} onOpen={(id) => opened.push(id)} />);

    // With no conversation open the composer is disabled, so there is nothing to
    // type into yet -- the state the app boots into.
    expect(composer()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(screen.getByTestId("open")).toHaveTextContent("c-new-1"));
    expect(opened).toEqual(["c-new-1"]);
    await waitFor(() => expect(composer()).toBeEnabled());
    expect(document.activeElement).toBe(composer());
  });

  it("reuses an existing empty chat, still focusing the composer", async () => {
    // The common path, and the one that regressed: the draft was only ever reset
    // on the branch that created a conversation.
    const { api, opened } = fakeApi([emptyChat("c-empty")]);
    const user = userEvent.setup();
    render(
      <Harness api={api} initialConversationId="c-existing" onOpen={(id) => opened.push(id)} />,
    );

    await user.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(screen.getByTestId("open")).toHaveTextContent("c-empty"));
    expect(opened).toEqual(["c-empty"]);
    expect(document.activeElement).toBe(composer());
  });

  it("empties the composer when a new chat is pressed", async () => {
    const { api } = fakeApi([]);
    const user = userEvent.setup();
    render(<Harness api={api} initialConversationId="c-1" />);

    await user.type(composer(), "half-written thought");
    expect(composer()).toHaveValue("half-written thought");

    await user.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(screen.getByTestId("open")).toHaveTextContent("c-new-1"));
    await waitFor(() => expect(composer()).toHaveValue(""));
    // And the cursor is in the new, empty box rather than on the button.
    expect(document.activeElement).toBe(composer());
  });

  it("clears a draft typed into a reused empty chat", async () => {
    // The narrower bug, on the reuse path: an empty conversation that somehow has
    // text in the composer is a stale draft, not something to keep.
    const { api } = fakeApi([emptyChat("c-empty")]);
    const user = userEvent.setup();
    render(<Harness api={api} initialConversationId="c-empty" />);

    await user.type(composer(), "stale draft");
    await user.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(composer()).toHaveValue(""));
  });

  it("prunes a leftover empty chat and reuses the newest one", async () => {
    const { api, list } = fakeApi(newestFirst(emptyChat("c-newest"), emptyChat("c-old")));
    const user = userEvent.setup();
    render(<Harness api={api} initialConversationId="c-old" />);

    await user.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(screen.getByTestId("open")).toHaveTextContent("c-newest"));
    // The stale duplicate is cleaned up rather than left to accumulate.
    expect(list.map((row) => row.id)).not.toContain("c-old");
  });

  it("leaves the open conversation alone when creating one fails", async () => {
    const user = userEvent.setup();
    const broken = {
      listConversations: async () => [],
      createConversation: async () => {
        throw new Error("disk is full");
      },
      deleteConversation: async () => {},
    } as unknown as Parameters<typeof startNewChat>[0]["api"];
    render(<Harness api={broken} initialConversationId="c-existing" />);

    await user.type(composer(), "something worth keeping");
    await user.click(screen.getByRole("button", { name: "New chat" }));

    // No reset, no remount, no lost text: a failed press must not cost the user
    // what they had typed.
    await waitFor(() => expect(composer()).toHaveValue("something worth keeping"));
    expect(screen.getByTestId("open")).toHaveTextContent("c-existing");
  });

  it("focuses the composer on mount when a conversation is already open", async () => {
    // The baseline the two cases above depend on: if this were false, "focuses
    // the composer" would be measuring nothing.
    const { api } = fakeApi([]);
    render(<Harness api={api} initialConversationId="c-1" />);
    expect(document.activeElement).toBe(composer());
  });
});
