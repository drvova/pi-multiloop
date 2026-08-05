import { describe, expect, it } from "vitest";
import {
  assessAcceptance,
  enforceMinimumMeasurements,
  ensureRequiredChecks,
  formatVerificationChecks,
  normalizeVerificationChecks,
  resolveAcceptanceMode,
  singleMeasurementAdvisory,
} from "../extensions/pi-multiloop/verifiers.js";

describe("compound verifier acceptance", () => {
  it("keeps optimize iterations only when metric improves and all checks pass", () => {
    const result = assessAcceptance({ mode: "optimize" }, true, [
      { name: "correctness", kind: "mechanical", passed: true, command: "npm test" },
      { name: "output review", kind: "prompt", passed: true, evidence: "matches expected semantics" },
    ]);

    expect(result.acceptancePassed).toBe(true);
    expect(result.recommendedAction).toBe("keep");
    expect(result.acceptanceReason).toContain("metric improved");
    expect(result.acceptanceReason).toContain("all checks passed");
  });

  it("rejects optimize iterations when prompt correctness fails despite metric improvement", () => {
    const result = assessAcceptance({ mode: "optimize" }, true, [
      { name: "prompt correctness", kind: "prompt", passed: false, evidence: "output omitted required section" },
    ]);

    expect(result.acceptancePassed).toBe(false);
    expect(result.recommendedAction).toBe("revert");
    expect(result.acceptanceReason).toContain("metric improved");
    expect(result.acceptanceReason).toContain("failed checks: prompt correctness");
  });

  it("rejects optimize iterations when metric does not improve even if checks pass", () => {
    const result = assessAcceptance({ mode: "optimize" }, false, [
      { name: "correctness", passed: true },
    ]);

    expect(result.acceptancePassed).toBe(false);
    expect(result.recommendedAction).toBe("revert");
    expect(result.acceptanceReason).toContain("metric did not improve");
  });

  it("logs research/dev/punchlist iterations while preserving check pass status", () => {
    const result = assessAcceptance({ mode: "research" }, true, [
      { name: "candidate review", kind: "prompt", passed: false },
    ]);
    const punchlist = assessAcceptance({ mode: "punchlist", acceptanceMode: "log" }, false, [
      { name: "progress metric", kind: "mechanical", passed: true },
    ]);

    expect(result.recommendedAction).toBe("log");
    expect(result.acceptancePassed).toBe(false);
    expect(punchlist.recommendedAction).toBe("log");
    expect(punchlist.acceptancePassed).toBe(true);
  });

  it("allows explicit keep/revert acceptance for punchlist optimization loops", () => {
    const result = assessAcceptance({ mode: "punchlist", acceptanceMode: "keep-revert" }, true, [
      { name: "tests", passed: true },
    ]);

    expect(result.recommendedAction).toBe("keep");
    expect(result.acceptancePassed).toBe(true);
  });

  it("adds failing checks for configured guard/prompt verifiers that are not reported", () => {
    const checks = ensureRequiredChecks({
      guardCommand: "npm test",
      promptVerifier: "Review output semantics.",
    }, []);

    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ name: "guard", kind: "guard", command: "npm test", passed: false });
    expect(checks[1]).toMatchObject({ name: "prompt verifier", kind: "prompt", prompt: "Review output semantics.", passed: false });
  });

  it("does not add required checks when reported verdicts cover them", () => {
    const checks = ensureRequiredChecks({
      guardCommand: "npm test",
      promptVerifier: "Review output semantics.",
    }, [
      { name: "tests", kind: "mechanical", command: "npm test", passed: true },
      { name: "semantic review", kind: "prompt", prompt: "Review output semantics.", passed: true },
    ]);

    expect(checks).toHaveLength(2);
    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it("does not treat unrelated mechanical checks as the configured guard", () => {
    const checks = ensureRequiredChecks({
      guardCommand: "npm test",
    }, [
      { name: "lint", kind: "mechanical", command: "npm run lint", passed: true },
    ]);

    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ name: "lint", passed: true });
    expect(checks[1]).toMatchObject({ name: "guard", command: "npm test", passed: false });
  });

  it("requires the configured prompt verifier to be reported explicitly", () => {
    const checks = ensureRequiredChecks({
      promptVerifier: "Review output semantics.",
    }, [
      { name: "generic prompt review", kind: "prompt", passed: true },
    ]);

    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ name: "generic prompt review", passed: true });
    expect(checks[1]).toMatchObject({ name: "prompt verifier", prompt: "Review output semantics.", passed: false });
  });

  it("normalizes missing names and formats evidence", () => {
    const checks = normalizeVerificationChecks([
      { name: " ", kind: " prompt ", passed: true, prompt: "  compare output  ", evidence: " ok " },
    ]);

    expect(checks[0]).toMatchObject({ name: "check-1", kind: "prompt", prompt: "compare output", evidence: "ok" });
    expect(formatVerificationChecks(checks)[0]).toContain("PASS check-1");
    expect(formatVerificationChecks(checks)[0]).toContain("prompt=`compare output`");
  });
});

describe("resolveAcceptanceMode", () => {
  it("defaults optimize to keep-revert and every other mode to log", () => {
    expect(resolveAcceptanceMode({ mode: "optimize" })).toBe("keep-revert");
    for (const mode of ["punchlist", "research", "dev"]) {
      expect(resolveAcceptanceMode({ mode })).toBe("log");
    }
  });

  it("honours an explicit acceptance mode over the default", () => {
    expect(resolveAcceptanceMode({ mode: "optimize", acceptanceMode: "log" })).toBe("log");
    expect(resolveAcceptanceMode({ mode: "punchlist", acceptanceMode: "keep-revert" })).toBe("keep-revert");
  });
});

describe("singleMeasurementAdvisory", () => {
  it("warns when one measurement decides a keep/revert", () => {
    const note = singleMeasurementAdvisory({ mode: "optimize" }, [42]);
    expect(note).toContain("Single measurement");
    expect(note).toContain("bare better/worse test");
    expect(note).toContain("run verify 3+ times");
  });

  it("stays quiet once the metric carries a noise estimate", () => {
    expect(singleMeasurementAdvisory({ mode: "optimize" }, [42, 43])).toBeNull();
    expect(singleMeasurementAdvisory({ mode: "optimize" }, [42, 43, 41, 44, 42])).toBeNull();
  });

  it("stays quiet in log modes, where the metric does not gate the decision", () => {
    for (const mode of ["punchlist", "research", "dev"]) {
      expect(singleMeasurementAdvisory({ mode }, [42])).toBeNull();
    }
  });

  it("follows the acceptance mode, not the loop mode", () => {
    // A punchlist run with a real optimization goal does gate on the metric.
    expect(singleMeasurementAdvisory({ mode: "punchlist", acceptanceMode: "keep-revert" }, [42])).not.toBeNull();
    // An optimize run configured for progress logging does not.
    expect(singleMeasurementAdvisory({ mode: "optimize", acceptanceMode: "log" }, [42])).toBeNull();
  });

  it("does not fire for an empty measurement list, which measure rejects earlier", () => {
    expect(singleMeasurementAdvisory({ mode: "optimize" }, [])).toBeNull();
  });
});

describe("enforceMinimumMeasurements", () => {
  const keep = () =>
    assessAcceptance({ mode: "optimize" }, true, []);

  it("leaves acceptance untouched when the count meets the minimum", () => {
    const acceptance = keep();
    expect(enforceMinimumMeasurements({ mode: "optimize", minMeasurements: 3 }, acceptance, 3)).toBe(acceptance);
    expect(enforceMinimumMeasurements({ mode: "optimize" }, acceptance, 1)).toBe(acceptance);
  });

  it("degrades keep/revert to log when the loop is undersampled", () => {
    const enforced = enforceMinimumMeasurements(
      { mode: "optimize", minMeasurements: 3 },
      keep(),
      1
    );
    expect(enforced.recommendedAction).toBe("log");
    expect(enforced.acceptancePassed).toBe(false);
    expect(enforced.acceptanceReason).toContain("Insufficient measurements");
    expect(enforced.acceptanceReason).toContain("3");
  });

  it("does not touch log-mode loops, where the metric never gates", () => {
    const logAcceptance = assessAcceptance({ mode: "research" }, true, []);
    expect(enforceMinimumMeasurements({ mode: "research", minMeasurements: 3 }, logAcceptance, 1)).toBe(logAcceptance);
  });

  it("defaults the minimum to one, preserving deterministic fast paths", () => {
    const acceptance = keep();
    expect(enforceMinimumMeasurements({ mode: "optimize" }, acceptance, 1)).toBe(acceptance);
  });
});
