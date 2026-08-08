import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { LoopState } from "./state.js";
import { confidenceLabel } from "./metrics.js";
export interface DashboardRow {
  lane: string;
  runTag: string;
  mode: string;
  iteration: number;
  status: LoopState["status"];
  metric: string;
  best: string;
  delta: string;
  confidence: string;
  failures: number;
  pivots: number;
}

export function buildDashboardRows(states: LoopState[]): DashboardRow[] {
  return states.map((s) => ({
    lane: s.lane,
    runTag: s.runTag,
    mode: s.mode,
    iteration: s.iteration,
    status: s.status,
    metric: s.currentMetric !== null ? s.currentMetric.toFixed(4) : "—",
    best: s.bestMetric !== null ? s.bestMetric.toFixed(4) : "—",
    delta:
      s.baseline !== null && s.currentMetric !== null
        ? formatPct(s.baseline, s.currentMetric, s.metricDirection)
        : "—",
    confidence: "—",
    failures: s.consecutiveFailures,
    pivots: s.pivotCount,
  }));
}

function formatPct(
  baseline: number,
  current: number,
  direction: "lower" | "higher"
): string {
  const diff = current - baseline;
  const pct = ((diff / Math.abs(baseline)) * 100).toFixed(1);
  const improved =
    direction === "lower" ? diff < 0 : diff > 0;
  return `${diff >= 0 ? "+" : ""}${pct}%${improved ? " +" : ""}`;
}

const MAX_DASHBOARD_ROWS = 8;

const STATUS_COLORS: Record<LoopState["status"], ThemeColor> = {
  running: "success",
  paused: "warning",
  completed: "muted",
  stopped: "error",
  archived: "dim",
};

const PLAIN_THEME: Pick<Theme, "fg"> = {
  fg: (_color: ThemeColor, text: string) => text,
};

function dashboardHeader(theme: Pick<Theme, "fg">): string {
  return theme.fg(
    "muted",
    padRight("LANE", 12) +
      padRight("MODE", 10) +
      padRight("ITER", 6) +
      padRight("STATUS", 10) +
      padRight("METRIC", 12) +
      padRight("BEST", 12) +
      padRight("DELTA", 10) +
      padRight("FAIL", 5) +
      "PIV"
  );
}

function dashboardRowLine(row: DashboardRow, theme: Pick<Theme, "fg">): string {
  const failures =
    row.failures > 0
      ? theme.fg("warning", padRight(String(row.failures), 5))
      : padRight(String(row.failures), 5);
  return (
    theme.fg("accent", padRight(row.lane, 12)) +
      padRight(row.mode, 10) +
      padRight(String(row.iteration), 6) +
      theme.fg(STATUS_COLORS[row.status], padRight(row.status, 10)) +
      padRight(row.metric, 12) +
      padRight(row.best, 12) +
      padRight(row.delta, 10) +
      failures +
      String(row.pivots)
  );
}

/**
 * Theme-aware dashboard rendering used by the live widget.
 * Pads cells before coloring so ANSI escapes never shift columns.
 */
export function formatDashboardWidgetText(
  rows: DashboardRow[],
  theme: Pick<Theme, "fg">
): string[] {
  if (rows.length === 0) {
    return [theme.fg("muted", "multiloop: idle — no active loops")];
  }
  return [
    dashboardHeader(theme),
    theme.fg("muted", "─".repeat(77)),
    ...rows.map((row) => dashboardRowLine(row, theme)),
  ];
}

export function formatDashboardText(rows: DashboardRow[]): string[] {
  if (rows.length === 0) return ["No active loops."];
  return [
    dashboardHeader(PLAIN_THEME),
    PLAIN_THEME.fg("muted", "─".repeat(77)),
    ...rows.map((row) => dashboardRowLine(row, PLAIN_THEME)),
  ];
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

export function formatLoopSummary(state: LoopState): string[] {
  const lines: string[] = [];
  lines.push(`Loop: ${state.lane}/${state.runTag}`);
  lines.push(`Mode: ${state.mode} | Status: ${state.status}`);
  lines.push(`Iteration: ${state.iteration}`);

  if (state.goal) lines.push(`Goal: ${state.goal}`);

  if (state.baseline !== null) {
    lines.push(`Baseline: ${state.baseline}`);
    if (state.currentMetric !== null) {
      lines.push(`Current: ${state.currentMetric}`);
      const pct = formatPct(state.baseline, state.currentMetric, state.metricDirection);
      lines.push(`Change: ${pct}`);
    }
    if (state.bestMetric !== null) {
      lines.push(`Best: ${state.bestMetric}`);
    }
  }

  if (state.consecutiveFailures > 0) {
    lines.push(`Consecutive failures: ${state.consecutiveFailures}`);
  }
  if (state.pivotCount > 0) {
    lines.push(`Pivots: ${state.pivotCount}/2`);
  }
  return lines;
}

/**
 * Live loop-dashboard widget: a pi extension widget (ctx.ui.setWidget factory
 * form) whose render() pulls the current loop states on every paint, so the
 * dashboard stays live across repaints and state mutations. The caller re-arms
 * it through setWidget on every state change.
 */
export function createLiveDashboardWidget(
  getStates: () => LoopState[],
  theme: Pick<Theme, "fg">,
  getSwarmLines: () => string[] = () => []
): Component {
  return {
    render(width: number): string[] {
      const states = getStates();
      const rows = buildDashboardRows(states);
      const lines =
        rows.length > 0
          ? formatDashboardWidgetText(rows.slice(0, MAX_DASHBOARD_ROWS), theme)
          : formatDashboardWidgetText([], theme);
      if (rows.length > MAX_DASHBOARD_ROWS) {
        lines.push(theme.fg("muted", `… ${rows.length - MAX_DASHBOARD_ROWS} more; run /multiloop status`));
      }
      // Swarm perception: mesh/knowledge/proposal lines read live per paint,
      // same discipline as the lane rows above.
      lines.push(...getSwarmLines().map((line) => theme.fg("muted", line)));
      return lines.map((line) => truncateToWidth(line, Math.max(8, width)));
    },
    invalidate(): void {
      // No cached rendering state; every paint reads the live states.
    },
  };
}
