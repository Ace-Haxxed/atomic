/**
 * A failed send.
 *
 * The text is the user's own work, so losing it is the actual harm here. These
 * tests are static markup, but they pin the two things that matter: the message
 * is still on screen, and there is a way to resend it without retyping.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageList, type FailedMessage } from "./message-list.js";

function list(failed: FailedMessage | null): string {
  return renderToStaticMarkup(
    <MessageList
      messages={[]}
      liveText=""
      liveReasoning=""
      tools={[]}
      streaming={false}
      pendingApproval={false}
      error={null}
      usage={{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }}
      failedMessage={failed}
    />,
  );
}

const FAILED: FailedMessage = {
  text: "please rename the file to final.txt",
  attachmentNames: [],
  error: "Network request failed",
  pending: false,
  onRetry: () => {},
  onDiscard: () => {},
};

describe("a message that failed to send", () => {
  it("keeps the text on screen", () => {
    // The harm: the composer is already cleared, so if the text is not rendered
    // here the user has only their memory of what they typed.
    expect(list(FAILED)).toContain("please rename the file to final.txt");
  });

  it("shows the reason", () => {
    expect(list(FAILED)).toContain("Network request failed");
  });

  it("offers Retry", () => {
    expect(list(FAILED)).toContain("Retry");
  });

  it("offers Discard, so a stuck message is not permanent", () => {
    expect(list(FAILED)).toContain("Discard");
  });

  it("names the attachments that would be resent", () => {
    const markup = list({ ...FAILED, attachmentNames: ["diagram.png"] });
    expect(markup).toContain("diagram.png");
  });

  it("withholds Retry while a retry is in flight", () => {
    // A second click while the first is still trying sends the message twice.
    const markup = list({ ...FAILED, pending: true });
    expect(markup).toContain("Sending…");
    expect(markup).not.toContain("Retry");
  });

  it("renders nothing extra when the send succeeded", () => {
    expect(list(null)).not.toContain("Retry");
  });
});

describe("a model that stopped at its output limit", () => {
  const truncated = renderToStaticMarkup(
    <MessageList
      messages={[]}
      liveText=""
      liveReasoning=""
      tools={[]}
      streaming={false}
      pendingApproval={false}
      error={null}
      usage={{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }}
      truncated
      onContinue={() => {}}
    />,
  );

  it("says the answer may be incomplete", () => {
    // A reply that stops mid-sentence with no explanation reads as a finished
    // answer.
    expect(truncated).toContain("output limit");
  });

  it("offers Continue", () => {
    expect(truncated).toContain("Continue");
  });
});

describe("a provider change mid-run", () => {
  it("is stated in the transcript", () => {
    const markup = renderToStaticMarkup(
      <MessageList
        messages={[]}
        liveText=""
        liveReasoning=""
        tools={[]}
        streaming={false}
        pendingApproval={false}
        error={null}
        usage={{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }}
        notice="Switched to local-qwen on Ollama because it hit a rate limit."
      />,
    );
    expect(markup).toContain("Switched to local-qwen on Ollama");
  });
});

describe("the live reply", () => {
  /**
   * Markdown parsed over text that is still arriving shows every incomplete
   * construct literally for a moment -- `**bol` as raw asterisks, an unclosed
   * fence opening and closing a code block -- so the reply appears to contain
   * half-written syntax and fragments that were never in the output.
   */
  it("is rendered as plain text, not parsed as markdown", () => {
    const markup = renderToStaticMarkup(
      <MessageList
        messages={[]}
        liveText={'unclosed **bold and a [link](http://x'}
        liveReasoning=""
        tools={[]}
        streaming
        pendingApproval={false}
        error={null}
        usage={{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }}
      />,
    );
    // Plain text: the literal asterisks survive, and no element was built from
    // the half-written constructs.
    expect(markup).toContain("**bold");
    expect(markup).not.toContain("<strong>");
    expect(markup).not.toContain("<code>");
  });
});
