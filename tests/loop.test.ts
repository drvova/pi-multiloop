import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decide,
  checkEscalation,
  applyDecision,
  shouldReanchor,
  buildIterationContext,
  buildEscalationPrompt,
  checkStopCondition,
  completeIfStopConditionMet,
  resumeRefusalReason,
} from "../extensions/pi-multiloop/loop.js";
import {
  type LoopState,
  createInitialState,
  saveState,
  loadState,
  readResults,
} from "../extensions/pi-multiloop/state.js";
import { type LaneId, registerLoop, readRegistry } from "../extensions/pi-multiloop/lanes.js";
import type { ConfidenceResult } from "../extensions/pi-multiloop/metrics.js";
import { laneFor, tmpPrefix } from "./support/seed.js";

function m(median: number, mad: number, confidence: "high" | "medium" | "low" = "high"): ConfidenceResult {
  return {
    median,
    mad,
    confidence,
    measurements: [median],
    isSignificant: true,
  };
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  const id: LaneId = laneFor("test");
  return {
    ...createInitialState(id, "optimize", "echo 42"),
    baseline: 100,
    currentMetric: 100,
    bestMetric: 100,
    iteration: 0,
    ...overrides,
  };
}

let cwd: string;
const id: LaneId = laneFor("test");

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), tmpPrefix("loop")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("checkEscalation", () => {
  it("returns no escalation for low consecutive failures", () => {
    const result = checkEscalation(0, 0);
    expect(result.shouldStop).toBe(false);
    expect(result.message).toBe("");
    expect(result.pivotCount).toBe(0);
  });

  it("returns refine at REFINE_THRESHOLD (3)", () => {
    const result = checkEscalation(3, 0);
    expect(result.shouldStop).toBe(false);
    expect(result.message).toContain("Refining");
    expect(result.pivotCount).toBe(0);
  });

  it("returns refine between REFINE_THRESHOLD and PIVOT_THRESHOLD", () => {
    const result = checkEscalation(4, 0);
    expect(result.shouldStop).toBe(false);
    expect(result.message).toContain("Refining");
    expect(result.pivotCount).toBe(0);
  });

  it("pivots at PIVOT_THRESHOLD (5) with no prior pivots", () => {
    const result = checkEscalation(5, 0);
    expect(result.shouldStop).toBe(false);
    expect(result.message).toContain("Pivoting");
    expect(result.message).toContain("pivot 1/2");
    expect(result.pivotCount).toBe(1);
  });

  it("pivots again at PIVOT_THRESHOLD with 1 prior pivot", () => {
    const result = checkEscalation(5, 1);
    expect(result.shouldStop).toBe(false);
    expect(result.message).toContain("Pivoting");
    expect(result.message).toContain("pivot 2/2");
    expect(result.pivotCount).toBe(2);
  });

  it("stops when PIVOT_THRESHOLD hit with MAX_PIVOTS reached", () => {
    const result = checkEscalation(5, 2);
    expect(result.shouldStop).toBe(true);
    expect(result.message).toContain("Stopping");
    expect(result.pivotCount).toBe(2);
  });

  it("stops at 6 failures with 2 pivots (above threshold)", () => {
    const result = checkEscalation(6, 2);
    expect(result.shouldStop).toBe(true);
  });
});

describe("decide", () => {
  it("returns log action for research mode", () => {
    const state = makeState({ mode: "research" });
    const result = decide(state, m(95, 5), 100);
    expect(result.action).toBe("log");
    expect(result.shouldEscalate).toBe(false);
  });

  it("returns log action for dev mode", () => {
    const state = makeState({ mode: "dev" });
    const result = decide(state, m(95, 5), 100);
    expect(result.action).toBe("log");
    expect(result.shouldEscalate).toBe(false);
  });

  it("returns keep when lower-is-better improvement detected", () => {
    const state = makeState({ metricDirection: "lower", currentMetric: 100 });
    const result = decide(state, m(80, 5), 100);
    expect(result.action).toBe("keep");
    expect(result.reason).toContain("Improvement");
    expect(result.shouldEscalate).toBe(false);
  });

  it("returns keep when higher-is-better improvement detected", () => {
    const state = makeState({ metricDirection: "higher", currentMetric: 100 });
    const result = decide(state, m(120, 5), 100);
    expect(result.action).toBe("keep");
  });

  it("returns revert without escalation for first failure", () => {
    const state = makeState({ consecutiveFailures: 0 });
    const result = decide(state, m(100, 1), 100);
    expect(result.action).toBe("revert");
    expect(result.shouldEscalate).toBe(false);
  });

  it("returns revert with refine on 3rd consecutive failure", () => {
    const state = makeState({ consecutiveFailures: 2 });
    const result = decide(state, m(100, 1), 100);
    expect(result.action).toBe("revert");
    expect(result.shouldEscalate).toBe(true);
    expect(result.escalationType).toBe("refine");
  });

  it("returns revert with pivot on 5th consecutive failure", () => {
    const state = makeState({ consecutiveFailures: 4, pivotCount: 0 });
    const result = decide(state, m(100, 1), 100);
    expect(result.action).toBe("revert");
    expect(result.shouldEscalate).toBe(true);
    expect(result.escalationType).toBe("pivot");
  });

  it("returns revert with stop when pivots exhausted", () => {
    const state = makeState({ consecutiveFailures: 4, pivotCount: 2 });
    const result = decide(state, m(100, 1), 100);
    expect(result.action).toBe("revert");
    expect(result.escalationType).toBe("stop");
  });
});

describe("applyDecision", () => {
  it("increments iteration and saves result on keep", () => {
    const state = makeState({
      activeIteration: {
        iteration: 1,
        phase: "measured",
        startedAt: "2026-05-07T00:00:00.000Z",
        measurements: [85],
        metric: 85,
        checks: [{ name: "correctness", kind: "prompt", passed: true, evidence: "looks good" }],
        acceptancePassed: true,
        acceptanceReason: "metric improved; all checks passed",
        recommendedAction: "keep",
        measuredAt: "2026-05-07T00:01:00.000Z",
      },
    });
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "keep",
      reason: "Improved",
      shouldEscalate: false,
    }, m(85, 3), "try unrolling", "unrolled loop");

    expect(result.iteration).toBe(1);
    expect(result.currentMetric).toBe(85);
    expect(result.bestMetric).toBe(85);
    expect(result.consecutiveFailures).toBe(0);
    expect(result.keeps).toBe(1);
    expect(result.lastAction).toBe("keep");
    expect(result.lastActionAt).toBeDefined();
    expect(result.activeIteration).toBeUndefined();

    const saved = loadState(cwd, id);
    expect(saved).not.toBeNull();
    expect(saved!.iteration).toBe(1);
    expect(saved!.currentMetric).toBe(85);
    const rows = readResults(cwd, id);
    expect(rows[0].checks).toEqual([{ name: "correctness", kind: "prompt", passed: true, evidence: "looks good" }]);
    expect(rows[0].acceptancePassed).toBe(true);
    expect(rows[0].acceptanceReason).toBe("metric improved; all checks passed");
  });

  it("updates bestMetric correctly for lower-is-better", () => {
    const state = makeState({ metricDirection: "lower", currentMetric: 100, bestMetric: 100 });

    // First keep: 85 is better than 100
    applyDecision(cwd, id, state, {
      action: "keep",
      reason: "Improved",
      shouldEscalate: false,
    }, m(85, 3));

    // Second keep: 90 is worse than best
    const state2 = loadState(cwd, id)!;
    applyDecision(cwd, id, state2, {
      action: "keep",
      reason: "Improved",
      shouldEscalate: false,
    }, m(90, 3));

    const final = loadState(cwd, id)!;
    expect(final.bestMetric).toBe(85); // best remains 85
    expect(final.currentMetric).toBe(90);
  });

  it("updates bestMetric correctly for higher-is-better", () => {
    const state = makeState({ metricDirection: "higher", currentMetric: 100, bestMetric: 100 });

    applyDecision(cwd, id, state, {
      action: "keep",
      reason: "Improved",
      shouldEscalate: false,
    }, m(120, 3));

    const final = loadState(cwd, id)!;
    expect(final.bestMetric).toBe(120);
  });

  it("increments consecutive failures on revert", () => {
    const state = makeState({ consecutiveFailures: 1 });
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "revert",
      reason: "No improvement",
      shouldEscalate: false,
    }, m(105, 3));

    expect(result.consecutiveFailures).toBe(2);
    expect(result.currentMetric).toBe(100); // unchanged
  });

  it("resets failures and increments pivot on pivot escalation", () => {
    const state = makeState({ consecutiveFailures: 4, pivotCount: 0 });
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "revert",
      reason: "No improvement",
      shouldEscalate: true,
      escalationType: "pivot",
    }, m(105, 3));

    expect(result.consecutiveFailures).toBe(0);
    expect(result.pivotCount).toBe(1);

    const rows = readResults(cwd, id);
    expect(rows[0].shouldEscalate).toBe(true);
    expect(rows[0].escalationType).toBe("pivot");
    expect(rows[0].reason).toBe("No improvement");

    // Verify lesson was written
    const lessonsFile = join(cwd, ".multiloop", "active", id.lane, id.runTag, "lessons.md");
    expect(existsSync(lessonsFile)).toBe(true);
    const lessons = readFileSync(lessonsFile, "utf-8");
    expect(lessons).toContain("Pivot 1");
    expect(lessons).toContain("Previous approach exhausted");
  });

  it("sets status to stopped and updates registry on stop", () => {
    const state = makeState();
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "revert",
      reason: "No improvement",
      shouldEscalate: true,
      escalationType: "stop",
    }, m(105, 3));

    expect(result.status).toBe("stopped");
  });

  it("completes the loop when the iteration cap is reached", () => {
    const state = makeState({ iteration: 2, maxIterations: 3 });
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "keep",
      reason: "Improved",
      shouldEscalate: false,
    }, m(85, 3));

    expect(result.iteration).toBe(3);
    expect(result.status).toBe("completed");
    expect(loadState(cwd, id)!.status).toBe("completed");
  });

  it("keeps running while the iteration cap is not reached", () => {
    const state = makeState({ iteration: 0, maxIterations: 3 });
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "keep",
      reason: "Improved",
      shouldEscalate: false,
    }, m(85, 3));

    expect(result.status).toBe("running");
  });

  it("completes the loop when a kept metric reaches the target", () => {
    const state = makeState({ targetMetric: 90, metricDirection: "lower" });
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "keep",
      reason: "Improved",
      shouldEscalate: false,
    }, m(85, 3));

    expect(result.status).toBe("completed");
  });

  it("does not complete when a reverted iteration leaves the metric short of target", () => {
    const state = makeState({ targetMetric: 90, metricDirection: "lower" });
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "revert",
      reason: "No improvement",
      shouldEscalate: false,
    }, m(85, 3));

    expect(result.currentMetric).toBe(100);
    expect(result.status).toBe("running");
  });

  it("lets escalation stop take precedence over the stop condition", () => {
    const state = makeState({ iteration: 2, maxIterations: 3 });
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "revert",
      reason: "No improvement",
      shouldEscalate: true,
      escalationType: "stop",
    }, m(105, 3));

    expect(result.status).toBe("stopped");
  });
});

describe("checkStopCondition", () => {
  it("returns null when no stop condition is configured", () => {
    expect(checkStopCondition(makeState({ iteration: 999 }))).toBeNull();
  });

  it("reports the iteration cap once reached", () => {
    const stop = checkStopCondition(makeState({ iteration: 10, maxIterations: 10 }));
    expect(stop?.kind).toBe("max-iterations");
    expect(stop?.message).toContain("10/10");
  });

  it("reports a lower-is-better target once reached", () => {
    const stop = checkStopCondition(makeState({
      currentMetric: 0,
      targetMetric: 0,
      metricDirection: "lower",
      metricName: "open_or_partial_items",
    }));
    expect(stop?.kind).toBe("target-metric");
    expect(stop?.message).toContain("open_or_partial_items");
    expect(stop?.message).toContain("<=");
  });

  it("reports a higher-is-better target once reached", () => {
    const stop = checkStopCondition(makeState({
      currentMetric: 95,
      targetMetric: 90,
      metricDirection: "higher",
    }));
    expect(stop?.kind).toBe("target-metric");
    expect(stop?.message).toContain(">=");
  });

  it("returns null while a target is still unmet", () => {
    expect(checkStopCondition(makeState({
      currentMetric: 95,
      targetMetric: 90,
      metricDirection: "lower",
    }))).toBeNull();
  });

  it("returns null when a target is configured but no metric is recorded yet", () => {
    expect(checkStopCondition(makeState({
      currentMetric: null,
      targetMetric: 0,
    }))).toBeNull();
  });

  it("prefers the iteration cap when both conditions are met", () => {
    const stop = checkStopCondition(makeState({
      iteration: 5,
      maxIterations: 5,
      currentMetric: 0,
      targetMetric: 0,
    }));
    expect(stop?.kind).toBe("max-iterations");
  });
});

describe("completeIfStopConditionMet", () => {
  it("marks a running loop complete and reports the condition", () => {
    const state = makeState({ iteration: 4, maxIterations: 4 });
    const stop = completeIfStopConditionMet(cwd, id, state);

    expect(stop?.kind).toBe("max-iterations");
    expect(state.status).toBe("completed");
  });

  it("leaves a non-running loop untouched", () => {
    const state = makeState({ iteration: 4, maxIterations: 4, status: "paused" });

    expect(completeIfStopConditionMet(cwd, id, state)).toBeNull();
    expect(state.status).toBe("paused");
  });

  it("leaves an uncapped loop running", () => {
    const state = makeState({ iteration: 999 });

    expect(completeIfStopConditionMet(cwd, id, state)).toBeNull();
    expect(state.status).toBe("running");
  });

  it("flips the registry entry to completed, not just the snapshot", () => {
    const state = makeState({ iteration: 2, maxIterations: 2 });
    registerLoop(cwd, {
      lane: id.lane,
      runTag: id.runTag,
      mode: "optimize",
      status: "active",
      startedAt: state.startedAt,
      stateDir: `.multiloop/active/${id.lane}/${id.runTag}`,
    });

    completeIfStopConditionMet(cwd, id, state);

    expect(readRegistry(cwd).loops[0].status).toBe("completed");
  });
});

describe("resumeRefusalReason", () => {
  it("allows resuming a loop with no stop condition", () => {
    expect(resumeRefusalReason(makeState({ iteration: 999 }))).toBeNull();
  });

  it("allows resuming while the iteration cap is not yet reached", () => {
    expect(resumeRefusalReason(makeState({ iteration: 4, maxIterations: 10 }))).toBeNull();
  });

  it("allows resuming an escalation-stopped loop, which carries no stop condition", () => {
    const state = makeState({ status: "stopped", consecutiveFailures: 5, pivotCount: 2 });
    expect(resumeRefusalReason(state)).toBeNull();
  });

  it("refuses to resume a loop whose iteration cap is already met", () => {
    const reason = resumeRefusalReason(makeState({ iteration: 10, maxIterations: 10 }));
    expect(reason).not.toBeNull();
    expect(reason).toContain("10/10");
    expect(reason).toContain("immediately complete it again");
    expect(reason).toContain(`.multiloop/active/${id.lane}/${id.runTag}/state.json`);
  });

  it("refuses to resume a loop whose metric target is already met", () => {
    const reason = resumeRefusalReason(makeState({
      currentMetric: 0,
      targetMetric: 0,
      metricDirection: "lower",
      metricName: "open_or_partial_items",
    }));
    expect(reason).toContain("open_or_partial_items");
  });
});

describe("shouldReanchor", () => {
  it("returns false for iteration 0", () => {
    expect(shouldReanchor(0)).toBe(false);
  });

  it("returns false for non-multiple of 10", () => {
    expect(shouldReanchor(5)).toBe(false);
    expect(shouldReanchor(11)).toBe(false);
  });

  it("returns true every 10 iterations starting from 10", () => {
    expect(shouldReanchor(10)).toBe(true);
    expect(shouldReanchor(20)).toBe(true);
    expect(shouldReanchor(100)).toBe(true);
  });
});

describe("buildIterationContext", () => {
  it("includes pending active iteration information", () => {
    const state = makeState({
      activeIteration: {
        iteration: 2,
        phase: "measured",
        startedAt: "2026-05-07T00:00:00.000Z",
        hypothesis: "try fewer open checklist items",
        measurements: [356],
        metric: 356,
        recommendedAction: "revert",
        measuredAt: "2026-05-07T00:01:00.000Z",
      },
    });

    const context = buildIterationContext(state);

    expect(context).toContain("Active iteration: 2 (measured)");
    expect(context).toContain("Active hypothesis: try fewer open checklist items");
    expect(context).toContain("Pending measurements: [356]");
    expect(context).toContain("Pending decision: revert");
  });

  it("includes lane, mode, iteration, status", () => {
    const state = makeState();
    const ctx = buildIterationContext(state);
    expect(ctx).toContain(`${id.lane}/${id.runTag}`);
    expect(ctx).toContain("optimize");
    expect(ctx).toContain("Iteration: 0");
    expect(ctx).toContain("running");
    expect(ctx).toContain("Actions: keeps=0, reverts=0, logs=0, crashes=0, blocked=0");
  });

  it("includes goal when present", () => {
    const state = makeState({ goal: "reduce latency" });
    expect(buildIterationContext(state)).toContain("reduce latency");
  });

  it("includes metric info when baseline is set", () => {
    const state = makeState({ baseline: 100, currentMetric: 85, bestMetric: 80 });
    const ctx = buildIterationContext(state);
    expect(ctx).toContain("Baseline");
    expect(ctx).toContain("100");
    expect(ctx).toContain("Current:");
    expect(ctx).toContain("85");
    expect(ctx).toContain("Best:");
    expect(ctx).toContain("80");
  });

  it("shows failure and pivot counts when non-zero", () => {
    const state = makeState({ consecutiveFailures: 3, pivotCount: 1 });
    const ctx = buildIterationContext(state);
    expect(ctx).toContain("Consecutive failures: 3");
    expect(ctx).toContain("Pivots: 1/2");
  });

  it("includes scope when set", () => {
    const state = makeState({ scope: "src/kernel/" });
    expect(buildIterationContext(state)).toContain("src/kernel/");
  });

  it("surfaces the iteration cap so it survives compaction", () => {
    const state = makeState({ iteration: 4, maxIterations: 10 });
    expect(buildIterationContext(state)).toContain("Stop condition: iteration cap 4/10");
  });

  it("surfaces the metric target so it survives compaction", () => {
    const state = makeState({ targetMetric: 0, metricDirection: "lower", metricName: "open_or_partial_items" });
    expect(buildIterationContext(state)).toContain("Stop condition: open_or_partial_items target <= 0");
  });

  it("omits stop-condition lines for an until-interrupted loop", () => {
    expect(buildIterationContext(makeState())).not.toContain("Stop condition:");
  });
});

describe("buildEscalationPrompt", () => {
  it("returns refine message", () => {
    const state = makeState({ consecutiveFailures: 3 });
    const msg = buildEscalationPrompt("refine", state);
    expect(msg).toContain("3 consecutive failures");
    expect(msg).toContain("refine");
  });

  it("returns pivot message", () => {
    const state = makeState();
    const msg = buildEscalationPrompt("pivot", state);
    expect(msg).toContain("pivot");
    expect(msg).toContain("fundamentally different");
  });

  it("returns stop message", () => {
    const state = makeState();
    const msg = buildEscalationPrompt("stop", state);
    expect(msg).toContain("stopped");
    expect(msg).toContain("summarize findings");
  });
});