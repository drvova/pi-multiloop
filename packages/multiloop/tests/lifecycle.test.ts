import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyDecision,
  completeIfStopConditionMet,
  resumeRefusalReason,
  buildIterationContext,
  applyLogIteration,
} from "../extensions/pi-multiloop/loop.js";
import {
  type LoopState,
  createInitialState,
  saveState,
  loadState,
  reconstructState,
} from "../extensions/pi-multiloop/state.js";
import {
  type LaneId,
  registerLoop,
  readRegistry,
  ensureLaneDir,
} from "../extensions/pi-multiloop/lanes.js";
import type { ConfidenceResult } from "../extensions/pi-multiloop/metrics.js";
import { laneFor, tmpPrefix } from "./support/seed.js";

const id: LaneId = laneFor("perf");

function measurement(value: number): ConfidenceResult {
  return { median: value, mad: 1, confidence: "high", measurements: [value], isSignificant: true };
}

function register(cwd: string, state: LoopState, mode: string): void {
  registerLoop(cwd, {
    lane: id.lane,
    runTag: id.runTag,
    mode,
    status: "active",
    startedAt: state.startedAt,
    stateDir: `.multiloop/active/${id.lane}/${id.runTag}`,
  });
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), tmpPrefix("lifecycle")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("capped optimize loop lifecycle", () => {
  it("runs to the cap, completes, refuses resume, and reopens when the cap is raised", () => {
    let state = createInitialState(id, "optimize", "bench", { maxIterations: 3, metricName: "ms" });
    state.baseline = 100;
    state.currentMetric = 100;
    state.bestMetric = 100;
    ensureLaneDir(cwd, id);
    saveState(cwd, id, state);
    register(cwd, state, "optimize");

    // Two iterations short of the cap: the loop must stay eligible for auto-continue.
    for (const value of [95, 90]) {
      state = applyDecision(cwd, id, state, {
        action: "keep",
        reason: "improved",
        shouldEscalate: false,
      }, measurement(value));
    }
    expect(state.iteration).toBe(2);
    expect(state.status).toBe("running");
    expect(resumeRefusalReason(state)).toBeNull();

    // Simulated session restart: everything must come back from disk alone.
    const rehydrated = reconstructState(cwd, id)!;
    expect(rehydrated.maxIterations).toBe(3);
    expect(rehydrated.iteration).toBe(2);
    expect(buildIterationContext(rehydrated)).toContain("Stop condition: iteration cap 2/3");

    // Third iteration reaches the cap.
    state = applyDecision(cwd, id, rehydrated, {
      action: "keep",
      reason: "improved",
      shouldEscalate: false,
    }, measurement(85));

    expect(state.iteration).toBe(3);
    expect(state.status).toBe("completed");
    expect(loadState(cwd, id)!.status).toBe("completed");
    expect(readRegistry(cwd).loops[0].status).toBe("completed");

    // Resume must refuse rather than grant a silent bonus iteration.
    const refusal = resumeRefusalReason(reconstructState(cwd, id)!);
    expect(refusal).toContain("3/3");
    expect(refusal).toContain("immediately complete it again");

    // The refusal is self-correcting: raising the bound reopens the loop.
    const raised = reconstructState(cwd, id)!;
    raised.maxIterations = 5;
    saveState(cwd, id, raised);
    expect(resumeRefusalReason(reconstructState(cwd, id)!)).toBeNull();
  });

  it("refuses resume even when state.json lags behind results.jsonl", () => {
    let state = createInitialState(id, "optimize", "bench", { maxIterations: 2 });
    state.baseline = 100;
    state.currentMetric = 100;
    state.bestMetric = 100;
    ensureLaneDir(cwd, id);
    saveState(cwd, id, state);

    for (const value of [95, 90]) {
      state = applyDecision(cwd, id, state, {
        action: "keep",
        reason: "improved",
        shouldEscalate: false,
      }, measurement(value));
    }
    expect(state.status).toBe("completed");

    // Simulate a crash that left a stale snapshot: results.jsonl still holds both
    // iterations, so reconstruct must re-derive the completed count.
    const stale = loadState(cwd, id)!;
    stale.iteration = 0;
    stale.status = "running";
    saveState(cwd, id, stale);

    const rehydrated = reconstructState(cwd, id)!;
    expect(rehydrated.iteration).toBe(2);
    expect(resumeRefusalReason(rehydrated)).not.toBeNull();
  });
});

describe("punchlist target lifecycle", () => {
  it("completes when the checklist empties and stays complete across a restart", () => {
    const state = createInitialState(id, "punchlist", "count", {
      targetMetric: 0,
      metricName: "open_or_partial_items",
      metricDirection: "lower",
    });
    ensureLaneDir(cwd, id);
    saveState(cwd, id, state);
    register(cwd, state, "punchlist");

    applyLogIteration(cwd, id, state, "log", 3);
    expect(state.status).toBe("running");

    applyLogIteration(cwd, id, state, "log", 1);
    expect(state.status).toBe("running");

    applyLogIteration(cwd, id, state, "log", 0);
    expect(state.status).toBe("completed");
    expect(readRegistry(cwd).loops[0].status).toBe("completed");

    const rehydrated = reconstructState(cwd, id)!;
    expect(rehydrated.status).toBe("completed");
    expect(rehydrated.targetMetric).toBe(0);
    expect(resumeRefusalReason(rehydrated)).toContain("open_or_partial_items");
  });
});

describe("uncapped loop lifecycle", () => {
  it("never self-completes and always permits resume", () => {
    let state = createInitialState(id, "optimize", "bench");
    state.baseline = 100;
    state.currentMetric = 100;
    state.bestMetric = 100;
    ensureLaneDir(cwd, id);
    saveState(cwd, id, state);

    for (let i = 0; i < 40; i++) {
      state = applyDecision(cwd, id, state, {
        action: "keep",
        reason: "improved",
        shouldEscalate: false,
      }, measurement(99 - i));
    }

    expect(state.iteration).toBe(40);
    expect(state.status).toBe("running");
    expect(resumeRefusalReason(state)).toBeNull();
    expect(buildIterationContext(state)).not.toContain("Stop condition:");
  });
});
