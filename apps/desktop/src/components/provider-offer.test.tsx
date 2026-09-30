/**
 * The consent dialog. What matters is that the user is told *whose account* they
 * are about to hand the conversation to, because a model name alone does not
 * describe a different bill or a different data processor.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ProviderOffer } from "./provider-offer.js";

const base = {
  model: "gpt-4o",
  providerLabel: "OpenRouter",
  reason: "it hit a rate limit",
  onAccept: () => {},
  onDecline: () => {},
};

function render(props: Partial<React.ComponentProps<typeof ProviderOffer>> = {}) {
  return renderToStaticMarkup(<ProviderOffer {...base} {...props} />);
}

describe("ProviderOffer", () => {
  it("names the account, not just the model", () => {
    const markup = render();
    expect(markup).toContain("Answer this on OpenRouter?");
    expect(markup).toContain("OpenRouter");
  });

  it("says why the original provider could not answer", () => {
    expect(render()).toContain("it hit a rate limit");
  });

  /**
   * A button reading "Use it" is a consent the user cannot give: they cannot
   * tell that approving it moves their message to another account.
   */
  it("names the provider on the button that accepts it", () => {
    expect(render()).toContain("Use OpenRouter for this message");
  });

  it("says that a different account and bill are involved", () => {
    const markup = render();
    expect(markup).toContain("different account");
    expect(markup).toContain("different bill");
  });

  it("scopes consent to this message, not to every future one", () => {
    const markup = render();
    expect(markup).toContain("this message only");
  });

  it("offers a way out that does not require a different provider", () => {
    expect(render()).toContain("already set up");
  });

  it("is announced as a dialog, not a log line", () => {
    expect(render()).toContain('role="alertdialog"');
  });
});
