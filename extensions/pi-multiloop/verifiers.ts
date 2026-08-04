import type { LoopState, VerificationCheck } from "./state.js";

export interface AcceptanceAssessment {
  checks: VerificationCheck[];
  checksPassed: boolean;
  acceptancePassed: boolean;
  acceptanceReason: string;
  recommendedAction: "keep" | "revert" | "log";
}

export function normalizeVerificationChecks(
  checks: VerificationCheck[] | undefined
): VerificationCheck[] {
  if (!Array.isArray(checks)) return [];
  return checks.map((check, index) => ({
    ...check,
    name: check.name?.trim() || `check-${index + 1}`,
    kind: check.kind?.trim() || undefined,
    command: check.command?.trim() || undefined,
    prompt: check.prompt?.trim() || undefined,
    evidence: check.evidence?.trim() || undefined,
    passed: Boolean(check.passed),
  }));
}

export function checksPassed(checks: VerificationCheck[]): boolean {
  return checks.every((check) => check.passed);
}

export function ensureRequiredChecks(
  state: Pick<LoopState, "guardCommand" | "promptVerifier">,
  checks: VerificationCheck[]
): VerificationCheck[] {
  const result = [...checks];
  const guardCommand = state.guardCommand?.trim();
  if (guardCommand) {
    const hasGuard = result.some((check) =>
      check.command?.trim() === guardCommand
    );
    if (!hasGuard) {
      result.push({
        name: "guard",
        kind: "guard",
        command: guardCommand,
        passed: false,
        evidence: "Configured guard was not reported to multiloop_measure.checks.",
      });
    }
  }

  const promptVerifier = state.promptVerifier?.trim();
  if (promptVerifier) {
    const hasPromptVerifier = result.some((check) =>
      check.prompt?.trim() === promptVerifier
    );
    if (!hasPromptVerifier) {
      result.push({
        name: "prompt verifier",
        kind: "prompt",
        prompt: promptVerifier,
        passed: false,
        evidence: "Configured prompt verifier was not reported to multiloop_measure.checks.",
      });
    }
  }

  return result;
}

/**
 * Resolve the acceptance mode a loop actually runs under.
 *
 * Only `keep-revert` lets the metric gate the decision; `log` records progress
 * and ignores `metricImproved` entirely. Callers that need to know whether the
 * metric matters must ask here rather than re-deriving the default.
 */
export function resolveAcceptanceMode(
  state: Pick<LoopState, "mode"> & Partial<Pick<LoopState, "acceptanceMode">>
): "log" | "keep-revert" {
  return state.acceptanceMode ?? (state.mode === "optimize" ? "keep-revert" : "log");
}

export function assessAcceptance(
  state: Pick<LoopState, "mode"> & Partial<Pick<LoopState, "acceptanceMode">>,
  metricImproved: boolean,
  checks: VerificationCheck[] | undefined
): AcceptanceAssessment {
  const normalized = normalizeVerificationChecks(checks);
  const allChecksPassed = checksPassed(normalized);
  const checksSummary = normalized.length === 0
    ? "no extra checks recorded"
    : allChecksPassed
      ? "all checks passed"
      : `failed checks: ${normalized.filter((check) => !check.passed).map((check) => check.name).join(", ")}`;

  const acceptanceMode = resolveAcceptanceMode(state);

  if (acceptanceMode === "log") {
    return {
      checks: normalized,
      checksPassed: allChecksPassed,
      acceptancePassed: allChecksPassed,
      acceptanceReason: checksSummary,
      recommendedAction: "log",
    };
  }

  const acceptancePassed = metricImproved && allChecksPassed;
  return {
    checks: normalized,
    checksPassed: allChecksPassed,
    acceptancePassed,
    acceptanceReason: `metric ${metricImproved ? "improved" : "did not improve"}; ${checksSummary}`,
    recommendedAction: acceptancePassed ? "keep" : "revert",
  };
}

/**
 * Refuse a keep/revert decision resting on too few measurements.
 *
 * A single noisy run is a coin flip, not a measurement (agent-eval variance is
 * dominated by seed noise), and "keep it if the score went up" re-applied across
 * iterations is uncontrolled adaptive multiple testing. But deterministic
 * metrics legitimately need one run, so the minimum is a per-loop pinned knob
 * (`minMeasurements`, default 1) rather than a universal constant — statistical
 * power decides, not a fixed number.
 *
 * When the count is short, the action degrades to `log`: record progress, do
 * not promote or roll back on noise, keep measuring. Only keep-revert loops
 * are gated; log-mode loops are untouched.
 */
export function enforceMinimumMeasurements(
  state: Pick<LoopState, "mode"> & Partial<Pick<LoopState, "acceptanceMode" | "minMeasurements">>,
  acceptance: AcceptanceAssessment,
  measurementCount: number
): AcceptanceAssessment {
  const minimum = state.minMeasurements ?? 1;
  if (resolveAcceptanceMode(state) !== "keep-revert" || measurementCount >= minimum) {
    return acceptance;
  }
  return {
    ...acceptance,
    acceptancePassed: false,
    recommendedAction: "log",
    acceptanceReason: `Insufficient measurements (${measurementCount}); this loop requires at least ${minimum} before keep/revert. Continue measuring.`,
  };
}

export function formatVerificationChecks(checks: VerificationCheck[]): string[] {
  if (checks.length === 0) return [];
  return checks.map((check) => {
    const parts = [
      `${check.passed ? "PASS" : "FAIL"} ${check.name}`,
      check.kind ? `type=${check.kind}` : undefined,
      check.command ? `command=\`${check.command}\`` : undefined,
      check.prompt ? `prompt=\`${check.prompt}\`` : undefined,
      check.evidence,
    ].filter((part): part is string => Boolean(part));
    return `  - ${parts.join(" | ")}`;
  });
}

/**
 * Flag a keep/revert decision that rests on a single measurement.
 *
 * One measurement gives MAD 0, so isImprovement falls back to a bare
 * `delta > 0`. That is correct for a deterministic metric — bundle size, LOC,
 * `open_or_partial_items` — and unjustified for a noisy one such as GPU timing
 * or training loss. Nothing in recorded state distinguishes the two cases, so
 * this warns rather than refuses: blocking would force pointless repeat runs on
 * the deterministic metrics multiloop ships by default.
 *
 * Worth surfacing because the error compounds rather than washing out. A keep
 * moves `currentMetric`, so a keep driven by jitter leaves the next iteration
 * needing to beat an optimistic outlier, and genuine gains start getting
 * reverted.
 *
 * Takes the loop state rather than a boolean so callers cannot mis-derive
 * whether the metric actually gates the decision.
 */
export function singleMeasurementAdvisory(
  state: Pick<LoopState, "mode"> & Partial<Pick<LoopState, "acceptanceMode">>,
  measurements: number[]
): string | null {
  if (resolveAcceptanceMode(state) !== "keep-revert") return null;
  if (measurements.length !== 1) return null;

  return [
    "Single measurement: no noise estimate, so this comparison is a bare better/worse test.",
    "Correct for a deterministic metric; if this metric is noisy, run verify 3+ times",
    "and call multiloop_measure with all values before keeping.",
  ].join(" ");
}
