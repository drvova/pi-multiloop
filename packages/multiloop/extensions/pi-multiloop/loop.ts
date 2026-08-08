import type { LaneId } from "./lanes.js";
import {
  type LoopState,
  type IterationResult,
  type ResultAction,
  loadState,
  saveState,
  appendResult,
  appendLesson,
  reconstructState,
  recordActionCounter,
  formatActionCounters,
  readResults,
  stallStreak,
  isStalled,
  STALL_THRESHOLD,
} from "./state.js";
import {
  type ConfidenceResult,
  assessConfidence,
  isImprovement,
  formatDelta,
} from "./metrics.js";
import { updateLoopStatus, formatLaneId } from "./lanes.js";
import { appendKnowledge } from "./knowledge.js";
import { resolveAcceptanceMode } from "./verifiers.js";

export interface LoopDecision {
  action: ResultAction;
  reason: string;
  shouldEscalate: boolean;
  escalationType?: "refine" | "pivot" | "stop";
}

export interface EscalationState {
  consecutiveFailures: number;
  pivotCount: number;
  shouldStop: boolean;
  message: string;
}

export interface StopCondition {
  kind: "max-iterations" | "target-metric";
  message: string;
}

const REFINE_THRESHOLD = 3;
const PIVOT_THRESHOLD = 5;
const MAX_PIVOTS = 2;
const REANCHOR_INTERVAL = 10;

export { stallStreak, isStalled, STALL_THRESHOLD } from "./state.js";

export function failureEscalationDecision(state: LoopState): Pick<LoopDecision, "shouldEscalate" | "escalationType"> {
  const escalation = checkEscalation(
    state.consecutiveFailures + 1,
    state.pivotCount
  );

  return {
    shouldEscalate: escalation.consecutiveFailures >= REFINE_THRESHOLD,
    escalationType: escalation.shouldStop
      ? "stop"
      : escalation.pivotCount > state.pivotCount
        ? "pivot"
        : escalation.consecutiveFailures >= REFINE_THRESHOLD
          ? "refine"
          : undefined,
  };
}

export function decide(
  state: LoopState,
  measurement: ConfidenceResult,
  baseline: number
): LoopDecision {
  if (state.mode === "research" || state.mode === "dev") {
    return {
      action: "log",
      reason: `Logged measurement: ${measurement.median}`,
      shouldEscalate: false,
    };
  }

  const improved = isImprovement(
    baseline,
    measurement.median,
    measurement.mad,
    state.metricDirection
  );

  if (improved) {
    const delta = formatDelta(baseline, measurement.median, state.metricDirection);
    return {
      action: "keep",
      reason: `Improvement: ${delta} (confidence: ${measurement.confidence})`,
      shouldEscalate: false,
    };
  }

  const escalation = failureEscalationDecision(state);

  return {
    action: "revert",
    reason: `No improvement: ${formatDelta(baseline, measurement.median, state.metricDirection)}`,
    shouldEscalate: escalation.shouldEscalate,
    escalationType: escalation.escalationType,
  };
}

export function checkEscalation(
  consecutiveFailures: number,
  pivotCount: number
): EscalationState {
  if (pivotCount >= MAX_PIVOTS && consecutiveFailures >= PIVOT_THRESHOLD) {
    return {
      consecutiveFailures,
      pivotCount,
      shouldStop: true,
      message: `Exhausted ${MAX_PIVOTS} pivots with ${consecutiveFailures} consecutive failures. Stopping.`,
    };
  }

  if (consecutiveFailures >= PIVOT_THRESHOLD) {
    return {
      consecutiveFailures,
      pivotCount: pivotCount + 1,
      shouldStop: false,
      message: `${consecutiveFailures} consecutive failures. Pivoting to a new approach (pivot ${pivotCount + 1}/${MAX_PIVOTS}).`,
    };
  }

  if (consecutiveFailures >= REFINE_THRESHOLD) {
    return {
      consecutiveFailures,
      pivotCount,
      shouldStop: false,
      message: `${consecutiveFailures} consecutive failures. Refining current approach.`,
    };
  }

  return {
    consecutiveFailures,
    pivotCount,
    shouldStop: false,
    message: "",
  };
}

/**
 * Evaluate the loop's configured stop condition against current state.
 * Pure and idempotent: a met condition stays met, so callers may re-derive the
 * message after the loop has already been marked complete.
 */
export function checkStopCondition(state: LoopState): StopCondition | null {
  if (state.maxIterations != null && state.iteration >= state.maxIterations) {
    return {
      kind: "max-iterations",
      message: `Reached the configured iteration cap (${state.iteration}/${state.maxIterations}).`,
    };
  }

  if (state.targetMetric != null && state.currentMetric !== null) {
    const reached = state.metricDirection === "lower"
      ? state.currentMetric <= state.targetMetric
      : state.currentMetric >= state.targetMetric;
    if (reached) {
      const comparator = state.metricDirection === "lower" ? "<=" : ">=";
      return {
        kind: "target-metric",
        message: `Reached the configured ${state.metricName ?? "metric"} target: ${state.currentMetric} ${comparator} ${state.targetMetric}.`,
      };
    }
  }

  return null;
}

/**
 * Mark a running loop complete when its stop condition is met. Returns the
 * condition that fired, or null when the loop keeps running.
 */
export function completeIfStopConditionMet(
  cwd: string,
  id: LaneId,
  state: LoopState
): StopCondition | null {
  if (state.status !== "running") return null;

  const stop = checkStopCondition(state);
  if (!stop) return null;

  state.status = "completed";
  updateLoopStatus(cwd, id, "completed");
  return stop;
}

/**
 * Why a loop must not be resumed, or null when resuming is safe.
 *
 * A loop whose stop condition is already met would re-complete on its very next
 * decide/log, so resuming it yields one silent bonus iteration and hands the
 * agent a resume prompt that contradicts its own stop condition. Escalation-
 * stopped loops carry no stop condition and stay resumable.
 */
export function resumeRefusalReason(state: LoopState): string | null {
  const stop = checkStopCondition(state);
  if (!stop) return null;

  return [
    stop.message,
    "Resuming would immediately complete it again.",
    `Start a new run, or raise the stop condition in .multiloop/active/${state.lane}/${state.runTag}/state.json.`,
  ].join(" ");
}

/**
 * Persist the first measurement as the loop's baseline.
 *
 * Baseline is not an iteration, so an iteration cap cannot fire here, but a
 * metric target can already be satisfied — an empty checklist or a latency
 * budget the repo already meets. Completing now avoids sending the agent to
 * find work that does not exist.
 */
export function establishBaseline(
  cwd: string,
  id: LaneId,
  state: LoopState,
  metric: number
): StopCondition | null {
  state.baseline = metric;
  state.currentMetric = metric;
  state.bestMetric = metric;
  delete state.activeIteration;

  const stop = completeIfStopConditionMet(cwd, id, state);
  saveState(cwd, id, state);
  return stop;
}

/**
 * Record a log-only iteration (research/dev/punchlist progress, or a
 * skip/crash/blocked outcome) and evaluate the stop condition.
 *
 * Shares the terminal-state contract with applyDecision so neither path can
 * advance the iteration counter without checking whether the loop is done.
 */
export function applyLogIteration(
  cwd: string,
  id: LaneId,
  state: LoopState,
  action: ResultAction,
  metric?: number,
  note?: string
): LoopState {
  const activeIteration = state.activeIteration;
  const timestamp = new Date().toISOString();

  appendResult(cwd, id, {
    iteration: state.iteration + 1,
    timestamp,
    action,
    metric,
    hypothesis: note ?? activeIteration?.hypothesis,
    measurements: activeIteration?.measurements,
    checks: activeIteration?.checks,
    acceptancePassed: activeIteration?.acceptancePassed,
    acceptanceReason: activeIteration?.acceptanceReason,
  });
  recordActionCounter(state, action, timestamp);

  state.iteration++;
  delete state.activeIteration;
  if (metric !== undefined) {
    state.currentMetric = metric;
  }
  state.stallStreak = stallStreak(readResults(cwd, id));

  completeIfStopConditionMet(cwd, id, state);
  saveState(cwd, id, state);
  return state;
}

export function applyDecision(
  cwd: string,
  id: LaneId,
  state: LoopState,
  decision: LoopDecision,
  measurement: ConfidenceResult,
  hypothesis?: string,
  changes?: string
): LoopState {
  const activeIteration = state.activeIteration;
  const result: IterationResult = {
    iteration: state.iteration + 1,
    timestamp: new Date().toISOString(),
    action: decision.action,
    metric: measurement.median,
    baseline: state.currentMetric ?? state.baseline ?? undefined,
    delta: state.currentMetric != null
      ? measurement.median - state.currentMetric
      : undefined,
    confidence: measurement.confidence,
    hypothesis,
    changes,
    reason: decision.reason,
    shouldEscalate: decision.shouldEscalate,
    escalationType: decision.escalationType,
    measurements: measurement.measurements,
    checks: activeIteration?.checks,
    acceptancePassed: activeIteration?.acceptancePassed,
    acceptanceReason: activeIteration?.acceptanceReason,
  };

  appendResult(cwd, id, result);
  recordActionCounter(state, decision.action, result.timestamp);

  state.iteration++;
  delete state.activeIteration;

  if (decision.action === "keep") {
    state.currentMetric = measurement.median;
    state.consecutiveFailures = 0;
    if (state.bestMetric === null) {
      state.bestMetric = measurement.median;
    } else {
      state.bestMetric = state.metricDirection === "lower"
        ? Math.min(state.bestMetric, measurement.median)
        : Math.max(state.bestMetric, measurement.median);
    }
  } else if (decision.action === "revert") {
    state.consecutiveFailures++;
    if (decision.escalationType === "pivot") {
      state.pivotCount++;
      state.consecutiveFailures = 0;
      const lesson = `Pivot ${state.pivotCount}: Previous approach exhausted after ${PIVOT_THRESHOLD} failures.`;
      appendLesson(cwd, id, lesson);
      // Mirror to the shared board: a pivot is distilled learning every lane
      // should inherit, not a per-lane note that dies with the run.
      appendKnowledge(cwd, id, lesson);
      state.lastLesson = lesson;
    }
  } else if (decision.action === "log") {
    state.currentMetric = measurement.median;
  }
  state.stallStreak = stallStreak(readResults(cwd, id));

  if (decision.escalationType === "stop") {
    state.status = "stopped";
    updateLoopStatus(cwd, id, "completed");
  } else {
    completeIfStopConditionMet(cwd, id, state);
  }

  saveState(cwd, id, state);
  return state;
}

export function shouldReanchor(iteration: number): boolean {
  return iteration > 0 && iteration % REANCHOR_INTERVAL === 0;
}

export function reanchor(cwd: string, id: LaneId): LoopState | null {
  return reconstructState(cwd, id);
}

export function buildIterationContext(state: LoopState, meshPeers: string[] = [], knowledge: string[] = [], peerResults: string[] = []): string {
  const lines: string[] = [];
  lines.push(`## Active Loop: ${state.lane}/${state.runTag}`);
  lines.push(`Mode: ${state.mode} | Iteration: ${state.iteration} | Status: ${state.status}`);
  lines.push(`Actions: ${formatActionCounters(state)}`);
  lines.push(`Acceptance mode: ${resolveAcceptanceMode(state)}`);

  if (state.goal) {
    lines.push(`Goal: ${state.goal}`);
  }

  if (state.baseline !== null) {
    lines.push(`Baseline ${state.metricName ?? "metric"}: ${state.baseline}`);
  }
  if (state.currentMetric !== null) {
    lines.push(`Current: ${state.currentMetric}`);
  }
  if (state.bestMetric !== null) {
    lines.push(`Best: ${state.bestMetric}`);
  }

  lines.push(`Verify: \`${state.verifyCommand}\``);
  if (state.guardCommand) {
    lines.push(`Guard: \`${state.guardCommand}\``);
  }
  if (state.promptVerifier) {
    lines.push(`Prompt verifier: ${state.promptVerifier}`);
  }
  if (state.auditVerifier) {
    lines.push(`Audit verifier (extension-run, re-checks every measure): \`${state.auditVerifier}\``);
  }
  if (state.revertVerifier) {
    lines.push(`Revert verifier (extension-run, hashes the workspace at iterate; a revert must reproduce the pre-change fingerprint): \`${state.revertVerifier}\``);
  }
  if (state.lastWorkspaceFingerprint !== undefined && state.lastWorkspaceFingerprint !== null) {
    lines.push(`Workspace boundary pinned ${state.revertVerifier ? "" : "(built-in git fingerprint)"}: edits outside an iteration are refused (fingerprint drift gate).`);
  }
  if (state.minMeasurements && state.minMeasurements > 1) {
    lines.push(`Min measurements before keep/revert: ${state.minMeasurements}`);
  }
  if (state.acceptancePolicy) {
    lines.push(`Acceptance policy: ${state.acceptancePolicy}`);
  } else if (state.guardCommand || state.promptVerifier) {
    lines.push("Acceptance policy: metric must improve and all verification checks must pass");
  }
  if (state.scope) {
    lines.push(`Scope: ${state.scope}`);
  }
  if (state.protectedPaths?.length) {
    lines.push(`Protected files (hash-verified each iteration): ${state.protectedPaths.join(', ')}`);
  }
  if (state.pinnedConfig) {
    lines.push("Loop config pinned: verifier/stop-condition fields are frozen; editing them stops the loop.");
  }
  if (state.lastLesson) {
    lines.push(`Latest lesson: ${state.lastLesson}`);
  }
  if (state.maxIterations != null) {
    lines.push(`Stop condition: iteration cap ${state.iteration}/${state.maxIterations}`);
  }
  if (state.targetMetric != null) {
    lines.push(`Stop condition: ${state.metricName ?? "metric"} target ${state.metricDirection === "lower" ? "<=" : ">="} ${state.targetMetric}`);
  }

  if (state.activeIteration) {
    lines.push(`Active iteration: ${state.activeIteration.iteration} (${state.activeIteration.phase})`);
    if (state.activeIteration.hypothesis) {
      lines.push(`Active hypothesis: ${state.activeIteration.hypothesis}`);
    }
    if (state.activeIteration.phase === "measured") {
      lines.push(`Pending measurements: [${state.activeIteration.measurements?.join(", ") ?? ""}]`);
      if (state.activeIteration.checks && state.activeIteration.checks.length > 0) {
        const failed = state.activeIteration.checks.filter((check) => !check.passed).map((check) => check.name);
        lines.push(`Pending checks: ${failed.length === 0 ? "all passed" : `failed ${failed.join(", ")}`}`);
      }
      if (state.activeIteration.acceptanceReason) {
        const acceptanceStatus = state.activeIteration.acceptancePassed === undefined
          ? "UNKNOWN"
          : state.activeIteration.acceptancePassed ? "PASS" : "FAIL";
        lines.push(`Acceptance: ${acceptanceStatus} — ${state.activeIteration.acceptanceReason}`);
      }
      if (state.activeIteration.recommendedAction) {
        lines.push(`Pending decision: ${state.activeIteration.recommendedAction}`);
      }
    }
  }

  if (state.consecutiveFailures > 0) {
    lines.push(`Consecutive failures: ${state.consecutiveFailures}`);
  }
  if (state.pivotCount > 0) {
    lines.push(`Pivots: ${state.pivotCount}/${MAX_PIVOTS}`);
  }
  if ((state.stallStreak ?? 0) >= STALL_THRESHOLD) {
    lines.push(`Stalled: ${state.stallStreak} identical iterations. Change the approach — repetition without progress is a stall, not a search.`);
  }

  if (meshPeers.length > 0) {
    lines.push(`Mesh inbox (${meshPeers.length} pending from sibling lanes):`);
    lines.push(...meshPeers);
  }

  if (knowledge.length > 0) {
    lines.push(`Shared knowledge (${knowledge.length} entries from all lanes):`);
    lines.push(...knowledge);
  }

  if (peerResults.length > 0) {
    lines.push(`Peer results (${peerResults.length} measured outcomes from sibling lanes — do not repeat measured regressions):`);
    lines.push(...peerResults);
  }

  return lines.join("\n");
}

export function buildEscalationPrompt(
  escalationType: "refine" | "pivot" | "stop",
  state: LoopState
): string {
  switch (escalationType) {
    case "refine":
      return `After ${state.consecutiveFailures} consecutive failures, refine your approach. Review what was tried, identify why it didn't work, and try a different variation of the same strategy.`;
    case "pivot":
      return `After ${PIVOT_THRESHOLD} consecutive failures, pivot to a fundamentally different approach. The current strategy is exhausted — try something qualitatively different.`;
    case "stop":
      return `Loop stopped: exhausted ${MAX_PIVOTS} pivots without improvement. Review the results log and summarize findings.`;
  }
}
