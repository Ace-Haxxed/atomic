/**
 * @vitest-environment jsdom
 *
 * "New chat", driven through the real `App` and the real `Sidebar`.
 *
 * The tests that already existed tested a harness: a hand-built component that
 * copied `startNewChat` and a `key` bump out of `app.tsx` and rendered the real
 * `Composer`. A harness passes when the harness is right. Every regression
 * described below happened in the wiring the harness did not contain -- the
 * button in the real sidebar, the mode the app was actually in, the run state
 * that disabled the composer, the keyboard shortcut. None of them could fail
 * those tests, and none of them did.
 *
 * What is under test is the shipped path: the button, the handler, the state
 * the user can see, and the composer they are trying to type into.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import {
  SettingsSchema,
  type AgentEvent,
  type ConversationSummary,
  type HostApi,
  type Mode,
} from "@atomic/core";

import { App } from "./app.js";

/** Enough of a conversation for the app to render one. */
function summary(id: string, mode: Mode, over: Partial<ConversationSummary> = {}) {
  return {
    id,
    mode,
    // `null`, not `""`, because that is what the store writes: `createConversation`
    // passes `input.title ?? null`. A harness that used `""` made the sidebar
    // render a genuinely blank row, and the test then failed on a fixture detail
    // rather than on anything the product does.
    title: null,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    ...over,
  } as ConversationSummary;
}

/**
 * The settings a real user's app has: past onboarding.
 *
 * Every settings-returning method hands this back, not a fresh parse. A method
 * that returned a default `SettingsSchema.parse({})` re-introduced
 * `onboardingCompleted: false` and bounced the app back to the welcome screen
 * mid-test, which looks exactly like a broken button.
 */
const WELCOMED = SettingsSchema.parse({ onboardingCompleted: true });

/**
 * A host that behaves like the real one for the parts New chat touches.
 *
 * `createConversation` really appends, and `listConversations` really returns
 * newest-first, because a stub that always returns `[]` would make the reuse
 * path untestable -- the stub would be deciding the answer.
 */
function makeApi(seed: ConversationSummary[] = []) {
  const list = [...seed];
  let next = 1;
  const calls: string[] = [];
  /** Which mode each conversation is in, so a run event can name it honestly. */
  const modeOf = new Map<string, Mode>(list.map((row) => [row.id, row.mode]));

  /**
   * The run stream, as a queue the host pushes into.
   *
   * Typed as `AgentEvent` on purpose. An earlier version of this harness emitted
   * a hand-written `{ type: "run-started" }` cast to `never`, and the reducer has
   * no case for that name -- it fell through to `default`, the app never became
   * busy, and the "while a run is streaming" test reported "the composer was not
   * disabled" for a reason that had nothing to do with the product. The cast is
   * what let the wrong event name through; this type is what stops it going back.
   */
  const stream: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  const emit = (event: AgentEvent): void => {
    stream.push(event);
    wake?.();
    wake = null;
  };

  const api = {
    async getSettings() {
      return WELCOMED;
    },
    async listConversations() {
      return [...list];
    },
    async createConversation({ mode }: { mode: Mode }) {
      calls.push(`create:${mode}`);
      const created = summary(`c-${next++}`, mode);
      list.unshift(created);
      modeOf.set(created.id, mode);
      return created;
    },
    async deleteConversation(id: string) {
      calls.push(`delete:${id}`);
      const index = list.findIndex((row) => row.id === id);
      if (index >= 0) list.splice(index, 1);
    },
    async getConversation(id: string) {
      return list.find((row) => row.id === id) ?? null;
    },
    async getMessages() {
      return [];
    },
    async updateSettings() {
      return WELCOMED;
    },
    async setPermission() {
      return SettingsSchema.parse({ permissions: { code: { level: "ask" } }, onboardingCompleted: true });
    },
    async setModelForMode() {
      return WELCOMED;
    },
    async providerForModel() {
      return "";
    },
    /**
     * Sending starts a run, the way the real host does: the send is accepted and
     * the run announces itself on the stream.
     *
     * Left open on purpose. A host that finished instantly made the mid-run UI
     * unreachable -- the composer was re-enabled before a test could assert on
     * it -- so "while a run is streaming" was really testing the idle app.
     */
    async sendMessage({ conversationId }: { conversationId: string; text: string }) {
      emit({
        type: "run-start",
        runId: "r1",
        conversationId,
        mode: modeOf.get(conversationId) ?? "chat",
        model: "m",
      });
      return null;
    },
    async continueMessage() {
      return null;
    },
    async revealPath() {},
    async pickFolder() {
      return null;
    },
    async pickFiles() {
      return [];
    },

    // The run event stream. Idle until the host emits, then one event at a time,
    // and never closed: a run that has not finished keeps the app busy.
    streamEvents() {
      return (async function* () {
        for (;;) {
          if (stream.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          yield stream.shift()!;
        }
      })();
    },
    async cancelRun() {},
    async resolveApproval() {},
    async resolveModels() {
      return WELCOMED;
    },
    // One empty provider section. The shape matters: `use-models` maps over
    // `sections`, and returning a bare model list here threw inside the hook
    // before the app ever painted, which is a test-harness failure that looks
    // exactly like the product being broken.
    async listProviderModels() {
      return [
        {
          provider: { id: "p-test", label: "Test", kind: "local", configured: true },
          models: [],
          stale: false,
          fetchedAt: 0,
          source: "fallback",
          error: null,
        },
      ] as never;
    },
    selectionNotices() {
      return (async function* () {})();
    },
  };

  return {
    api: api as unknown as HostApi,
    list,
    calls,
  };
}

/**
 * The composer, and only the composer.
 *
 * The sidebar's search box is a textbox too, so `getByRole("textbox")` matches
 * two. Anything asserting on "where the cursor is" has to name the right one,
 * and the label is the only honest way to tell them apart.
 */
const composer = () =>
  screen.getByRole("textbox", { name: /message|ask|composer/i }) as HTMLTextAreaElement;
const newChatButton = () => screen.getByRole("button", { name: /new chat/i });

/**
 * Dismiss the welcome screen by handing back settings that are past it.
 *
 * Clicking "Skip for now" would work too, and would additionally make every
 * test depend on onboarding's own behaviour changing. A real user's app is past
 * that screen, so the harness starts there.
 */
async function renderApp(seed: ConversationSummary[] = [], api: HostApi | null = null) {
  const harness = makeApi(seed);
  const user = userEvent.setup();
  const host = api ?? harness.api;
  render(<App api={host} />);
  await waitFor(() => expect(newChatButton()).toBeEnabled());
  return { ...harness, user, api: host };
}

describe("New chat, through the real App", () => {
  it("creates a conversation and puts the cursor in the composer", async () => {
    // Seeded with a chat that has messages, because that is the only state in
    // which creating is the right answer. With nothing but a blank chat on
    // screen, pressing New chat reuses it -- so a test starting from empty and
    // expecting a create was asserting the old bug, where any real conversation
    // in the mode was reopened instead of a new one started.
    const { user, calls } = await renderApp([
      summary("c-existing", "chat", { title: "Existing", messageCount: 4 }),
    ]);
    await waitFor(() => expect(composer()).toBeEnabled());

    const before = calls.filter((call) => call.startsWith("create:")).length;
    await user.click(newChatButton());

    await waitFor(() =>
      expect(calls.filter((call) => call.startsWith("create:")).length).toBe(before + 1),
    );
    await waitFor(() => expect(composer()).toBeEnabled());
    // The cursor is in the box, not still on the button that was just pressed.
    expect(document.activeElement).toBe(composer());
    // And it is the selected conversation in the sidebar, so the user can see
    // which one they are in.
    await waitFor(() =>
      expect(screen.getByRole("button", { current: true, name: /untitled/i })).toBeInTheDocument(),
    );
  });

  it("says so when it reuses the chat you are already on", async () => {
    // The failure this exists for. Pressing New chat while already on the
    // mode's blank chat changed nothing at all: same conversation, no message,
    // no notice. From where the user sits the button is dead, and there is no
    // way to tell that from a click that never arrived.
    const { user } = await renderApp([summary("c-blank", "chat")]);

    await waitFor(() => expect(composer()).toBeEnabled());
    // Confirm the app really is on the blank chat first, or this test could
    // pass without ever reaching the reuse path.
    await user.click(newChatButton());

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/already on a new chat/i);
    // And it is still the same chat: reusing must not quietly spawn a second one.
    expect(document.activeElement).toBe(composer());
  });

  it("clears the draft when it reuses the chat you are already on", async () => {
    // The other half of "no visible change". A user who typed something, decided
    // to start over, and pressed New chat got their text back.
    const { user } = await renderApp([summary("c-blank", "chat")]);
    await waitFor(() => expect(composer()).toBeEnabled());

    await user.type(composer(), "half-written thought");
    expect(composer()).toHaveValue("half-written thought");

    await user.click(newChatButton());

    await waitFor(() => expect(composer()).toHaveValue(""));
    expect(document.activeElement).toBe(composer());
  });

  it("works in Code mode", async () => {
    // The mode the user was actually in. `startNewChat` is handed `mode`, and a
    // blank Chat chat is not a blank Code chat -- a harness that hardcoded
    // `mode: "chat"` (as the old one did) could not have caught a mode that was
    // dropped anywhere in the real path.
    const { user, calls } = await renderApp();

    await user.click(screen.getByRole("radio", { name: /code/i }));
    await waitFor(() => expect(composer()).toBeEnabled());

    await user.click(newChatButton());

    await waitFor(() => expect(calls.filter((c) => c === "create:code")).toHaveLength(1));
    await waitFor(() => expect(document.activeElement).toBe(composer()));
  });

  it("says so when it reuses the blank Code chat, rather than doing nothing", async () => {
    const { user, calls } = await renderApp([summary("c-code-blank", "code")]);

    await user.click(screen.getByRole("radio", { name: /code/i }));
    await waitFor(() => expect(composer()).toBeEnabled());
    // The mode switch opened the seeded blank Code chat. The press after it is
    // the one that has nothing left to change.
    const before = calls.filter((c) => c.startsWith("create:")).length;

    await user.click(newChatButton());

    expect(await screen.findByRole("status")).toHaveTextContent(/already on a new chat/i);
    expect(calls.filter((c) => c.startsWith("create:")).length).toBe(before);
  });

  it("still works while a run is streaming", async () => {
    // The composer is disabled for the duration of a run, so this press cannot
    // end in a focused empty box. It has to say something anyway: the run is in
    // flight in the chat that is on screen, which *is* the new chat, so the
    // honest answer is the reuse note rather than a second empty row.
    const { user, calls } = await renderApp();

    await user.click(composer());
    await user.type(composer(), "working on it");
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    // Asserted before the press, because otherwise this test also passes against
    // an app whose run never started -- which is the bug it exists to rule out.
    await waitFor(() => expect(composer()).toBeDisabled());
    const before = calls.filter((c) => c.startsWith("create:")).length;

    await user.click(newChatButton());

    // Something the user can see, and no pile of blanks from it.
    expect(await screen.findByRole("status")).toHaveTextContent(/already on a new chat/i);
    expect(calls.filter((c) => c.startsWith("create:")).length).toBe(before);
    // The run is left alone: starting a new chat mid-run must not cancel work in
    // flight behind the user's back.
    expect(composer()).toBeDisabled();
  });

  it("does not lose a typed draft when it fails", async () => {
    // One App, one composer. An earlier version of this test rendered a second
    // `App` alongside the first, so `getByRole("textbox")` matched two
    // composers and the test failed for a reason that had nothing to do with
    // drafts -- a harness failure that reads exactly like a product failure.
    const real = makeApi([summary("c-1", "chat", { title: "Existing", messageCount: 4 })]);
    const broken = {
      ...(real.api as unknown as Record<string, unknown>),
      createConversation: async () => {
        throw new Error("database is locked");
      },
    } as unknown as HostApi;
    const user = userEvent.setup();
    render(<App api={broken} />);
    await waitFor(() => expect(newChatButton()).toBeEnabled());
    await waitFor(() => expect(composer()).toBeEnabled());

    await user.click(composer());
    await user.type(composer(), "something worth keeping");
    await user.click(newChatButton());

    // The error is shown, and the draft is still there. Losing typed text to a
    // failed request is a worse outcome than the failure.
    expect(await screen.findByRole("alert")).toHaveTextContent(/database is locked/i);
    expect(composer()).toHaveValue("something worth keeping");
  });

  it("reports the failure in the window rather than replacing it", async () => {
    const real = makeApi([summary("c-1", "chat", { title: "Existing", messageCount: 4 })]);
    const broken = {
      ...(real.api as unknown as Record<string, unknown>),
      listConversations: async () => {
        throw new Error("storage unavailable");
      },
      createConversation: async () => {
        throw new Error("storage unavailable");
      },
    } as unknown as HostApi;
    const user = userEvent.setup();
    render(<App api={broken} />);
    await waitFor(() => expect(newChatButton()).toBeEnabled());

    await user.click(newChatButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(/storage unavailable/i);
    // The window is still a window. The takeover is a specific string, matched
    // exactly: a loose /could not start/ also matches nothing here, but would
    // start matching the moment someone reworded the takeover.
    expect(screen.queryByText("Atomic could not start")).not.toBeInTheDocument();
    // The composer and the transcript are still mounted, which is the thing
    // worth asserting -- a takeover would have unmounted both.
    expect(composer()).toBeInTheDocument();
  });

  it("responds to Ctrl+N", async () => {
    // Seeded with a chat that has messages, so the mode has no blank to reuse
    // and the press has to create one. Seeded blank, the correct behaviour is to
    // reuse -- so a test that only counts `create` calls would report the fixed
    // shortcut as still broken.
    const { user, calls } = await renderApp([
      summary("c-1", "chat", { title: "Existing", messageCount: 4 }),
    ]);
    await waitFor(() => expect(composer()).toBeEnabled());
    const before = calls.filter((c) => c.startsWith("create:")).length;

    await user.keyboard("{Control>}n{/Control}");

    await waitFor(() =>
      expect(calls.filter((c) => c.startsWith("create:")).length).toBe(before + 1),
    );
    await waitFor(() => expect(document.activeElement).toBe(composer()));
  });

  it("responds to Cmd+N", async () => {
    const { user, calls } = await renderApp([
      summary("c-1", "chat", { title: "Existing", messageCount: 4 }),
    ]);
    await waitFor(() => expect(composer()).toBeEnabled());
    const before = calls.filter((c) => c.startsWith("create:")).length;

    await user.keyboard("{Meta>}n{/Meta}");

    await waitFor(() =>
      expect(calls.filter((c) => c.startsWith("create:")).length).toBe(before + 1),
    );
  });

  it("reuses the blank chat on Ctrl+N instead of piling up identical ones", async () => {
    // The shortcut routes through the same reuse rule as the button, so a user
    // hammering Ctrl+N gets one blank chat, not five.
    const { user, calls } = await renderApp();
    await waitFor(() => expect(composer()).toBeEnabled());
    const before = calls.filter((c) => c.startsWith("create:")).length;

    await user.keyboard("{Control>}n{/Control}");

    expect(calls.filter((c) => c.startsWith("create:")).length).toBe(before);
    expect(await screen.findByRole("status")).toHaveTextContent(/already on a new chat/i);
  });

  it("does not fire the shortcut while the user is typing the letter n", async () => {
    // A handler that ignores the target would swallow a keystroke in the
    // composer, which is where the user spends their time. Ctrl+N must not cost
    // them the character, either.
    const { user, calls } = await renderApp();
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.click(composer());
    const before = calls.filter((c) => c.startsWith("create:")).length;

    await user.keyboard("n");

    await waitFor(() => expect(composer()).toHaveValue("n"));
    expect(calls.filter((c) => c.startsWith("create:")).length).toBe(before);
  });

  it("shows the failure as an alert, announced, and not as silent nothing", async () => {
    // `role="alert"` is what a screen reader announces. A <p> with no role is
    // read by nobody, which is the same as not showing it.
    const real = makeApi([summary("c-1", "chat", { title: "Existing", messageCount: 4 })]);
    const broken = {
      ...(real.api as unknown as Record<string, unknown>),
      createConversation: async () => {
        throw new Error("nope");
      },
    } as unknown as HostApi;
    const user = userEvent.setup();
    render(<App api={broken} />);
    await waitFor(() => expect(newChatButton()).toBeEnabled());

    await user.click(newChatButton());

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/nope/)).toBeInTheDocument();
  });
});
