import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkStopCondition,
  completeIfStopConditionMet,
  resumeRefusalReason,
} from "../extensions/pi-multiloop/loop.js";
import { type LoopState, createInitialState } from "../extensions/pi-multiloop/state.js";
import type { LaneId } from "../extensions/pi-multiloop/lanes.js";
import { type Direction, oracleStopKind, oracleCompletes } from "./support/oracle.js";
import {
  RUN_HASH,
  laneFor,
  tmpPrefix,
  reproHint,
  seedFor,
  rng,
  intBetween,
  numberBetween,
} from "./support/seed.js";

/**
 * Exhaustive over *relations*, randomised over values.
 *
 * A grid of fixed constants only ever proves the implementation handles those
 * constants. Enumerating the relations instead -- iteration under/at/over the
 * cap, metric short of/exactly at/past the target -- keeps coverage complete
 * while every concrete number changes per run, so an implementation that
 * special-cases a particular value cannot hide.
 */

const id: LaneId = laneFor("sweep");

type CapRel = "none" | "under" | "at" | "over";
type TargetRel = "none" | "noMetric" | "notReached" | "exactly" | "reached";

const CAP_RELS: CapRel[] = ["none", "under", "at", "over"];
const TARGET_RELS: TargetRel[] = ["none", "noMetric", "notReached", "exactly", "reached"];
const DIRECTIONS: Direction[] = ["lower", "higher"];
const STATUSES = ["running", "paused", "completed", "stopped", "archived"] as const;

/** Distinct realisations drawn per relation combination. */
const REALISATIONS = 50;

interface Point {
  maxIterations?: number;
  iteration: number;
  targetMetric?: number;
  currentMetric: number | null;
  metricDirection: Direction;
  capRel: CapRel;
  targetRel: TargetRel;
}

function realise(
  next: () => number,
  capRel: CapRel,
  targetRel: TargetRel,
  metricDirection: Direction
): Point {
  // "over" needs room below the iteration counter for the cap to sit.
  const iteration = capRel === "over" ? intBetween(next, 1, 40) : intBetween(next, 0, 40);

  let maxIterations: number | undefined;
  switch (capRel) {
    case "none": maxIterations = undefined; break;
    case "under": maxIterations = iteration + intBetween(next, 1, 20); break;
    case "at": maxIterations = iteration; break;
    case "over": maxIterations = intBetween(next, 0, iteration - 1); break;
  }

  let targetMetric: number | undefined;
  let currentMetric: number | null;
  const anchor = numberBetween(next, -500, 500);
  // Distance from the target; kept strictly positive so the relation is exact.
  const gap = numberBetween(next, 0.25, 250) || 0.25;

  switch (targetRel) {
    case "none":
      targetMetric = undefined;
      currentMetric = anchor;
      break;
    case "noMetric":
      targetMetric = anchor;
      currentMetric = null;
      break;
    case "exactly":
      targetMetric = anchor;
      currentMetric = anchor;
      break;
    case "reached":
      targetMetric = anchor;
      currentMetric = metricDirection === "lower" ? anchor - gap : anchor + gap;
      break;
    case "notReached":
      targetMetric = anchor;
      currentMetric = metricDirection === "lower" ? anchor + gap : anchor - gap;
      break;
  }

  return { maxIterations, iteration, targetMetric, currentMetric, metricDirection, capRel, targetRel };
}

const POINTS: Point[] = [];
for (const capRel of CAP_RELS) {
  for (const targetRel of TARGET_RELS) {
    for (const metricDirection of DIRECTIONS) {
      const next = rng(seedFor(`sweep:${capRel}:${targetRel}:${metricDirection}`));
      for (let i = 0; i < REALISATIONS; i++) {
        POINTS.push(realise(next, capRel, targetRel, metricDirection));
      }
    }
  }
}

function build(point: Point, status: LoopState["status"] = "running"): LoopState {
  const state = createInitialState(id, "optimize", "bench", {
    metricDirection: point.metricDirection,
    metricName: "unit",
  });
  state.iteration = point.iteration;
  state.currentMetric = point.currentMetric;
  state.baseline = point.currentMetric;
  state.status = status;
  if (point.maxIterations !== undefined) state.maxIterations = point.maxIterations;
  if (point.targetMetric !== undefined) state.targetMetric = point.targetMetric;
  return state;
}

function label(point: Point): string {
  return [
    `cap:${point.capRel}`,
    `target:${point.targetRel}`,
    point.metricDirection,
    `[iter=${point.iteration} max=${point.maxIterations ?? "-"}`,
    `cur=${point.currentMetric ?? "null"} tgt=${point.targetMetric ?? "-"}]`,
  ].join(" ");
}

let cwd: string;
beforeAll(() => { cwd = mkdtempSync(join(tmpdir(), tmpPrefix("sweep"))); });
afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

describe(`exhaustive: generator realises the relation it claims (${reproHint()})`, () => {
  it("every point matches its own relation label", () => {
    for (const p of POINTS) {
      if (p.capRel === "none") expect(p.maxIterations).toBeUndefined();
      if (p.capRel === "under") expect(p.iteration).toBeLessThan(p.maxIterations!);
      if (p.capRel === "at") expect(p.iteration).toBe(p.maxIterations);
      if (p.capRel === "over") expect(p.iteration).toBeGreaterThan(p.maxIterations!);

      if (p.targetRel === "none") expect(p.targetMetric).toBeUndefined();
      if (p.targetRel === "noMetric") expect(p.currentMetric).toBeNull();
      if (p.targetRel === "exactly") expect(p.currentMetric).toBe(p.targetMetric);
      if (p.targetRel === "reached") {
        expect(p.metricDirection === "lower"
          ? p.currentMetric! < p.targetMetric!
          : p.currentMetric! > p.targetMetric!).toBe(true);
      }
      if (p.targetRel === "notReached") {
        expect(p.metricDirection === "lower"
          ? p.currentMetric! > p.targetMetric!
          : p.currentMetric! < p.targetMetric!).toBe(true);
      }
    }
  });

  it("covers every relation combination", () => {
    const seen = new Set(POINTS.map((p) => `${p.capRel}/${p.targetRel}/${p.metricDirection}`));
    expect(seen.size).toBe(CAP_RELS.length * TARGET_RELS.length * DIRECTIONS.length);
  });

  it("draws distinct values across runs", () => {
    // Guards against a seeding regression silently freezing the corpus.
    const distinct = new Set(POINTS.map((p) => `${p.iteration}:${p.currentMetric}:${p.targetMetric}`));
    expect(distinct.size).toBeGreaterThan(POINTS.length / 2);
    expect(RUN_HASH).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe(`exhaustive: checkStopCondition matches the independent oracle (${reproHint()})`, () => {
  it.each(POINTS.map((p) => [label(p), p] as const))("%s", (_name, point) => {
    expect(checkStopCondition(build(point))?.kind ?? null).toBe(oracleStopKind(point));
  });
});

describe(`exhaustive: resumeRefusalReason agrees with checkStopCondition (${reproHint()})`, () => {
  it.each(POINTS.map((p) => [label(p), p] as const))("%s", (_name, point) => {
    // Refusal must be exactly "the condition is still met" -- never broader, or
    // an escalation-stopped loop under its cap becomes unresumable.
    expect(resumeRefusalReason(build(point)) !== null).toBe(oracleStopKind(point) !== null);
  });
});

describe(`exhaustive: completeIfStopConditionMet respects loop status (${reproHint()})`, () => {
  const cases = POINTS.flatMap((p) =>
    STATUSES.map((status) => [`${label(p)} status=${status}`, p, status] as const)
  );

  it.each(cases)("%s", (_name, point, status) => {
    const state = build(point, status);
    const fired = completeIfStopConditionMet(cwd, id, state) !== null;

    expect(fired).toBe(oracleCompletes(point, status));
    expect(state.status).toBe(fired ? "completed" : status);
  });
});
