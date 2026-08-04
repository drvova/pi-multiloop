import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hashFile,
  MISSING_FILE_HASH,
  snapshotProtectedHashes,
  protectedFileCheck,
  auditVerifierCheck,
  revertVerifierCheck,
  builtinRevertCheck,
  extractHash,
  workspaceDriftRefusal,
  captureBoundaryFingerprint,
  BUILTIN_FINGERPRINT_COMMAND,
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
  const H = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const G = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

  it("returns null when no revert command is configured", () => {
    expect(revertVerifierCheck(cwd, undefined, null, 42)).toBeNull();
    expect(revertVerifierCheck(cwd, "", null, 42)).toBeNull();
  });

  it("returns null in legacy mode when there is no baseline to restore against", () => {
    expect(revertVerifierCheck(cwd, 'node -e "console.log(42)"', undefined, null)).toBeNull();
  });

  it("passes when the current output reproduces the pre-change fingerprint exactly", () => {
    const check = revertVerifierCheck(cwd, `node -e "console.log('${H}')"`, H, null);
    expect(check?.name).toBe("revert-verifier");
    expect(check?.kind).toBe("mechanical");
    expect(check?.passed).toBe(true);
    expect(check?.evidence).toContain("Workspace restored exactly");
    expect(check?.evidence).toContain(H);
  });

  it("fails when the fingerprint does not match the pre-change state", () => {
    const check = revertVerifierCheck(cwd, `node -e "console.log('${G}')"`, H, null);
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain("disagreement");
    expect(check?.evidence).toContain(H);
    expect(check?.evidence).toContain(G);
    expect(check?.evidence).toContain("does not match its pre-change state");
  });

  it("fails when the current output carries no hash fingerprint", () => {
    const check = revertVerifierCheck(cwd, 'node -e "console.log(42)"', H, null);
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain("no hash fingerprint");
  });

  it("extracts the fingerprint hash case-insensitively from surrounding text", () => {
    const check = revertVerifierCheck(cwd, `node -e "console.log('HEAD is ${H.toUpperCase()} clean')"`, H, null);
    expect(check?.passed).toBe(true);
  });

  it("falls back to numeric comparison for legacy verifiers without a hash", () => {
    expect(revertVerifierCheck(cwd, 'node -e "console.log(42)"', "42", 42)?.passed).toBe(true);
    expect(revertVerifierCheck(cwd, 'node -e "console.log(42.0000001)"', "42", 42)?.passed).toBe(true);
    expect(revertVerifierCheck(cwd, 'node -e "console.log(42)"', "15", 15)?.passed).toBe(false);
  });

  it("fails when the command produces no numeric output in legacy mode", () => {
    const check = revertVerifierCheck(cwd, 'node -e "console.log(\'no numbers here\')"', "1", 1);
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain("no numeric output");
  });

  it("fails loudly when the command errors", () => {
    const check = revertVerifierCheck(cwd, 'node -e "process.exit(1)"', H, null);
    expect(check?.passed).toBe(false);
    expect(check?.evidence).toContain("command failed");
  });
});

describe("extractHash", () => {
  it("returns the first 64-hex token, lowercased", () => {
    const h = "ab12CD" + "0".repeat(58);
    expect(extractHash(`tree ${h} dirty`)).toBe(h.toLowerCase());
    expect(extractHash("no hash here")).toBeNull();
    expect(extractHash("abc123")).toBeNull();
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

describe("workspaceDriftRefusal", () => {
  it("allows the first iteration when no prior fingerprint exists", () => {
    expect(workspaceDriftRefusal(undefined, "abc123")).toBeNull();
    expect(workspaceDriftRefusal(null, "abc123")).toBeNull();
  });

  it("allows the iteration when the workspace fingerprint is unchanged", () => {
    expect(workspaceDriftRefusal("fp-v1", "fp-v1")).toBeNull();
  });

  it("treats an empty-string boundary (clean tree) as a real boundary", () => {
    expect(workspaceDriftRefusal("", "M tracked.txt")).toContain("Workspace changed");
    expect(workspaceDriftRefusal("", "M tracked.txt")).toContain("Live workspace state: M tracked.txt");
    expect(workspaceDriftRefusal("", "")).toBeNull();
  });

  it("refuses when the workspace changed since the last recorded boundary", () => {
    const refusal = workspaceDriftRefusal("fp-v1", "fp-v2");
    expect(refusal).toContain("Workspace changed since the last recorded boundary");
    expect(refusal).toContain("call multiloop_iterate first");
    expect(refusal).toContain("Live workspace state: fp-v2");
  });

  it("renders an explicit (clean) marker when the live state is empty", () => {
    expect(workspaceDriftRefusal("fp-v1", "")).toContain("Live workspace state: (clean)");
  });
});


describe("captureBoundaryFingerprint", () => {
  it("is best-effort without a verifier: null fingerprint when git is unavailable", () => {
    const result = captureBoundaryFingerprint(cwd, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fingerprint).toBeNull();
  });

  it("captures the built-in git working-tree fingerprint in a git repo", () => {
    const repo = mkdtempSync(join(tmpdir(), tmpPrefix("gitfp")));
    try {
      execSync("git init -q", { cwd: repo });
      execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m seed", { cwd: repo });
      writeFileSync(join(repo, "tracked.txt"), "v1");
      execSync("git add tracked.txt", { cwd: repo });
      execSync("git -c user.email=t@t -c user.name=t commit -q -m add", { cwd: repo });
      const clean = captureBoundaryFingerprint(repo, undefined);
      expect(clean.ok).toBe(true);
      if (clean.ok) expect(clean.fingerprint).toBe("");

      writeFileSync(join(repo, "tracked.txt"), "v2");
      const dirty = captureBoundaryFingerprint(repo, undefined);
      expect(dirty.ok).toBe(true);
      if (dirty.ok) expect(dirty.fingerprint).toBe("M tracked.txt");

      writeFileSync(join(repo, "untracked.txt"), "artifact");
      const stillTrackedOnly = captureBoundaryFingerprint(repo, undefined);
      expect(stillTrackedOnly.ok).toBe(true);
      if (stillTrackedOnly.ok) expect(stillTrackedOnly.fingerprint).toBe("M tracked.txt");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("captures a trimmed hash fingerprint from a runnable verifier", () => {
    const result = captureBoundaryFingerprint(cwd, 'node -e "process.stdout.write(\'  abcdef  \\n\')"');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fingerprint).toBe("abcdef");
  });

  it("refuses loudly when the verifier cannot run", () => {
    const result = captureBoundaryFingerprint(cwd, "node -e 'process.exit(1)'");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});

describe("builtinRevertCheck", () => {
  const makeRepo = () => {
    const repo = mkdtempSync(join(tmpdir(), tmpPrefix("rvrepo")));
    execSync("git init -q", { cwd: repo });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m seed", { cwd: repo });
    writeFileSync(join(repo, "tracked.txt"), "v1");
    execSync("git add tracked.txt", { cwd: repo });
    execSync("git -c user.email=t@t -c user.name=t commit -q -m add", { cwd: repo });
    return repo;
  };

  it("returns null when there is no pre-change fingerprint", () => {
    expect(builtinRevertCheck(cwd, null)).toBeNull();
    expect(builtinRevertCheck(cwd, undefined)).toBeNull();
  });

  it("passes when the tracked working tree matches the pre-change fingerprint", () => {
    const repo = makeRepo();
    try {
      const pre = captureBoundaryFingerprint(repo, undefined);
      expect(pre.ok).toBe(true);
      if (!pre.ok || pre.fingerprint === null) throw new Error("no fingerprint");
      const check = builtinRevertCheck(repo, pre.fingerprint);
      expect(check?.passed).toBe(true);
      expect(check?.name).toBe("revert-verifier");
      if (check) expect(check.evidence).toContain("agreed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a revert when the tree drifted from the pre-change fingerprint", () => {
    const repo = makeRepo();
    try {
      const pre = captureBoundaryFingerprint(repo, undefined);
      expect(pre.ok).toBe(true);
      if (!pre.ok || pre.fingerprint === null) throw new Error("no fingerprint");
      writeFileSync(join(repo, "tracked.txt"), "v2");
      const check = builtinRevertCheck(repo, pre.fingerprint);
      expect(check?.passed).toBe(false);
      if (check) {
        expect(check.evidence).toContain("disagreement");
        expect(check.evidence).toContain("M tracked.txt");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
