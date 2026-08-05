import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyDecision,
  applyLogIteration,
  establishBaseline,
  checkStopCondition,
  completeIfStopConditionMet,
  resumeRefusalReason,
} from "../extensions/pi-multiloop/loop.js";
import {
  type LoopState,
  type ResultAction,
  createInitialState,
  saveState,
  loadState,
  reconstructState,
  readResults,
} from "../extensions/pi-multiloop/state.js";
import { type LaneId, ensureLaneDir } from "../extensions/pi-multiloop/lanes.js";
import type { ConfidenceResult } from "../extensions/pi-multiloop/metrics.js";
import { oracleStopKind } from "./support/oracle.js";
import { laneFor, tmpPrefix, reproHint, seedFor, rng, pick, intBetween } from "./support/seed.js";

// Indices only name the cases; the values behind them are drawn from the run
// seed, so no two runs explore the same histories.
const PURE_CASES = Array.from({ length: 2000 }, (_, i) => i + 1);
const FS_CASES = Array.from({ length: 400 }, (_, i) => i + 1);

const DECIDE_ACTIONS = ["keep", "revert"] as const;
const LOG_ACTIONS: ResultAction[] = ["log", "skip", "crash", "blocked"];

function measurement(value: number): ConfidenceResult {
  return { median: value, mad: 1, confidence: "high", measurements: [value], isSignificant: true };
}

interface Plan {
  mode: "optimize" | "punchlist" | "research" | "dev";
  direction: "lower" | "higher";
  maxIterations?: number;
  targetMetric?: number;
  baseline: number;
  steps: Array<{ kind: "decide"; action: "keep" | "revert"; metric: number }
    | { kind: "log"; action: ResultAction; metric?: number }>;
}

function makePlan(index: number): Plan {
  const next = rng(seedFor("history", index));
  const mode = pick(next, ["optimize", "punchlist", "research", "dev"] as const);
  const direction = pick(next, ["lower", "higher"] as const);
  const useCap = next() < 0.55;
  const useTarget = next() < 0.55;
  const stepCount = intBetween(next, 0, 14);

  const steps: Plan["steps"] = [];
  for (let i = 0; i < stepCount; i++) {
    if (next() < 0.6) {
      steps.push({
        kind: "decide",
        action: pick(next, DECIDE_ACTIONS),
        metric: intBetween(next, 0, 20),
      });
    } else {
      const action = pick(next, LOG_ACTIONS);
      steps.push({
        kind: "log",
        action,
        metric: next() < 0.7 ? intBetween(next, 0, 20) : undefined,
      });
    }
  }

  return {
    mode,
    direction,
    maxIterations: useCap ? intBetween(next, 1, 8) : undefined,
    targetMetric: useTarget ? intBetween(next, 0, 20) : undefined,
    baseline: intBetween(next, 0, 20),
    steps,
  };
}

function newState(id: LaneId, plan: Plan): LoopState {
  const state = createInitialState(id, plan.mode, "verify", {
    metricDirection: plan.direction,
    metricName: "unit",
    maxIterations: plan.maxIterations,
    targetMetric: plan.targetMetric,
  });
  return state;
}

function snapshot(state: LoopState) {
  return {
    iteration: state.iteration,
    currentMetric: state.currentMetric,
    maxIterations: state.maxIterations,
    targetMetric: state.targetMetric,
    metricDirection: state.metricDirection,
  };
}

let cwd: string;
beforeAll(() => { cwd = mkdtempSync(join(tmpdir(), tmpPrefix("props"))); });
afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

describe(`property: a running loop never advances past its stop condition (${reproHint()})`, () => {
  it.each(FS_CASES)("case %i", (index) => {
    const plan = makePlan(index);
    const id: LaneId = laneFor("p", index);
    ensureLaneDir(cwd, id);

    let state = newState(id, plan);
    saveState(cwd, id, state);
    establishBaseline(cwd, id, state, plan.baseline);

    for (const step of plan.steps) {
      // A terminal loop must never be advanced again; the runtime enforces this
      // by dropping it from activeStates, so the generator honours it too.
      if (state.status !== "running") break;

      if (step.kind === "decide") {
        state = applyDecision(cwd, id, state, {
          action: step.action,
          reason: "generated",
          shouldEscalate: false,
        }, measurement(step.metric));
      } else {
        state = applyLogIteration(cwd, id, state, step.action, step.metric);
      }

      // INVARIANT: after every recorded iteration, running implies the stop
      // condition is unmet. This is the whole guarantee the feature exists for.
      if (state.status === "running") {
        expect(oracleStopKind(snapshot(state))).toBeNull();
      }
    }

    // INVARIANT: a loop is complete if and only if its condition is met.
    if (state.status === "completed") {
      expect(oracleStopKind(snapshot(state))).not.toBeNull();
    }
  });
});

describe(`property: persisted history agrees with the live snapshot (${reproHint()})`, () => {
  it.each(FS_CASES)("case %i", (index) => {
    const plan = makePlan(index);
    const id: LaneId = laneFor("h", index);
    ensureLaneDir(cwd, id);

    let state = newState(id, plan);
    saveState(cwd, id, state);
    establishBaseline(cwd, id, state, plan.baseline);

    for (const step of plan.steps) {
      if (state.status !== "running") break;
      state = step.kind === "decide"
        ? applyDecision(cwd, id, state, {
            action: step.action, reason: "generated", shouldEscalate: false,
          }, measurement(step.metric))
        : applyLogIteration(cwd, id, state, step.action, step.metric);
    }

    // INVARIANT: one appended result per completed iteration, never more.
    expect(readResults(cwd, id)).toHaveLength(state.iteration);

    // INVARIANT: the on-disk snapshot matches what the caller holds.
    const saved = loadState(cwd, id)!;
    expect(saved.iteration).toBe(state.iteration);
    expect(saved.status).toBe(state.status);
    expect(saved.maxIterations).toBe(state.maxIterations);
    expect(saved.targetMetric).toBe(state.targetMetric);

    // INVARIANT: rebuilding from results.jsonl reaches the same verdict.
    const rebuilt = reconstructState(cwd, id)!;
    expect(rebuilt.iteration).toBe(state.iteration);
    expect(checkStopCondition(rebuilt) !== null).toBe(checkStopCondition(state) !== null);
  });
});

describe(`property: completion is idempotent and terminal (${reproHint()})`, () => {
  it.each(PURE_CASES)("case %i", (index) => {
    const next = rng(seedFor("pure", index));
    const id: LaneId = laneFor("i");
    const state = createInitialState(id, "optimize", "bench", {
      metricDirection: pick(next, ["lower", "higher"] as const),
      maxIterations: next() < 0.5 ? intBetween(next, 0, 6) : undefined,
      targetMetric: next() < 0.5 ? intBetween(next, 0, 10) : undefined,
    });
    state.iteration = intBetween(next, 0, 10);
    state.currentMetric = next() < 0.85 ? intBetween(next, 0, 10) : null;

    const first = completeIfStopConditionMet(cwd, id, state);
    const statusAfterFirst = state.status;

    // INVARIANT: re-running the check never changes anything again.
    for (let i = 0; i < 3; i++) {
      const repeat = completeIfStopConditionMet(cwd, id, state);
      expect(repeat).toBeNull();
      expect(state.status).toBe(statusAfterFirst);
    }

    // INVARIANT: it fires exactly when the condition is met.
    expect(first !== null).toBe(oracleStopKind(state) !== null);
  });
});

describe(`property: an uncapped loop never self-completes (${reproHint()})`, () => {
  it.each(PURE_CASES)("case %i", (index) => {
    const next = rng(seedFor("pure", index));
    const id: LaneId = laneFor("u");
    const state = createInitialState(id, "optimize", "bench", {
      metricDirection: pick(next, ["lower", "higher"] as const),
    });
    state.iteration = intBetween(next, 0, 5000);
    state.currentMetric = intBetween(next, -1000, 1000);

    expect(checkStopCondition(state)).toBeNull();
    expect(completeIfStopConditionMet(cwd, id, state)).toBeNull();
    expect(resumeRefusalReason(state)).toBeNull();
    expect(state.status).toBe("running");
  });
});

describe(`property: JSON serialisation preserves the verdict (${reproHint()})`, () => {
  it.each(PURE_CASES)("case %i", (index) => {
    const next = rng(seedFor("pure", index));
    const id: LaneId = laneFor("j");
    const state = createInitialState(id, "punchlist", "count", {
      metricDirection: pick(next, ["lower", "higher"] as const),
      maxIterations: next() < 0.5 ? intBetween(next, 1, 9) : undefined,
      targetMetric: next() < 0.5 ? intBetween(next, 0, 9) : undefined,
    });
    state.iteration = intBetween(next, 0, 12);
    state.currentMetric = next() < 0.85 ? intBetween(next, 0, 12) : null;

    const revived: LoopState = JSON.parse(JSON.stringify(state));

    // INVARIANT: a state that survives state.json must decide identically.
    expect(checkStopCondition(revived)?.kind ?? null).toBe(checkStopCondition(state)?.kind ?? null);
    expect(resumeRefusalReason(revived)).toBe(resumeRefusalReason(state));
  });
});
