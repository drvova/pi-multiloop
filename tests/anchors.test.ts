import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hashFile,
  MISSING_FILE_HASH,
  snapshotProtectedHashes,
  protectedFileCheck,
  auditVerifierCheck,
  revertVerifierCheck,
  pinnedConfigFields,
  pinnedFieldsChanged,
  configPinRefusal,
} from "../extensions/pi-multiloop/anchors.js";
import {
  createInitialState,
  saveState,
  loadState,
} from "../extensions/pi-multiloop/state.js";
import type { LaneId } from "../extensions/pi-multiloop/lanes.js";
import { laneFor, tmpPrefix } from "./support/seed.js";

let cwd: string;
const id: LaneId = laneFor("anchors");

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), tmpPrefix("anchors")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function anchoredState(protectedPaths: string[] = ["bench.mjs"], auditVerifier?: string) {
  const state = createInitialState(id, "optimize", "node bench.mjs", {
    guardCommand: "npm test",
    targetMetric: 10,
    protectedPaths,
    auditVerifier,
  });
  state.protectedBaseline = snapshotProtectedHashes(cwd, state.protectedPaths ?? []);
  state.pinnedConfig = pinnedConfigFields(state);
  return state;
}

describe("hashFile", () => {
  it("hashes file bytes and changes with content", () => {
    const path = join(cwd, "bench.mjs");
    writeFileSync(path, "baseline");
    const first = hashFile(path);
    writeFileSync(path, "changed");
    expect(hashFile(path)).not.toBe(first);
  });

  it("uses a sentinel for a missing file so appearing files count as changes", () => {
    expect(hashFile(join(cwd, "absent.mjs"))).toBe(MISSING_FILE_HASH);
    writeFileSync(join(cwd, "absent.mjs"), "now exists");
    expect(hashFile(join(cwd, "absent.mjs"))).not.toBe(MISSING_FILE_HASH);
  });
});

describe("snapshotProtectedHashes", () => {
  it("resolves repo-relative paths against cwd", () => {
    writeFileSync(join(cwd, "golden.txt"), "frozen");
    const snapshot = snapshotProtectedHashes(cwd, ["golden.txt"]);
    expect(snapshot["golden.txt"]).toBe(hashFile(join(cwd, "golden.txt")));
  });
});

describe("protectedFileCheck", () => {
  it("returns null when there is nothing to protect", () => {
    expect(protectedFileCheck(cwd, undefined, undefined)).toBeNull();
    expect(protectedFileCheck(cwd, [], {})).toBeNull();
  });

  it("returns null when no baseline exists yet", () => {
    expect(protectedFileCheck(cwd, ["golden.txt"], undefined)).toBeNull();
  });

  it("returns null when protected files are unchanged", () => {
    writeFileSync(join(cwd, "golden.txt"), "frozen");
    const state = anchoredState(["golden.txt"]);
    expect(protectedFileCheck(cwd, state.protectedPaths, state.protectedBaseline)).toBeNull();
  });

  it("fails when a protected file changes, naming it in evidence", () => {
    writeFileSync(join(cwd, "golden.txt"), "frozen");
    const state = anchoredState(["golden.txt"]);
    writeFileSync(join(cwd, "golden.txt"), "tuned to pass");
    const check = protectedFileCheck(cwd, state.protectedPaths, state.protectedBaseline);
    expect(check).not.toBeNull();
    expect(check?.name).toBe("protected-files");
    expect(check?.kind).toBe("mechanical");
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain("golden.txt");
  });

  it("fails when a protected file is deleted", () => {
    writeFileSync(join(cwd, "golden.txt"), "frozen");
    const state = anchoredState(["golden.txt"]);
    rmSync(join(cwd, "golden.txt"));
    expect(protectedFileCheck(cwd, state.protectedPaths, state.protectedBaseline)?.passed).toBe(false);
  });

  it("flags only the paths that changed", () => {
    writeFileSync(join(cwd, "a.txt"), "a");
    writeFileSync(join(cwd, "b.txt"), "b");
    const state = anchoredState(["a.txt", "b.txt"]);
    writeFileSync(join(cwd, "b.txt"), "b-tuned");
    const check = protectedFileCheck(cwd, state.protectedPaths, state.protectedBaseline);
    expect(check?.evidence).toContain("b.txt");
    expect(check?.evidence).not.toContain("a.txt");
  });
});

describe("pinnedConfigFields", () => {
  it("normalizes absent optional fields to null for a stable key set", () => {
    const state = createInitialState(id, "research", "echo 1");
    const fields = pinnedConfigFields(state);
    expect(fields.guardCommand).toBeNull();
    expect(fields.promptVerifier).toBeNull();
    expect(fields.auditVerifier).toBeNull();
    expect(fields.protectedPaths).toEqual([]);
    expect(Object.keys(fields).sort()).toEqual([
      "auditVerifier",
      "guardCommand",
      "maxIterations",
      "metricDirection",
      "metricName",
      "minMeasurements",
      "promptVerifier",
      "protectedPaths",
      "revertVerifier",
      "targetMetric",
      "verifyCommand",
    ]);
  });

  it("pins the audit verifier command when configured", () => {
    const state = anchoredState([], "node audit.mjs");
    expect(state.auditVerifier).toBe("node audit.mjs");
    expect(pinnedConfigFields(state).auditVerifier).toBe("node audit.mjs");
  });

  it("pins the revert verifier and min measurements when configured", () => {
    const state = createInitialState(id, "optimize", "echo 1");
    state.revertVerifier = "node revert-check.mjs";
    state.minMeasurements = 3;
    const fields = pinnedConfigFields(state);
    expect(fields.revertVerifier).toBe("node revert-check.mjs");
    expect(fields.minMeasurements).toBe(3);
  });
});

describe("pinnedFieldsChanged", () => {
  it("returns [] when no pin is stored", () => {
    expect(pinnedFieldsChanged(createInitialState(id, "optimize", "echo 1"))).toEqual([]);
  });

  it("returns [] when the pin holds", () => {
    const state = anchoredState();
    expect(pinnedFieldsChanged(state)).toEqual([]);
  });

  it("names the tampered verifier fields", () => {
    const state = anchoredState();
    state.verifyCommand = "node tuned-bench.mjs";
    expect(pinnedFieldsChanged(state)).toEqual(["verifyCommand"]);
    state.verifyCommand = "node bench.mjs";
    state.guardCommand = "npm test -- --skipped";
    expect(pinnedFieldsChanged(state)).toEqual(["guardCommand"]);
  });

  it("names stop-condition and protected-path tampering", () => {
    const state = anchoredState();
    state.targetMetric = 999;
    expect(pinnedFieldsChanged(state)).toEqual(["targetMetric"]);
    state.targetMetric = 10;
    state.protectedPaths = [];
    expect(pinnedFieldsChanged(state)).toEqual(["protectedPaths"]);
  });

  it("names audit-verifier tampering", () => {
    const state = anchoredState([], "node audit.mjs");
    state.auditVerifier = "node tuned-audit.mjs";
    expect(pinnedFieldsChanged(state)).toEqual(["auditVerifier"]);
  });
});

describe("auditVerifierCheck", () => {
  it("returns null when no audit command is configured", () => {
    expect(auditVerifierCheck(cwd, undefined, 42)).toBeNull();
    expect(auditVerifierCheck(cwd, "", 42)).toBeNull();
  });

  it("passes when the command output matches the reported median", () => {
    const check = auditVerifierCheck(cwd, 'node -e "console.log(42)"', 42);
    expect(check?.name).toBe("audit-verifier");
    expect(check?.kind).toBe("mechanical");
    expect(check?.passed).toBe(true);
    expect(check?.evidence).toContain("agreed");
    expect(check?.evidence).toContain("42");
  });

  it("tolerates float formatting noise within the relative tolerance", () => {
    const check = auditVerifierCheck(cwd, 'node -e "console.log(42.0000001)"', 42);
    expect(check?.passed).toBe(true);
  });

  it("fails when the reported median disagrees with ground truth", () => {
    const check = auditVerifierCheck(cwd, 'node -e "console.log(42)"', 15);
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain("disagreement");
    expect(check?.evidence).toContain("42");
    expect(check?.evidence).toContain("15");
  });

  it("fails when the command produces no numeric output", () => {
    const check = auditVerifierCheck(cwd, 'node -e "console.log(\'no numbers here\')"', 1);
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain("no numeric output");
  });

  it("fails loudly when the command errors", () => {
    const check = auditVerifierCheck(cwd, 'node -e "process.exit(1)"', 1);
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain("command failed");
  });
});

describe("revertVerifierCheck", () => {
  it("returns null when no revert command is configured", () => {
    expect(revertVerifierCheck(cwd, undefined, 42)).toBeNull();
    expect(revertVerifierCheck(cwd, "", 42)).toBeNull();
  });

  it("returns null when there is no baseline to restore against", () => {
    expect(revertVerifierCheck(cwd, "node -e \"console.log(42)\"", null)).toBeNull();
  });

  it("passes when the command output matches the pre-iteration value", () => {
    const check = revertVerifierCheck(cwd, 'node -e "console.log(42)"', 42);
    expect(check?.name).toBe("revert-verifier");
    expect(check?.kind).toBe("mechanical");
    expect(check?.passed).toBe(true);
    expect(check?.evidence).toContain("Rollback applied");
  });

  it("tolerates float formatting noise within the relative tolerance", () => {
    const check = revertVerifierCheck(cwd, 'node -e "console.log(42.0000001)"', 42);
    expect(check?.passed).toBe(true);
  });

  it("fails when the workspace was not restored to the baseline", () => {
    const check = revertVerifierCheck(cwd, 'node -e "console.log(42)"', 15);
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain("disagreement");
    expect(check?.evidence).toContain("42");
    expect(check?.evidence).toContain("15");
    expect(check?.evidence).toContain("not restored");
  });

  it("fails when the command produces no numeric output", () => {
    const check = revertVerifierCheck(cwd, 'node -e "console.log(\'no numbers here\')"', 1);
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain("no numeric output");
  });

  it("fails loudly when the command errors", () => {
    const check = revertVerifierCheck(cwd, 'node -e "process.exit(1)"', 1);
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain("command failed");
  });
});

describe("configPinRefusal", () => {
  it("returns null when the pin holds on disk", () => {
    const state = anchoredState();
    saveState(cwd, id, state);
    expect(configPinRefusal(cwd, id)).toBeNull();
  });

  it("returns null for unpinned legacy loops", () => {
    const state = createInitialState(id, "optimize", "echo 1");
    saveState(cwd, id, state);
    expect(configPinRefusal(cwd, id)).toBeNull();
  });

  it("refuses when state.json is edited behind the loop's back", () => {
    const state = anchoredState();
    saveState(cwd, id, state);

    // Simulate an agent editing the on-disk state file to weaken the guard.
    const edited = loadState(cwd, id)!;
    edited.verifyCommand = "node tuned-bench.mjs";
    saveState(cwd, id, edited);

    const refusal = configPinRefusal(cwd, id);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("verifyCommand");
    expect(refusal).toContain("Refusing to proceed.");
  });

  it("survives a save/load round trip (persisted pin)", () => {
    const state = anchoredState();
    saveState(cwd, id, state);
    const loaded = loadState(cwd, id)!;
    expect(loaded.protectedBaseline).toEqual(state.protectedBaseline);
    expect(loaded.pinnedConfig).toEqual(state.pinnedConfig);
    expect(pinnedFieldsChanged(loaded)).toEqual([]);
  });
});
