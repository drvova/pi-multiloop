import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sentinelCandidates, checkChampion, runSentinel } from "../extensions/pi-multiloop/sentinel.js";
import multiloopExtension from "../extensions/pi-multiloop/index.js";
import { registerLoop, type RegistryEntry } from "../extensions/pi-multiloop/lanes.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "multiloop-sentinel-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

interface ChampionOpts {
  lane: string;
  runTag: string;
  status: "completed" | "archived";
  bestMetric: number | null;
  verifyCommand?: string;
  metricDirection?: "lower" | "higher";
  keepMeasurements?: number[];
}

/** Write a finished run to disk the way archiveLoop leaves it: stateDir with state.json + results.jsonl, registry entry pointing at it. */
function champion(opts: ChampionOpts): RegistryEntry {
  const stateDir = join(".multiloop", "archive", `${opts.lane}-${opts.runTag}`);
  mkdirSync(join(cwd, stateDir), { recursive: true });
  writeFileSync(
    join(cwd, stateDir, "state.json"),
    JSON.stringify({
      lane: opts.lane,
      runTag: opts.runTag,
      mode: "optimize",
      status: opts.status === "archived" ? "archived" : "completed",
      verifyCommand: opts.verifyCommand,
      metricDirection: opts.metricDirection ?? "lower",
      bestMetric: opts.bestMetric,
    })
  );
  if (opts.keepMeasurements) {
    writeFileSync(
      join(cwd, stateDir, "results.jsonl"),
      JSON.stringify({
        iteration: 1,
        timestamp: new Date().toISOString(),
        action: "keep",
        metric: opts.bestMetric,
        measurements: opts.keepMeasurements,
      }) + "\n"
    );
  }
  const entry: RegistryEntry = {
    lane: opts.lane,
    runTag: opts.runTag,
    mode: "optimize",
    status: opts.status,
    startedAt: new Date().toISOString(),
    stateDir,
    verifyCommand: opts.verifyCommand,
  };
  registerLoop(cwd, entry);
  return entry;
}

describe("sentinelCandidates", () => {
  it("watches only completed/archived loops — live lanes measure themselves", () => {
    champion({ lane: "dead", runTag: "run-1", status: "completed", bestMetric: 1, verifyCommand: "echo 1" });
    champion({ lane: "resting", runTag: "run-1", status: "archived", bestMetric: 1, verifyCommand: "echo 1" });
    const candidates = sentinelCandidates([
      { lane: "live", runTag: "run-1", mode: "optimize", status: "active", startedAt: "", stateDir: "x" },
      { lane: "held", runTag: "run-1", mode: "optimize", status: "paused", startedAt: "", stateDir: "x" },
      ...JSON.parse(readFileSync(join(cwd, ".multiloop", "registry.json"), "utf-8")).loops,
    ]);
    expect(candidates.map((c) => c.lane).sort()).toEqual(["dead", "resting"]);
  });
});

describe("checkChampion", () => {
  it("holds when the fresh measurement lands inside the champion's noise band", () => {
    const entry = champion({ lane: "perf", runTag: "run-1", status: "completed", bestMetric: 1.42, verifyCommand: "echo 1.43", keepMeasurements: [1.4, 1.44] });
    const report = checkChampion(cwd, entry);
    expect(report.verdict).toBe("holds");
    expect(report.measured).toBe(1.43);
  });

  it("regresses when the world moved beyond 2x the champion's MAD", () => {
    const entry = champion({ lane: "perf", runTag: "run-1", status: "archived", bestMetric: 1.42, verifyCommand: "echo 1.87", keepMeasurements: [1.41, 1.43] });
    const report = checkChampion(cwd, entry);
    expect(report.verdict).toBe("regressed");
    expect(report.champion).toBe(1.42);
    expect(report.measured).toBe(1.87);
  });

  it("notices when the world improved beyond the band", () => {
    const entry = champion({ lane: "perf", runTag: "run-1", status: "completed", bestMetric: 1.42, verifyCommand: "echo 1.1", keepMeasurements: [1.41, 1.43] });
    expect(checkChampion(cwd, entry).verdict).toBe("improved");
  });

  it("treats any drift as significant for a deterministic champion (no recorded band)", () => {
    const entry = champion({ lane: "size", runTag: "run-1", status: "completed", bestMetric: 482, verifyCommand: "echo 483" });
    expect(checkChampion(cwd, entry).verdict).toBe("regressed");
  });

  it("respects a higher-is-better direction", () => {
    const entry = champion({ lane: "tput", runTag: "run-1", status: "completed", bestMetric: 900, verifyCommand: "echo 500", metricDirection: "higher", keepMeasurements: [899, 901] });
    expect(checkChampion(cwd, entry).verdict).toBe("regressed");
  });

  it("is unmeasurable when the verify command fails", () => {
    const entry = champion({ lane: "perf", runTag: "run-1", status: "completed", bestMetric: 1.42, verifyCommand: "exit 1" });
    const report = checkChampion(cwd, entry);
    expect(report.verdict).toBe("unmeasurable");
    expect(report.detail).toContain("verify command failed");
  });

  it("is unmeasurable when the verify output carries no number", () => {
    const entry = champion({ lane: "perf", runTag: "run-1", status: "completed", bestMetric: 1.42, verifyCommand: "echo broken" });
    expect(checkChampion(cwd, entry).detail).toBe("no numeric metric in verify output");
  });

  it("is unmeasurable when the run never recorded a champion metric", () => {
    const entry = champion({ lane: "perf", runTag: "run-1", status: "completed", bestMetric: null, verifyCommand: "echo 1.5" });
    expect(checkChampion(cwd, entry).detail).toBe("no champion metric recorded");
  });
});

describe("runSentinel", () => {
  it("says so plainly when the organism remembers nothing", () => {
    expect(runSentinel(cwd)).toContain("no completed or archived loops");
  });

  it("posts exactly one immune signal per regression to the shared knowledge board", () => {
    champion({ lane: "perf", runTag: "run-1", status: "archived", bestMetric: 1.42, verifyCommand: "echo 1.87", keepMeasurements: [1.41, 1.43] });
    champion({ lane: "quant", runTag: "run-2", status: "completed", bestMetric: 482, verifyCommand: "echo 482" });
    const report = runSentinel(cwd);
    expect(report).toContain("1 regressed");
    expect(report).toContain("REGRESSED  perf/run-1");
    expect(report).toContain("HOLDS  quant/run-2");
    const board = readFileSync(join(cwd, ".multiloop", "shared", "knowledge.md"), "utf-8");
    const lines = board.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("perf/run-1");
    expect(lines[0]).toContain("1.42 → 1.87");
    expect(lines[0]).toContain("Sentinel immune signal");
  });

  it("writes nothing to the board when every champion holds", () => {
    champion({ lane: "quant", runTag: "run-2", status: "completed", bestMetric: 482, verifyCommand: "echo 482" });
    runSentinel(cwd);
    expect(existsSync(join(cwd, ".multiloop", "shared", "knowledge.md"))).toBe(false);
  });

  it("narrows the sweep to one champion when targeted", () => {
    champion({ lane: "perf", runTag: "run-1", status: "completed", bestMetric: 1.42, verifyCommand: "echo 1.87", keepMeasurements: [1.41, 1.43] });
    champion({ lane: "quant", runTag: "run-2", status: "completed", bestMetric: 482, verifyCommand: "echo 999" });
    const report = runSentinel(cwd, "quant");
    expect(report).toContain("1 champion(s)");
    expect(report).toContain("quant/run-2");
    expect(report).not.toContain("perf/run-1");
  });

  it("names an unknown target instead of sweeping everything", () => {
    champion({ lane: "perf", runTag: "run-1", status: "completed", bestMetric: 1.42, verifyCommand: "echo 1.87", keepMeasurements: [1.41, 1.43] });
    expect(runSentinel(cwd, "nope")).toContain('no completed/archived champion matches "nope"');
    expect(existsSync(join(cwd, ".multiloop", "shared", "knowledge.md"))).toBe(false);
  });
});

describe("multiloop_sentinel tool", () => {
  it("is registered and runs the sweep from the tool surface", () => {
    const tools = new Map<string, { execute: (id: string, params: unknown, s: never, u: never, ctx: never) => Promise<{ content: { text: string }[] }> }>();
    const piStub = {
      registerTool: (def: { name: string; execute: never }) => tools.set(def.name, def as never),
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      on: () => {},
    };
    multiloopExtension(piStub as never);
    const sentinel = tools.get("multiloop_sentinel");
    expect(sentinel).toBeDefined();
    champion({ lane: "perf", runTag: "run-1", status: "archived", bestMetric: 1.42, verifyCommand: "echo 1.87", keepMeasurements: [1.41, 1.43] });
    return sentinel!.execute("call-1", {}, null as never, null as never, { cwd } as never).then((result) => {
      expect(result.content[0].text).toContain("REGRESSED  perf/run-1");
    });
  });
});
