import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decide,
  applyDecision,
  completeIfStopConditionMet,
} from "../extensions/pi-multiloop/loop.js";
import {
  createInitialState,
  saveState,
  loadState,
} from "../extensions/pi-multiloop/state.js";
import { assessConfidence } from "../extensions/pi-multiloop/metrics.js";
import { readMessages } from "../extensions/pi-multiloop/mesh.js";
import {
  ensureLaneDir,
  registerLoop,
  laneDir,
  updateLoopStatus,
  type LaneId,
} from "../extensions/pi-multiloop/lanes.js";
import { laneFor, tmpPrefix } from "./support/seed.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), tmpPrefix("homeostasis")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeLane(id: LaneId, options: Parameters<typeof createInitialState>[3] = {}) {
  ensureLaneDir(cwd, id);
  const state = createInitialState(id, "optimize", "echo 1", {
    metricDirection: "lower",
    ...options,
  });
  saveState(cwd, id, state);
  registerLoop(cwd, {
    lane: id.lane,
    runTag: id.runTag,
    mode: "optimize",
    status: "active",
    stateDir: laneDir(cwd, id),
    startedAt: new Date().toISOString(),
  });
  return state;
}

describe("convergence broadcast (swarm homeostasis)", () => {
  it("notifies every active sibling when the target metric is reached", () => {
    const winner = laneFor("quant");
    const siblingA = laneFor("perf");
    const siblingB = laneFor("size");
    const state = makeLane(winner, { targetMetric: 5, metricDirection: "lower" });
    makeLane(siblingA);
    makeLane(siblingB);

    state.iteration = 7;
    state.currentMetric = 4; // <= target 5 with direction lower
    const stop = completeIfStopConditionMet(cwd, winner, state);

    expect(stop?.kind).toBe("target-metric");
    const inboxA = readMessages(cwd, siblingA);
    const inboxB = readMessages(cwd, siblingB);
    expect(inboxA).toHaveLength(1);
    expect(inboxB).toHaveLength(1);
    expect(inboxA[0].body).toContain("CONVERGED");
    expect(inboxA[0].body).toContain(`${winner.lane}/${winner.runTag}`);
    expect(inboxA[0].body).toContain("iteration 7");
    // The winner's own mailbox stays empty: a lane never broadcasts to itself.
    expect(readMessages(cwd, winner)).toHaveLength(0);
  });

  it("does not broadcast on iteration-cap completion", () => {
    const capped = laneFor("capped");
    const sibling = laneFor("sibling");
    const state = makeLane(capped, { maxIterations: 3 });
    makeLane(sibling);

    state.iteration = 3;
    const stop = completeIfStopConditionMet(cwd, capped, state);

    expect(stop?.kind).toBe("max-iterations");
    expect(readMessages(cwd, sibling)).toHaveLength(0);
  });

  it("does not broadcast to siblings that are no longer active", () => {
    const winner = laneFor("winner");
    const done = laneFor("done");
    const state = makeLane(winner, { targetMetric: 10, metricDirection: "higher" });
    makeLane(done);
    // Sibling already completed: no mailbox write for a dead lane.
    updateLoopStatus(cwd, done, "completed");

    state.iteration = 2;
    state.currentMetric = 10;
    completeIfStopConditionMet(cwd, winner, state);

    expect(readMessages(cwd, done)).toHaveLength(0);
  });

  it("fires exactly once even if completion is re-evaluated", () => {
    const winner = laneFor("once");
    const sibling = laneFor("observer");
    const state = makeLane(winner, { targetMetric: 1, metricDirection: "lower" });
    makeLane(sibling);

    state.iteration = 1;
    state.currentMetric = 1;
    completeIfStopConditionMet(cwd, winner, state);
    // Re-entry on an already-completed loop is a no-op (status guard).
    const again = completeIfStopConditionMet(cwd, winner, state);

    expect(again).toBeNull();
    expect(readMessages(cwd, sibling)).toHaveLength(1);
  });
});

describe("confidence gate (jidoka for noisy measurements)", () => {
  it("downgrades a low-confidence improvement from keep to log", () => {
    const state = makeLane(laneFor("noisy"), { metricDirection: "lower" });
    // One sample → assessConfidence reports low confidence.
    const measurement = assessConfidence([80]);
    expect(measurement.confidence).toBe("low");

    const decision = decide(state, measurement, 100);

    expect(decision.action).toBe("log");
    expect(decision.reason).toContain("confidence is low");
    expect(decision.reason).toContain("Remeasure");
  });

  it("keeps a high-confidence improvement", () => {
    const state = makeLane(laneFor("solid"), { metricDirection: "lower" });
    const measurement = assessConfidence([79, 80, 80, 81, 80]);
    expect(measurement.confidence).toBe("high");

    const decision = decide(state, measurement, 100);

    expect(decision.action).toBe("keep");
  });

  it("still reverts a low-confidence non-improvement", () => {
    const state = makeLane(laneFor("regress"), { metricDirection: "lower" });
    const measurement = assessConfidence([150]);
    expect(measurement.confidence).toBe("low");

    const decision = decide(state, measurement, 100);

    // Revert is the safe direction: the gate protects keeps, not reverts.
    expect(decision.action).toBe("revert");
  });

  it("a gated iteration records as log and never updates bestMetric", () => {
    const id = laneFor("gated");
    const state = makeLane(id, { metricDirection: "lower" });
    state.baseline = 100;
    state.currentMetric = 100;
    const measurement = assessConfidence([80]);
    const decision = decide(state, measurement, 100);

    applyDecision(cwd, id, state, decision, measurement, "too good to trust", "tweak");

    const persisted = loadState(cwd, id);
    expect(persisted?.bestMetric).toBeNull();
    expect(persisted?.currentMetric).toBe(80); // log still records the reading
  });
});
