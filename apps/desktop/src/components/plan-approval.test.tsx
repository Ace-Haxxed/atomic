/**
 * Approving a plan hands the user a permission level, so the dialog is the
 * place where that choice becomes explicit. These tests are static markup:
 * they cannot prove the dialog is pleasant, but they do prove the offered
 * choices, which is the part that is a safety property.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PlanApproval, PlanLevelDialog } from "./plan-approval.js";

const READY = {
  planning: true,
  settled: true,
  busy: false,
  hasPlan: true,
  onApprove: () => {},
  onLeavePlanning: () => {},
};

function card(command: "ask" | "auto-accept"): string {
  return renderToStaticMarkup(
    <PlanLevelDialog
      onCancel={() => {}}
      onChoose={() => {
        void command;
      }}
    />,
  );
}

describe("PlanLevelDialog", () => {
  it("offers ask and auto-accept, and nothing else", () => {
    const html = card("ask");
    expect(html).toContain("Ask every time");
    expect(html).toContain("Auto-accept edits");
    // `bypass` is never appropriate here, and offering it in a dialog the user
    // reaches by approving a plan would hand out consent they did not give.
    expect(html).not.toContain("bypass");
    expect(html).not.toContain("Bypass");
  });

  it("preselects ask rather than defaulting to the risky option", () => {
    const html = card("ask");
    const radio = /<input[^>]*value="ask"[^>]*>/.exec(html)?.[0] ?? "";
    expect(radio).toContain("checked");
  });

  it("describes what each choice actually changes", () => {
    const html = card("ask");
    // A level with no stated consequence is a coin flip wearing a label.
    expect(html).toContain("waits for you");
    expect(html).toContain("still ask");
  });

  it("is announced as a dialog, so a screen reader says what opened", () => {
    const html = card("ask");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("aria-labelledby");
  });
});

describe("PlanApproval", () => {
  it("does not offer approval before the agent has said anything", () => {
    const html = renderToStaticMarkup(<PlanApproval {...READY} hasPlan={false} />);
    expect(html).toBe("");
  });

  it("does not offer approval while a run is in flight", () => {
    // Approving a plan that is still being written would lock the level to
    // something nobody has read.
    expect(renderToStaticMarkup(<PlanApproval {...READY} busy />)).toBe("");
  });

  it("stays out of the way outside plan mode", () => {
    expect(renderToStaticMarkup(<PlanApproval {...READY} planning={false} />)).toBe("");
  });

  it("explains that plan mode cannot write before offering the way out", () => {
    const html = renderToStaticMarkup(<PlanApproval {...READY} />);
    expect(html).toContain("read-only");
    expect(html).toContain("Approve plan");
  });
});
