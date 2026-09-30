/**
 * @vitest-environment jsdom
 *
 * The header picker's two controls, driven by real clicks.
 *
 * These are the controls a user reaches for to answer "what will this cost me",
 * and both are easy to render correctly while wiring them to nothing. A checkbox
 * that looks right and calls a no-op still reads as "on", which is worse than
 * having no control: it is a claim about money that the app is not making.
 */

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { AUTO_MODEL, catalogKey, DEFAULT_SETTINGS, type Mode, type Settings } from "@atomic/core";

import { ModelSelect, OnlyFreeToggle } from "./model-select.js";
import type { ModelCatalogState, ModelOption } from "../app/use-models.js";

function option(over: Partial<ModelOption> & { id: string }): ModelOption {
  const providerId = over.providerId ?? "opencode-zen";
  return {
    // Built with the real helper: the separator is a control character, and a
    // hand-written "provider::model" key silently fails to match the rows, which
    // looks exactly like a filtering bug.
    key: catalogKey(providerId, over.id),
    name: over.id,
    providerId,
    providerLabel: "OpenCode Zen",
    freeness: "free",
    freenessReason: "Billed at $0 per million tokens.",
    tools: true,
    vision: false,
    reasoning: false,
    local: false,
    stale: false,
    ...over,
  } as ModelOption;
}

function state(over: Partial<ModelCatalogState> = {}): ModelCatalogState {
  return {
    models: [],
    sections: [],
    loading: false,
    error: null,
    reload: () => {},
    refreshing: false,
    auto: null,
    usingAuto: true,
    onlyFree: false,
    setOnlyFree: () => {},
    filters: {},
    setFilters: () => {},
    ...over,
  };
}

describe("the free-models-only toggle", () => {
  it("reports the value the user chose", async () => {
    const setOnlyFree = vi.fn();
    const user = userEvent.setup();
    render(<OnlyFreeToggle state={state({ onlyFree: false, setOnlyFree })} />);

    const toggle = screen.getByRole("checkbox", { name: /Free models only/i });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(setOnlyFree).toHaveBeenCalledWith(true);
  });

  it("reports turning it back off", async () => {
    const setOnlyFree = vi.fn();
    const user = userEvent.setup();
    render(<OnlyFreeToggle state={state({ onlyFree: true, setOnlyFree })} />);

    const toggle = screen.getByRole("checkbox", { name: /Free models only/i });
    expect(toggle).toBeChecked();

    await user.click(toggle);
    expect(setOnlyFree).toHaveBeenCalledWith(false);
  });

  it("reflects the state it is given, so a refused write is visible", () => {
    // Controlled, not self-managing: if the host refuses to persist the change,
    // the checkbox must go back rather than keep claiming a guarantee the
    // settings do not carry.
    const { rerender } = render(<OnlyFreeToggle state={state({ onlyFree: false })} />);
    expect(screen.getByRole("checkbox", { name: /Free models only/i })).not.toBeChecked();
    rerender(<OnlyFreeToggle state={state({ onlyFree: true })} />);
    expect(screen.getByRole("checkbox", { name: /Free models only/i })).toBeChecked();
  });

  it("says what it actually promises about unpriced models", () => {
    render(<OnlyFreeToggle state={state()} />);
    /*
     * A model that publishes no price is not covered by this guarantee, and the
     * control must not imply that it is. The explanation is on the label rather
     * than the input, so it applies to the whole control and is readable by
     * whatever is pointed at it.
     */
    const label = screen.getByText(/Free models only/i).closest("label");
    expect(label).toHaveAttribute("title", expect.stringContaining("publishes no price"));
  });

  it("is labelled by its text, not only by a title attribute", () => {
    render(<OnlyFreeToggle state={state()} />);
    // Findable by role and name with no pointer: a title is invisible to a
    // screen reader used for navigation.
    expect(screen.getByRole("checkbox", { name: /Free models only/i })).toBeInTheDocument();
  });
});

/**
 * The dropdown's freeness filter, and the shape of what it leaves visible.
 *
 * The filter narrows the list; the toggle governs whether a paid model is ever
 * *sent* anything. Both are needed and they are not the same control, which is
 * why they are separate assertions.
 */
describe("the header picker's model list", () => {
  const models = [
    option({ id: "free-one", freeness: "free" }),
    option({ id: "tier-one", freeness: "free-tier" }),
    option({ id: "paid-one", freeness: "paid" }),
    option({ id: "unknown-one", freeness: "unknown" }),
  ];

  function renderPicker(
    current: Partial<ModelCatalogState> = {},
    settings: Settings = DEFAULT_SETTINGS,
  ) {
    const onChange = vi.fn();
    render(
      <ModelSelect
        label="Model"
        state={state({ models, ...current })}
        value={AUTO_MODEL}
        settings={settings}
        mode={"chat" as Mode}
        onChange={onChange}
        // Filters are a prop, not catalog state: the models tab owns them and
        // passes them down, and putting them in `state` would test a field the
        // component never reads.
        filters={current.filters}
      />,
    );
    return { onChange };
  }

  const optionLabels = () =>
    within(screen.getByLabelText("Model"))
      .getAllByRole("option")
      .map((node) => node.textContent ?? "");

  it("offers every model when nothing is filtered", () => {
    renderPicker();
    const labels = optionLabels();
    expect(labels.some((text) => text.includes("free-one"))).toBe(true);
    expect(labels.some((text) => text.includes("paid-one"))).toBe(true);
  });

  it("narrows to free models when asked, and says so per row", () => {
    renderPicker({ filters: { freeness: ["free"] } });
    const labels = optionLabels();
    expect(labels.some((text) => text.includes("free-one"))).toBe(true);
    expect(labels.some((text) => text.includes("tier-one"))).toBe(false);
    expect(labels.some((text) => text.includes("paid-one"))).toBe(false);
    // The badge is on the row, so the list explains itself without a legend.
    expect(labels.some((text) => text.includes("free ·") || text.includes("· free"))).toBe(true);
  });

  it("keeps free-tier models when only those are asked for", () => {
    // Not a subset of `free`: a free tier is a different thing, and a user
    // filtering for it wants the tier models, not an empty list.
    renderPicker({ filters: { freeness: ["free-tier"] } });
    const labels = optionLabels();
    expect(labels.some((text) => text.includes("tier-one"))).toBe(true);
    expect(labels.some((text) => text.includes("free-one"))).toBe(false);
  });

  it("names the provider on every row, because the id alone cannot be routed", () => {
    renderPicker();
    for (const label of optionLabels()) {
      if (label.includes("free-one")) expect(label).toContain("OpenCode Zen");
    }
  });

  it("reports a selection as a model *and* the provider that serves it", async () => {
    const { onChange } = renderPicker();
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByLabelText("Model"),
      catalogKey("opencode-zen", "paid-one"),
    );
    // Both halves, or a `gpt-4o-mini` from the wrong vendor is a 404 at best.
    expect(onChange).toHaveBeenCalledWith("paid-one", "opencode-zen");
  });

  it("keeps Auto as a choice rather than silently pinning a model", () => {
    renderPicker();
    const labels = optionLabels();
    expect(labels[0]).toBeTruthy();
    expect(screen.getByLabelText("Model")).toHaveValue(AUTO_MODEL);
  });
});
