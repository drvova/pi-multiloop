/**
 * Independent reference model for pi-multiloop stop conditions.
 *
 * Written from the documented contract in README.md and docs/STATE.md, NOT by
 * reading loop.ts. The formulations are deliberately different from the
 * implementation -- subtraction and sign comparison rather than the direct
 * relational operators -- so an off-by-one or an inverted direction in either
 * file produces a disagreement instead of a matching mistake.
 *
 * Contract under test:
 *   1. maxIterations fires once the loop has completed at least that many
 *      iterations.
 *   2. targetMetric fires once the current metric has reached the target:
 *      at or below it when lower is better, at or above it when higher is.
 *   3. A target cannot fire before a metric exists.
 *   4. The iteration cap is reported first when both conditions hold.
 *   5. Completion only applies to a loop that is currently running.
 */

export type Direction = "lower" | "higher";
export type OracleKind = "max-iterations" | "target-metric";

export interface OracleInput {
  iteration: number;
  maxIterations?: number;
  currentMetric: number | null;
  targetMetric?: number;
  metricDirection: Direction;
}

/** Rule 1: expressed as a difference rather than a relational comparison. */
function capReached(input: OracleInput): boolean {
  if (input.maxIterations === undefined) return false;
  return input.iteration - input.maxIterations >= 0;
}

/** Rules 2 and 3: expressed as a signed distance to the target. */
function targetReached(input: OracleInput): boolean {
  if (input.targetMetric === undefined) return false;
  if (input.currentMetric === null) return false;

  const remaining = input.metricDirection === "lower"
    ? input.targetMetric - input.currentMetric
    : input.currentMetric - input.targetMetric;

  return remaining >= 0;
}

/** Rule 4. */
export function oracleStopKind(input: OracleInput): OracleKind | null {
  if (capReached(input)) return "max-iterations";
  if (targetReached(input)) return "target-metric";
  return null;
}

/** Rule 5. */
export function oracleCompletes(input: OracleInput, status: string): boolean {
  return status === "running" && oracleStopKind(input) !== null;
}

