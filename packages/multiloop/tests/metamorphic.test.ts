import { describe, it, expect } from "vitest";
import { checkStopCondition, resumeRefusalReason } from "../extensions/pi-multiloop/loop.js";
import { type LoopState, createInitialState } from "../extensions/pi-multiloop/state.js";
import type { LaneId } from "../extensions/pi-multiloop/lanes.js";
import { laneFor, reproHint, seedFor, rng, pick, intBetween } from "./support/seed.js";

/**
 * Metamorphic relations: properties that must hold *between* related inputs.
 *
 * These catch a class no single-point or sequence test can. An implementation
 * consistently wrong in the same direction still agrees with a single-point
 * oracle if the oracle shares the misreading, but it cannot preserve all of
 * these relations at once.
 */

const id: LaneId = laneFor("meta");
const CASES = Array.from({ length: 1500 }, (_, i) => i + 1);

function base(label: string, index: number): { state: LoopState; next: () => number } {
  const next = rng(seedFor(label, index));
  const state = createInitialState(id, "optimize", "bench", {
    metricDirection: pick(next, ["lower", "higher"] as const),
    metricName: "unit",
  });
  state.iteration = intBetween(next, 0, 20);
  state.currentMetric = intBetween(next, -50, 50);
  return { state, next };
}

function fires(state: LoopState): boolean {
  return checkStopCondition(state) !== null;
}

describe(`metamorphic: raising an iteration cap never completes a loop sooner (${reproHint()})`, () => {
  it.each(CASES)("case %i", (index) => {
    const { state, next } = base("cap-monotonic", index);
    const cap = intBetween(next, 0, 20);
    const raised = cap + intBetween(next, 1, 15);

    state.maxIterations = cap;
    const firedAtCap = fires(state);
    state.maxIterations = raised;
    const firedAtRaised = fires(state);

    // Monotonicity: if a larger budget stops the loop, the smaller one must too.
    if (firedAtRaised) expect(firedAtCap).toBe(true);
  });
});

describe(`metamorphic: advancing the iteration counter is one-way (${reproHint()})`, () => {
  it.each(CASES)("case %i", (index) => {
    const { state, next } = base("iteration-one-way", index);
    state.maxIterations = intBetween(next, 0, 20);
    delete state.targetMetric;

    const start = intBetween(next, 0, 20);
    let seen = false;
    for (let i = start; i <= start + 12; i++) {
      state.iteration = i;
      const now = fires(state);
      // Once a cap fires it can never un-fire as iterations accumulate.
      if (seen) expect(now).toBe(true);
      seen ||= now;
    }
  });
});

describe(`metamorphic: direction is a mirror, not a special case (${reproHint()})`, () => {
  it.each(CASES)("case %i", (index) => {
    const { state, next } = base("direction-mirror", index);
    delete state.maxIterations;
    const metric = intBetween(next, -50, 50);
    const target = intBetween(next, -50, 50);

    state.metricDirection = "lower";
    state.currentMetric = metric;
    state.targetMetric = target;
    const lower = fires(state);

    // Negating both operands and flipping direction must give the identical
    // verdict; any asymmetry between the two branches breaks this.
    state.metricDirection = "higher";
    state.currentMetric = -metric;
    state.targetMetric = -target;
    const higher = fires(state);

    expect(higher).toBe(lower);
  });
});

describe(`metamorphic: a looser target never completes sooner (${reproHint()})`, () => {
  it.each(CASES)("case %i", (index) => {
    const { state, next } = base("target-looseness", index);
    delete state.maxIterations;
    state.metricDirection = "lower";
    state.currentMetric = intBetween(next, -50, 50);

    const strict = intBetween(next, -50, 50);
    const loose = strict + intBetween(next, 1, 20);

    state.targetMetric = strict;
    const firedStrict = fires(state);
    state.targetMetric = loose;
    const firedLoose = fires(state);

    // Lower-is-better: a higher target is easier, so it must fire at least
    // whenever the stricter one does.
    if (firedStrict) expect(firedLoose).toBe(true);
  });
});

describe(`metamorphic: removing a condition can only relax the verdict (${reproHint()})`, () => {
  it.each(CASES)("case %i", (index) => {
    const { state, next } = base("condition-removal", index);
    state.maxIterations = intBetween(next, 0, 20);
    state.targetMetric = intBetween(next, -50, 50);

    const both = fires(state);
    const withCap = { ...state, targetMetric: undefined };
    const withTarget = { ...state, maxIterations: undefined };
    const neither = { ...state, maxIterations: undefined, targetMetric: undefined };

    // Firing with both configured requires at least one of them to fire alone.
    if (both) expect(fires(withCap) || fires(withTarget)).toBe(true);
    // Dropping every condition must always yield an unbounded loop.
    expect(fires(neither as LoopState)).toBe(false);
  });
});

describe(`metamorphic: refusal tracks the condition exactly (${reproHint()})`, () => {
  it.each(CASES)("case %i", (index) => {
    const { state, next } = base("refusal-tracks", index);
    state.maxIterations = next() < 0.5 ? intBetween(next, 0, 20) : undefined;
    state.targetMetric = next() < 0.5 ? intBetween(next, -50, 50) : undefined;
    state.status = pick(next, ["running", "paused", "completed", "stopped", "archived"] as const);

    // Refusal must depend on the stop condition alone. Gating it on status too
    // would make escalation-stopped loops permanently unresumable.
    expect(resumeRefusalReason(state) !== null).toBe(fires(state));
  });
});
