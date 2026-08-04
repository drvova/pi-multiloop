import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { createInitialState, type LoopState } from "../extensions/pi-multiloop/state.js";
import {
  buildDashboardRows,
  createLiveDashboardWidget,
  formatDashboardText,
  formatDashboardWidgetText,
} from "../extensions/pi-multiloop/ui.js";
import { laneFor } from "./support/seed.js";

/** Identity theme: renders plain text with no ANSI escapes. */
const PLAIN: Pick<Theme, "fg"> = {
  fg: (_color: ThemeColor, text: string) => text,
};

/** Marker theme: wraps each cell so color application is assertable. */
const MARKING: Pick<Theme, "fg"> = {
  fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
};

function stateFor(prefix: string): LoopState {
  return createInitialState(laneFor(prefix), "optimize", "bench", { goal: `goal ${prefix}` });
}

describe("live dashboard widget", () => {
  it("reports idle when no loops are attached", () => {
    const widget = createLiveDashboardWidget(() => [], PLAIN);
    expect(widget.render(120)).toEqual(["multiloop: idle — no active loops"]);
  });

  it("reads live state on every render, not a snapshot", () => {
    const states: LoopState[] = [stateFor("perf")];
    const widget = createLiveDashboardWidget(() => states, PLAIN);

    const first = widget.render(120).join("\n");
    expect(first).toContain("perf");
    expect(first).not.toContain("quant");

    // A new loop attaches between paints; the next render must show it.
    states.push(stateFor("quant"));
    const second = widget.render(120).join("\n");
    expect(second).toContain("perf");
    expect(second).toContain("quant");
  });

  it("caps rows and reports the overflow", () => {
    const states = Array.from({ length: 12 }, (_, i) => stateFor(`lane${i}`));
    const lines = createLiveDashboardWidget(() => states, PLAIN).render(120);
    expect(lines).toHaveLength(2 + 8 + 1); // header + rule + 8 rows + overflow line
    expect(lines.join("\n")).toContain("… 4 more");
  });

  it("truncates lines to the viewport width", () => {
    const states = [stateFor("perf")];
    for (const line of createLiveDashboardWidget(() => states, PLAIN).render(40)) {
      // truncateToWidth caps visible width; raw length may include ANSI reset codes.
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("colors lane, status, and failure cells through the theme", () => {
    const rows = buildDashboardRows([stateFor("perf")]);
    const line = formatDashboardWidgetText(rows, MARKING)[2];
    expect(line).toContain("<accent>perf");
    expect(line).toContain("<success>running ");
  });

  it("warns on consecutive failures", () => {
    const state = stateFor("perf");
    state.consecutiveFailures = 2;
    const line = formatDashboardWidgetText(buildDashboardRows([state]), MARKING)[2];
    expect(line).toContain("<warning>2    ");
  });
});

describe("formatDashboardText", () => {
  it("stays plain text with no ANSI escapes", () => {
    const lines = formatDashboardText(buildDashboardRows([stateFor("perf")]));
    expect(lines.join("\n")).not.toContain("\u001b[");
    expect(lines[0]).toMatch(/^LANE\s+MODE\s+ITER\s+STATUS/);
    expect(lines[2]).toContain("perf");
  });
});
