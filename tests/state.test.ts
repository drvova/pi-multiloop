import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendResult,
  readResults,
  readResultsSince,
  saveState,
  loadState,
  reconstructState,
  appendLesson,
  readLessons,
  createInitialState,
  stallStreak,
  isStalled,
  type IterationResult,
} from "../extensions/pi-multiloop/state.js";
import type { LaneId } from "../extensions/pi-multiloop/lanes.js";
import { laneFor, tmpPrefix } from "./support/seed.js";

let cwd: string;
const id: LaneId = laneFor("test");

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), tmpPrefix("state")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("results JSONL", () => {
  it("returns empty array when no file exists", () => {
    expect(readResults(cwd, id)).toEqual([]);
  });

  it("appends and reads results", () => {
    const r1: IterationResult = {
      iteration: 1,
      timestamp: new Date().toISOString(),
      action: "keep",
      metric: 42.5,
      baseline: 50.0,
    };
    const r2: IterationResult = {
      iteration: 2,
      timestamp: new Date().toISOString(),
      action: "revert",
      metric: 51.0,
      baseline: 42.5,
    };
    appendResult(cwd, id, r1);
    appendResult(cwd, id, r2);

    const results = readResults(cwd, id);
    expect(results).toHaveLength(2);
    expect(results[0].metric).toBe(42.5);
    expect(results[1].action).toBe("revert");
  });

  it("filters results since a given iteration", () => {
    for (let i = 1; i <= 5; i++) {
      appendResult(cwd, id, {
        iteration: i,
        timestamp: new Date().toISOString(),
        action: "keep",
        metric: i * 10,
      });
    }
    const since3 = readResultsSince(cwd, id, 3);
    expect(since3).toHaveLength(2);
    expect(since3[0].iteration).toBe(4);
  });
});

describe("state snapshot", () => {
  it("creates and loads state", () => {
    const state = createInitialState(id, "optimize", "echo 42", {
      metricDirection: "lower",
      goal: "reduce latency",
    });
    saveState(cwd, id, state);
    const loaded = loadState(cwd, id);
    expect(loaded).not.toBeNull();
    expect(loaded!.lane).toBe(id.lane);
    expect(loaded!.mode).toBe("optimize");
    expect(loaded!.goal).toBe("reduce latency");
  });

  it("saves state through a temp file without leaving temp artifacts", () => {
    const state = createInitialState(id, "optimize", "echo 42");

    saveState(cwd, id, state);
    state.iteration = 2;
    saveState(cwd, id, state);

    const loaded = loadState(cwd, id);
    const files = readdirSync(join(cwd, ".multiloop", "active", id.lane, id.runTag));
    expect(loaded!.iteration).toBe(2);
    expect(files).toContain("state.json");
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  it("returns null when no state file exists", () => {
    expect(loadState(cwd, id)).toBeNull();
  });
});

describe("state reconstruction", () => {
  it("preserves a pending active iteration beyond the last completed result", () => {
    const state = createInitialState(id, "optimize", "echo 42");
    state.iteration = 1;
    state.baseline = 100;
    state.currentMetric = 90;
    state.activeIteration = {
      iteration: 2,
      phase: "measured",
      startedAt: "2026-05-07T00:00:00.000Z",
      measurements: [95],
      metric: 95,
      recommendedAction: "revert",
      measuredAt: "2026-05-07T00:01:00.000Z",
    };
    saveState(cwd, id, state);
    appendResult(cwd, id, {
      iteration: 1,
      timestamp: new Date().toISOString(),
      action: "keep",
      metric: 90,
    });

    const reconstructed = reconstructState(cwd, id);

    expect(reconstructed!.iteration).toBe(1);
    expect(reconstructed!.activeIteration?.iteration).toBe(2);
    expect(reconstructed!.activeIteration?.phase).toBe("measured");
  });

  it("clears stale active iteration markers already covered by results", () => {
    const state = createInitialState(id, "optimize", "echo 42");
    state.iteration = 1;
    state.baseline = 100;
    state.currentMetric = 90;
    state.activeIteration = {
      iteration: 2,
      phase: "measured",
      startedAt: "2026-05-07T00:00:00.000Z",
      measurements: [95],
      metric: 95,
      recommendedAction: "revert",
      measuredAt: "2026-05-07T00:01:00.000Z",
    };
    saveState(cwd, id, state);
    appendResult(cwd, id, {
      iteration: 2,
      timestamp: new Date().toISOString(),
      action: "revert",
      metric: 95,
    });

    const reconstructed = reconstructState(cwd, id);

    expect(reconstructed!.iteration).toBe(2);
    expect(reconstructed!.activeIteration).toBeUndefined();
  });

  it("reconstructs state from results", () => {
    const state = createInitialState(id, "optimize", "echo 42", {
      metricDirection: "lower",
    });
    state.baseline = 100;
    state.currentMetric = 100;
    state.bestMetric = 100;
    saveState(cwd, id, state);

    appendResult(cwd, id, {
      iteration: 1,
      timestamp: new Date().toISOString(),
      action: "keep",
      metric: 90,
    });
    appendResult(cwd, id, {
      iteration: 2,
      timestamp: new Date().toISOString(),
      action: "revert",
      metric: 95,
    });
    appendResult(cwd, id, {
      iteration: 3,
      timestamp: new Date().toISOString(),
      action: "revert",
      metric: 98,
    });

    const reconstructed = reconstructState(cwd, id);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.iteration).toBe(3);
    expect(reconstructed!.currentMetric).toBe(90);
    expect(reconstructed!.consecutiveFailures).toBe(2);
    expect(reconstructed!.bestMetric).toBe(90);
    expect(reconstructed!.keeps).toBe(1);
    expect(reconstructed!.reverts).toBe(2);
    expect(reconstructed!.lastAction).toBe("revert");
  });

  it("does not let reverted measurements become the current metric", () => {
    const state = createInitialState(id, "optimize", "echo 42", {
      metricDirection: "lower",
    });
    state.baseline = 100;
    state.currentMetric = 100;
    state.bestMetric = 100;
    saveState(cwd, id, state);

    appendResult(cwd, id, {
      iteration: 1,
      timestamp: new Date().toISOString(),
      action: "keep",
      metric: 90,
    });
    appendResult(cwd, id, {
      iteration: 2,
      timestamp: new Date().toISOString(),
      action: "revert",
      metric: 120,
    });

    const reconstructed = reconstructState(cwd, id);

    expect(reconstructed!.currentMetric).toBe(90);
    expect(reconstructed!.bestMetric).toBe(90);
    expect(reconstructed!.consecutiveFailures).toBe(1);
  });

  it("replays skip/crash/blocked metrics the same way applyLogIteration records them", () => {
    // applyLogIteration moves currentMetric for any log-family action carrying a
    // metric. Replay used to honour only keep and log, so a loop completed by a
    // target on a blocked iteration rebuilt as incomplete -- and therefore
    // resumable, defeating the stop-condition guard.
    const state = createInitialState(id, "punchlist", "count", { targetMetric: 2 });
    state.baseline = 19;
    state.currentMetric = 19;
    saveState(cwd, id, state);

    for (const [iteration, action, metric] of [
      [1, "skip", 12],
      [2, "crash", 7],
      [3, "blocked", 1],
    ] as const) {
      appendResult(cwd, id, {
        iteration,
        timestamp: new Date().toISOString(),
        action,
        metric,
      });
    }

    const reconstructed = reconstructState(cwd, id)!;
    expect(reconstructed.currentMetric).toBe(1);
    expect(reconstructed.iteration).toBe(3);
  });

  it("still refuses to let a reverted measurement move the current metric", () => {
    const state = createInitialState(id, "optimize", "bench");
    state.baseline = 100;
    state.currentMetric = 100;
    saveState(cwd, id, state);

    appendResult(cwd, id, {
      iteration: 1,
      timestamp: new Date().toISOString(),
      action: "revert",
      metric: 5,
    });

    expect(reconstructState(cwd, id)!.currentMetric).toBe(100);
  });

  it("reconstructs pivot escalation resets from result metadata", () => {
    const state = createInitialState(id, "optimize", "echo 42", {
      metricDirection: "lower",
    });
    state.baseline = 100;
    state.currentMetric = 100;
    state.bestMetric = 100;
    state.pivotCount = 0;
    saveState(cwd, id, state);

    for (let iteration = 1; iteration <= 4; iteration++) {
      appendResult(cwd, id, {
        iteration,
        timestamp: new Date().toISOString(),
        action: "revert",
        metric: 101 + iteration,
      });
    }
    appendResult(cwd, id, {
      iteration: 5,
      timestamp: new Date().toISOString(),
      action: "revert",
      metric: 110,
      shouldEscalate: true,
      escalationType: "pivot",
    });

    const reconstructed = reconstructState(cwd, id);

    expect(reconstructed!.pivotCount).toBe(1);
    expect(reconstructed!.consecutiveFailures).toBe(0);
    expect(reconstructed!.currentMetric).toBe(100);
  });

  it("handles older snapshots without pivotCount when replaying escalation metadata", () => {
    const state = createInitialState(id, "optimize", "echo 42", {
      metricDirection: "lower",
    });
    state.baseline = 100;
    state.currentMetric = 100;
    state.bestMetric = 100;
    delete (state as { pivotCount?: number }).pivotCount;
    saveState(cwd, id, state);

    appendResult(cwd, id, {
      iteration: 1,
      timestamp: new Date().toISOString(),
      action: "revert",
      metric: 110,
      shouldEscalate: true,
      escalationType: "pivot",
    });

    const reconstructed = reconstructState(cwd, id);

    expect(reconstructed!.pivotCount).toBe(1);
    expect(reconstructed!.consecutiveFailures).toBe(0);
  });

  it("returns null when no state exists", () => {
    expect(reconstructState(cwd, id)).toBeNull();
  });
});

describe("lessons", () => {
  it("appends and reads lessons", () => {
    appendLesson(cwd, id, "Loop unrolling didn't help");
    appendLesson(cwd, id, "Vectorization improved by 15%");
    const lessons = readLessons(cwd, id);
    expect(lessons).toContain("Loop unrolling");
    expect(lessons).toContain("Vectorization");
  });

  it("returns empty string when no lessons file", () => {
    expect(readLessons(cwd, id)).toBe("");
  });
});

describe("createInitialState", () => {
  it("creates state with defaults", () => {
    const state = createInitialState(id, "optimize", "make bench");
    expect(state.iteration).toBe(0);
    expect(state.baseline).toBeNull();
    expect(state.currentMetric).toBeNull();
    expect(state.bestMetric).toBeNull();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.stallStreak).toBe(0);
    expect(state.pivotCount).toBe(0);
    expect(state.keeps).toBe(0);
    expect(state.reverts).toBe(0);
    expect(state.logs).toBe(0);
    expect(state.crashes).toBe(0);
    expect(state.blocked).toBe(0);
    expect(state.lastAction).toBeNull();
    expect(state.status).toBe("running");
    expect(state.metricDirection).toBe("lower");
    expect(state.acceptanceMode).toBe("keep-revert");
    expect(state.maxIterations).toBeUndefined();
    expect(state.targetMetric).toBeUndefined();
  });

  it("defaults non-optimize modes to log acceptance", () => {
    expect(createInitialState(id, "punchlist", "make test").acceptanceMode).toBe("log");
    expect(createInitialState(id, "research", "make bench").acceptanceMode).toBe("log");
    expect(createInitialState(id, "dev", "npm test").acceptanceMode).toBe("log");
  });

  it("accepts optional config", () => {
    const state = createInitialState(id, "punchlist", "grep -c '\\[ \\]' PLAN.md", {
      metricDirection: "lower",
      scope: "src/",
      goal: "complete all items",
      config: { punchlistFile: "PLAN.md" },
    });
    expect(state.scope).toBe("src/");
    expect(state.goal).toBe("complete all items");
    expect(state.config.punchlistFile).toBe("PLAN.md");
  });

  it("persists stop conditions across save and load", () => {
    const state = createInitialState(id, "punchlist", "make progress", {
      maxIterations: 10,
      targetMetric: 0,
    });
    saveState(cwd, id, state);

    const loaded = loadState(cwd, id);
    expect(loaded!.maxIterations).toBe(10);
    expect(loaded!.targetMetric).toBe(0);
  });
});

describe("stall detection", () => {
  function result(overrides: Partial<IterationResult>): IterationResult {
    return { iteration: 1, timestamp: new Date().toISOString(), action: "log", ...overrides };
  }

  it("reports streak 0 on an empty log", () => {
    expect(stallStreak([])).toBe(0);
    expect(isStalled([])).toBe(false);
  });

  it("counts trailing identical changes+metric", () => {
    const r = result({ changes: "same tweak", metric: 1 });
    expect(stallStreak([r, r, r, result({ changes: "different", metric: 2 })])).toBe(1);
    expect(stallStreak([r, r, r])).toBe(3);
  });

  it("treats identical metric with different changes as progress", () => {
    const a = result({ changes: "tweak A", metric: 1 });
    const b = result({ changes: "tweak B", metric: 1 });
    expect(stallStreak([a, b, b])).toBe(2);
  });

  it("stalls only at or beyond the threshold", () => {
    const r = result({ changes: "same", metric: 5 });
    expect(isStalled([r, r])).toBe(false);
    expect(isStalled([r, r, r])).toBe(true);
  });

  it("uses hypothesis when changes are absent (log-path results)", () => {
    const a = result({ hypothesis: "h1", metric: 3 });
    const b = result({ hypothesis: "h1", metric: 3 });
    const c = result({ hypothesis: "h2", metric: 3 });
    expect(stallStreak([a, b, c])).toBe(1);
    expect(stallStreak([a, b])).toBe(2);
  });
});

describe("pendingContinue intent", () => {
  it("persists across save/load", () => {
    const state = createInitialState(id, "optimize", "make bench");
    state.pendingContinue = { reason: "auto-continue:loop-turn", queuedAt: new Date().toISOString() };
    saveState(cwd, id, state);

    const loaded = loadState(cwd, id);
    expect(loaded!.pendingContinue?.reason).toBe("auto-continue:loop-turn");
  });

  it("survives reconstructState (disk is the source of truth)", () => {
    const state = createInitialState(id, "optimize", "make bench");
    state.pendingContinue = { reason: "compaction-resume", queuedAt: new Date().toISOString() };
    appendResult(cwd, id, { iteration: 1, timestamp: new Date().toISOString(), action: "log", changes: "x", metric: 1 });
    state.iteration = 1;
    saveState(cwd, id, state);

    const rebuilt = reconstructState(cwd, id);
    expect(rebuilt!.pendingContinue?.reason).toBe("compaction-resume");
  });
});
