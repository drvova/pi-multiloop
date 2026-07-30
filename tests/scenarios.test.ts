import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type StopCondition,
  applyDecision,
  completeIfStopConditionMet,
  resumeRefusalReason,
  checkStopCondition,
  buildIterationContext,
  establishBaseline,
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
  writeRegistry,
  ensureLaneDir,
  laneDir,
} from "../extensions/pi-multiloop/lanes.js";
import type { ConfidenceResult } from "../extensions/pi-multiloop/metrics.js";
import { laneFor, tmpPrefix } from "./support/seed.js";

function measurement(value: number): ConfidenceResult {
  return { median: value, mad: 1, confidence: "high", measurements: [value], isSignificant: true };
}

function register(cwd: string, id: LaneId, state: LoopState, mode: string): void {
  registerLoop(cwd, {
    lane: id.lane,
    runTag: id.runTag,
    mode,
    status: "active",
    startedAt: state.startedAt,
    stateDir: `.multiloop/active/${id.lane}/${id.runTag}`,
  });
}

function seed(cwd: string, id: LaneId, state: LoopState, baseline = 100): LoopState {
  state.baseline = baseline;
  state.currentMetric = baseline;
  state.bestMetric = baseline;
  ensureLaneDir(cwd, id);
  saveState(cwd, id, state);
  return state;
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), tmpPrefix("scenarios")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("A. multi-lane isolation", () => {
  it("completing a capped lane leaves a sibling lane on the same worktree untouched", () => {
    const perf: LaneId = laneFor("perf");
    const quant: LaneId = laneFor("quant");

    let perfState = seed(cwd, perf, createInitialState(perf, "optimize", "bench", { maxIterations: 2 }));
    let quantState = seed(cwd, quant, createInitialState(quant, "optimize", "sweep"));
    register(cwd, perf, perfState, "optimize");
    register(cwd, quant, quantState, "optimize");

    const keep = { action: "keep" as const, reason: "improved", shouldEscalate: false };

    // Interleave the two lanes the way a single worktree actually runs them.
    perfState = applyDecision(cwd, perf, perfState, keep, measurement(95));
    quantState = applyDecision(cwd, quant, quantState, keep, measurement(97));
    perfState = applyDecision(cwd, perf, perfState, keep, measurement(90));
    quantState = applyDecision(cwd, quant, quantState, keep, measurement(94));

    expect(perfState.status).toBe("completed");
    expect(quantState.status).toBe("running");

    const registry = readRegistry(cwd);
    expect(registry.loops).toHaveLength(2);
    expect(registry.loops.find((l) => l.lane === perf.lane)!.status).toBe("completed");
    expect(registry.loops.find((l) => l.lane === quant.lane)!.status).toBe("active");

    // Each lane's snapshot must be independent on disk, not just in memory.
    expect(loadState(cwd, perf)!.status).toBe("completed");
    expect(loadState(cwd, quant)!.status).toBe("running");
    expect(loadState(cwd, quant)!.maxIterations).toBeUndefined();
  });

  it("two lanes with independent caps complete at their own iteration counts", () => {
    const a: LaneId = laneFor("a");
    const b: LaneId = laneFor("b");
    let sa = seed(cwd, a, createInitialState(a, "optimize", "x", { maxIterations: 1 }));
    let sb = seed(cwd, b, createInitialState(b, "optimize", "y", { maxIterations: 3 }));
    const keep = { action: "keep" as const, reason: "improved", shouldEscalate: false };

    sa = applyDecision(cwd, a, sa, keep, measurement(90));
    sb = applyDecision(cwd, b, sb, keep, measurement(90));
    expect(sa.status).toBe("completed");
    expect(sb.status).toBe("running");

    sb = applyDecision(cwd, b, sb, keep, measurement(85));
    sb = applyDecision(cwd, b, sb, keep, measurement(80));
    expect(sb.status).toBe("completed");
    expect(sb.iteration).toBe(3);
  });
});

describe("B. higher-is-better targets", () => {
  const id: LaneId = laneFor("acc");

  it("completes only once the metric climbs to the target", () => {
    let state = seed(cwd, id, createInitialState(id, "optimize", "eval", {
      targetMetric: 0.95,
      metricDirection: "higher",
      metricName: "accuracy",
    }), 0.90);
    const keep = { action: "keep" as const, reason: "improved", shouldEscalate: false };

    state = applyDecision(cwd, id, state, keep, measurement(0.92));
    expect(state.status).toBe("running");

    state = applyDecision(cwd, id, state, keep, measurement(0.96));
    expect(state.status).toBe("completed");
    expect(resumeRefusalReason(state)).toContain(">=");
  });

  it("does not confuse direction: a low value never satisfies a higher-is-better target", () => {
    const state = seed(cwd, id, createInitialState(id, "optimize", "eval", {
      targetMetric: 0.95,
      metricDirection: "higher",
    }), 0.10);
    expect(checkStopCondition(state)).toBeNull();
  });
});

describe("C. caps independent of metric movement", () => {
  const id: LaneId = laneFor("perf");

  it("a loop that only reverts still reaches its cap", () => {
    // This is the exact hole that made escalation insufficient: reverts move no
    // metric, so a target can never fire, and consecutiveFailures resets on any
    // keep. Only the iteration cap bounds this shape of run.
    let state = seed(cwd, id, createInitialState(id, "optimize", "bench", { maxIterations: 3 }));

    for (let i = 0; i < 3; i++) {
      state = applyDecision(cwd, id, state, {
        action: "revert",
        reason: "no improvement",
        shouldEscalate: false,
      }, measurement(110 + i));
    }

    expect(state.currentMetric).toBe(100);
    expect(state.reverts).toBe(3);
    expect(state.status).toBe("completed");
  });

  it("crash and blocked iterations count toward the cap", () => {
    const state = seed(cwd, id, createInitialState(id, "dev", "npm test", { maxIterations: 3 }));

    applyLogIteration(cwd, id, state, "crash");
    applyLogIteration(cwd, id, state, "blocked");
    expect(state.status).toBe("running");

    applyLogIteration(cwd, id, state, "log", 42);
    expect(state.status).toBe("completed");
    expect(state.crashes).toBe(1);
    expect(state.blocked).toBe(1);
  });

  it("a keep that never improves enough still burns cap budget", () => {
    let state = seed(cwd, id, createInitialState(id, "research", "sweep", { maxIterations: 2 }));
    state = applyDecision(cwd, id, state, { action: "log", reason: "logged", shouldEscalate: false }, measurement(100));
    expect(state.status).toBe("running");
    state = applyDecision(cwd, id, state, { action: "log", reason: "logged", shouldEscalate: false }, measurement(100));
    expect(state.status).toBe("completed");
  });
});

describe("D. escalation and stop condition collide", () => {
  const id: LaneId = laneFor("perf");

  it("escalation exhaustion wins when both fire on the same iteration", () => {
    let state = seed(cwd, id, createInitialState(id, "optimize", "bench", { maxIterations: 3 }));
    state.iteration = 2;
    state.consecutiveFailures = 5;
    state.pivotCount = 2;
    saveState(cwd, id, state);

    state = applyDecision(cwd, id, state, {
      action: "revert",
      reason: "no improvement",
      shouldEscalate: true,
      escalationType: "stop",
    }, measurement(110));

    // "gave up" must stay distinguishable from "goal reached".
    expect(state.status).toBe("stopped");
    expect(state.iteration).toBe(3);
    // The cap is nonetheless met, so resume is still refused.
    expect(resumeRefusalReason(state)).toContain("3/3");
  });

  it("an escalation-stopped loop under its cap stays resumable", () => {
    const state = seed(cwd, id, createInitialState(id, "optimize", "bench", { maxIterations: 10 }));
    state.iteration = 4;
    state.status = "stopped";

    expect(resumeRefusalReason(state)).toBeNull();
  });
});

describe("E. baseline already satisfies the goal", () => {
  it("a punchlist whose checklist is already empty completes without iterating", () => {
    const id: LaneId = laneFor("plan");
    const state = createInitialState(id, "punchlist", "count-items", {
      targetMetric: 0,
      metricName: "open_or_partial_items",
      metricDirection: "lower",
    });
    ensureLaneDir(cwd, id);
    saveState(cwd, id, state);
    register(cwd, id, state, "punchlist");

    const stop = establishBaseline(cwd, id, state, 0);

    expect(stop).not.toBeNull();
    expect(state.status).toBe("completed");
    expect(state.iteration).toBe(0);
    expect(readRegistry(cwd).loops[0].status).toBe("completed");
  });

  it("a baseline short of the target still starts the loop", () => {
    const id: LaneId = laneFor("plan");
    const state = createInitialState(id, "punchlist", "count-items", { targetMetric: 0 });
    ensureLaneDir(cwd, id);
    saveState(cwd, id, state);

    expect(establishBaseline(cwd, id, state, 4)).toBeNull();
    expect(state.status).toBe("running");
  });

  it("an iteration cap never fires at baseline, because baseline is not an iteration", () => {
    const id: LaneId = laneFor("perf");
    const state = createInitialState(id, "optimize", "bench", { maxIterations: 5 });
    ensureLaneDir(cwd, id);
    saveState(cwd, id, state);

    expect(establishBaseline(cwd, id, state, 100)).toBeNull();
    expect(state.status).toBe("running");
  });
});

describe("F. upgrade path from pre-stop-condition state files", () => {
  const id: LaneId = laneFor("legacy");

  it("a 0.3.2 snapshot with no stop-condition keys loads as uncapped and resumable", () => {
    const dir = ensureLaneDir(cwd, id);
    const legacy = {
      lane: id.lane,
      runTag: id.runTag,
      mode: "optimize",
      iteration: 12,
      baseline: 100,
      currentMetric: 80,
      bestMetric: 80,
      consecutiveFailures: 0,
      pivotCount: 0,
      keeps: 5, reverts: 7, logs: 0, crashes: 0, blocked: 0,
      lastAction: "keep",
      status: "running",
      verifyCommand: "bench",
      metricDirection: "lower",
      acceptanceMode: "keep-revert",
      startedAt: "2026-05-01T00:00:00.000Z",
      lastUpdated: "2026-05-01T00:00:00.000Z",
      config: {},
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify(legacy, null, 2));

    const loaded = loadState(cwd, id)!;
    expect(loaded.maxIterations).toBeUndefined();
    expect(loaded.targetMetric).toBeUndefined();
    expect(checkStopCondition(loaded)).toBeNull();
    expect(resumeRefusalReason(loaded)).toBeNull();
    expect(buildIterationContext(loaded)).not.toContain("Stop condition:");
  });

  it("a legacy snapshot keeps running past any iteration count", () => {
    let state = seed(cwd, id, createInitialState(id, "optimize", "bench"));
    delete state.maxIterations;
    delete state.targetMetric;

    for (let i = 0; i < 25; i++) {
      state = applyDecision(cwd, id, state, {
        action: "keep", reason: "improved", shouldEscalate: false,
      }, measurement(99 - i));
    }
    expect(state.status).toBe("running");
  });
});

describe("G. registry desync cannot resurrect a loop", () => {
  const id: LaneId = laneFor("perf");

  it("state.json remains the liveness source of truth when the registry is stale", () => {
    let state = seed(cwd, id, createInitialState(id, "optimize", "bench", { maxIterations: 1 }));
    register(cwd, id, state, "optimize");
    state = applyDecision(cwd, id, state, {
      action: "keep", reason: "improved", shouldEscalate: false,
    }, measurement(90));
    expect(state.status).toBe("completed");

    // writeRegistry is a non-atomic read-modify-write, so a second pi process on
    // the same repo can clobber this entry back to active. That must not make the
    // loop live again.
    const registry = readRegistry(cwd);
    registry.loops[0].status = "active";
    writeRegistry(cwd, registry);

    const rehydrated = reconstructState(cwd, id)!;
    expect(rehydrated.status).toBe("completed");
    expect(resumeRefusalReason(rehydrated)).not.toBeNull();
  });

  it("a missing registry entry does not prevent completion from persisting", () => {
    let state = seed(cwd, id, createInitialState(id, "optimize", "bench", { maxIterations: 1 }));
    // No registerLoop call at all: updateLoopStatus finds nothing and no-ops.
    state = applyDecision(cwd, id, state, {
      action: "keep", reason: "improved", shouldEscalate: false,
    }, measurement(90));

    expect(state.status).toBe("completed");
    expect(loadState(cwd, id)!.status).toBe("completed");
  });
});

describe("H. terminal states do not oscillate", () => {
  const id: LaneId = laneFor("plan");

  it("a completed loop stays completed when the metric later regresses", () => {
    const state = seed(cwd, id, createInitialState(id, "punchlist", "count", {
      targetMetric: 0, metricDirection: "lower",
    }), 3);

    applyLogIteration(cwd, id, state, "log", 0);
    expect(state.status).toBe("completed");

    // The checklist regrows. completeIfStopConditionMet must no-op on a
    // non-running loop rather than flipping status back and forth.
    state.currentMetric = 2;
    expect(completeIfStopConditionMet(cwd, id, state)).toBeNull();
    expect(state.status).toBe("completed");
  });

  it("re-running the completion check on an already-complete loop is idempotent", () => {
    const state = seed(cwd, id, createInitialState(id, "optimize", "bench", { maxIterations: 1 }));
    state.iteration = 1;

    expect(completeIfStopConditionMet(cwd, id, state)).not.toBeNull();
    expect(completeIfStopConditionMet(cwd, id, state)).toBeNull();
    expect(completeIfStopConditionMet(cwd, id, state)).toBeNull();
    expect(state.status).toBe("completed");
  });
});

describe("I. hand-edited state files fail safe", () => {
  const id: LaneId = laneFor("perf");

  it("a zero or negative cap completes immediately rather than running unbounded", () => {
    for (const cap of [0, -1]) {
      const state = seed(cwd, id, createInitialState(id, "optimize", "bench"));
      state.maxIterations = cap;
      expect(checkStopCondition(state)?.kind).toBe("max-iterations");
    }
  });

  it("removing the field is the documented escape hatch and is the only way to uncap", () => {
    const state = seed(cwd, id, createInitialState(id, "optimize", "bench", { maxIterations: 2 }));
    state.iteration = 5;
    expect(checkStopCondition(state)).not.toBeNull();

    delete state.maxIterations;
    expect(checkStopCondition(state)).toBeNull();
  });

  it("survives a state.json rewritten by hand with the cap raised mid-run", () => {
    let state = seed(cwd, id, createInitialState(id, "optimize", "bench", { maxIterations: 2 }));
    register(cwd, id, state, "optimize");
    state = applyDecision(cwd, id, state, { action: "keep", reason: "ok", shouldEscalate: false }, measurement(95));
    state = applyDecision(cwd, id, state, { action: "keep", reason: "ok", shouldEscalate: false }, measurement(90));
    expect(state.status).toBe("completed");

    const path = join(laneDir(cwd, id), "state.json");
    const edited = JSON.parse(readFileSync(path, "utf-8"));
    edited.maxIterations = 4;
    edited.status = "running";
    writeFileSync(path, JSON.stringify(edited, null, 2));

    const reopened = reconstructState(cwd, id)!;
    expect(resumeRefusalReason(reopened)).toBeNull();
    expect(reopened.iteration).toBe(2);
  });
});

describe("J. fresh lane directory creation", () => {
  it("completes correctly when the lane directory did not previously exist", () => {
    const id: LaneId = laneFor("brand-new");
    mkdirSync(join(cwd, ".multiloop"), { recursive: true });

    const state = createInitialState(id, "optimize", "bench", { maxIterations: 1 });
    state.baseline = 10;
    state.currentMetric = 10;
    state.bestMetric = 10;
    ensureLaneDir(cwd, id);
    saveState(cwd, id, state);
    register(cwd, id, state, "optimize");

    const done = applyDecision(cwd, id, state, {
      action: "keep", reason: "improved", shouldEscalate: false,
    }, measurement(5));

    expect(done.status).toBe("completed");
    expect(loadState(cwd, id)!.status).toBe("completed");
    expect(readRegistry(cwd).loops[0].status).toBe("completed");
  });
});
