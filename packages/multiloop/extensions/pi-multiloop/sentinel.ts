// Regression sentinel: the organism's immune system over time.
//
// Pulse perceives the swarm as it is; the sentinel perceives what it has
// become. Every completed/archived run leaves its verify command and champion
// metric on disk. A sweep re-runs that command once per champion and compares
// the fresh measurement against the champion's own recorded noise band (the
// MAD of the measurements that backed the keep, via the same isImprovement
// statistics the loop engine trusts). A significant regression posts one
// immune signal to the shared knowledge board, so every live lane's next
// iteration context carries the wound.
//
// Boundaries (Poka-Yoke by construction): the sentinel only reads loop state
// and executes verifiers through the extension-owned executor from anchors.ts
// — it cannot break a loop because it never drives one. It scans only
// completed/archived entries; live lanes measure themselves.

import { type LaneId, type RegistryEntry, formatLaneId, readRegistry } from "./lanes.js";
import { readRunFiles, type IterationResult } from "./state.js";
import { medianAbsoluteDeviation, isImprovement, formatDelta } from "./metrics.js";
import { runVerifierCommand, parseAuditOutput } from "./anchors.js";
import { appendKnowledge } from "./knowledge.js";

export type SentinelVerdict = "holds" | "improved" | "regressed" | "unmeasurable";

export interface SentinelReport {
  id: LaneId;
  verdict: SentinelVerdict;
  champion: number | null;
  measured: number | null;
  detail: string;
}

/** Loops that no longer measure themselves: completed or archived. The sentinel watches only the dead and the resting. */
export function sentinelCandidates(loops: RegistryEntry[]): RegistryEntry[] {
  return loops.filter((l) => l.status === "completed" || l.status === "archived");
}

/**
 * The measurements that backed the champion: the last keep's measurement set.
 * Falls back to the bare champion value (MAD 0, deterministic) for log-only
 * modes and hand-written state — there any drift at all is significant.
 */
function championMeasurements(results: IterationResult[], best: number): number[] {
  const lastKeep = [...results].reverse().find((r) => r.action === "keep" && r.measurements?.length);
  return lastKeep?.measurements ?? [best];
}

/** Re-measure one champion against its own noise band. Never throws; failure modes are unmeasurable verdicts. */
export function checkChampion(cwd: string, entry: RegistryEntry): SentinelReport {
  const id: LaneId = { lane: entry.lane, runTag: entry.runTag };
  const { state, results } = readRunFiles(cwd, entry.stateDir);
  const best = state?.bestMetric ?? null;
  const command = entry.verifyCommand ?? state?.verifyCommand;
  const metricName = state?.metricName ?? "metric";
  if (best === null || !command) {
    return { id, verdict: "unmeasurable", champion: best, measured: null, detail: command ? "no champion metric recorded" : "no verify command recorded" };
  }
  const run = runVerifierCommand(cwd, command);
  if (!run.ok) {
    return { id, verdict: "unmeasurable", champion: best, measured: null, detail: `verify command failed: ${run.error}` };
  }
  const measured = parseAuditOutput(run.output);
  if (measured === null) {
    return { id, verdict: "unmeasurable", champion: best, measured: null, detail: "no numeric metric in verify output" };
  }
  const direction = state?.metricDirection ?? "lower";
  const mad = medianAbsoluteDeviation(championMeasurements(results, best));
  const verdict: SentinelVerdict =
    isImprovement(measured, best, mad, direction) ? "regressed"
    : isImprovement(best, measured, mad, direction) ? "improved"
    : "holds";
  const detail = verdict === "holds"
    ? `${metricName} ${measured} within band ±${mad} of champion ${best}`
    : `${metricName} ${formatDelta(best, measured, direction)} (band ±${mad})`;
  return { id, verdict, champion: best, measured, detail };
}

/**
 * Sweep every completed/archived champion (or one, when target names a lane
 * or lane/run-tag), post an immune signal per regression, and render the
 * report. This is the whole organ: perception, signal, memory.
 */
export function runSentinel(cwd: string, target?: string): string {
  const registry = readRegistry(cwd);
  const all = sentinelCandidates(registry.loops);
  const candidates = target
    ? all.filter((l) => l.lane === target || formatLaneId(l) === target)
    : all;
  if (candidates.length === 0) {
    return target
      ? `Sentinel: no completed/archived champion matches "${target}".`
      : "Sentinel: no completed or archived loops to watch. The organism remembers nothing yet.";
  }

  const reports = candidates.map((entry) => {
    const report = checkChampion(cwd, entry);
    if (report.verdict === "regressed") {
      appendKnowledge(
        cwd,
        report.id,
        `Sentinel immune signal: champion ${formatLaneId(report.id)} regressed (${report.champion} → ${report.measured}). The gain this run earned no longer holds — investigate drift before trusting that benchmark again.`
      );
    }
    return report;
  });

  const regressed = reports.filter((r) => r.verdict === "regressed");
  const unmeasurable = reports.filter((r) => r.verdict === "unmeasurable");
  const lines = [
    `Sentinel sweep: ${reports.length} champion(s) re-measured · ${regressed.length} regressed · ${unmeasurable.length} unmeasurable`,
    ...reports.map((r) =>
      `  ${r.verdict.toUpperCase()}  ${formatLaneId(r.id)}  ${r.detail}${r.verdict === "regressed" ? " — immune signal posted to the knowledge board" : ""}`
    ),
  ];
  if (regressed.length > 0) {
    lines.push("", "A regression means the world moved, not that the loop lied. Re-run the lane or investigate the drift before trusting the old numbers.");
  }
  return lines.join("\n");
}
