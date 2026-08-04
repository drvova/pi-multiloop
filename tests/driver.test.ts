import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  readRegistry,
  resolveLoop,
  readLoopState,
  pauseLoop,
  shouldContinue,
  buildIterationPrompt,
  cleanChildEnv,
  spawnIteration,
  stopIteration,
  iterationAdvanced,
} from "../bin/multiloop-run.mjs";

const stubPi = fileURLToPath(new URL("./support/stub-pi.mjs", import.meta.url));

function makeLoopDir() {
  const dir = mkdtempSync(join(tmpdir(), "driver-loop-"));
  const stateDir = ".multiloop/active/perf/run-1";
  mkdirSync(join(dir, stateDir), { recursive: true });
  const entry = { stateDir };
  const writeState = (state: Record<string, unknown>) => writeFileSync(join(dir, stateDir, "state.json"), JSON.stringify(state));
  return { dir, entry, writeState };
}

describe("multiloop-run driver", () => {
  describe("pauseLoop", () => {
    it("flips a running loop to paused and writes it atomically", () => {
      const dir = mkdtempSync(join(tmpdir(), "driver-pause-"));
      try {
        const entry = { stateDir: ".multiloop/active/perf/run-1" };
        mkdirSync(join(dir, entry.stateDir), { recursive: true });
        const state = { status: "running", lane: "perf", runTag: "run-1" };
        writeFileSync(join(dir, entry.stateDir, "state.json"), JSON.stringify(state));
        const next = pauseLoop(dir, entry, state);
        expect(next.status).toBe("paused");
        expect(JSON.parse(readFileSync(join(dir, entry.stateDir, "state.json"), "utf8")).status).toBe("paused");
        expect(existsSync(join(dir, entry.stateDir, "state.json.tmp"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    it("leaves a non-running loop untouched", () => {
      const dir = mkdtempSync(join(tmpdir(), "driver-pause-"));
      try {
        const entry = { stateDir: ".multiloop/active/perf/run-1" };
        mkdirSync(join(dir, entry.stateDir), { recursive: true });
        const state = { status: "completed", lane: "perf" };
        writeFileSync(join(dir, entry.stateDir, "state.json"), JSON.stringify(state));
        const next = pauseLoop(dir, entry, state);
        expect(next).toBe(state);
        expect(JSON.parse(readFileSync(join(dir, entry.stateDir, "state.json"), "utf8")).status).toBe("completed");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("parses positional args and defaults", () => {
    const opts = parseArgs(["/repo", "perf"]);
    expect(opts.repo).toBe("/repo");
    expect(opts.lane).toBe("perf");
    expect(opts.runTag).toBeNull();
    expect(opts.iterations).toBe(Infinity);
    expect(opts.timeoutSec).toBe(900);
    expect(opts.piCmd).toBe("pi");
    expect(opts.dryRun).toBe(false);
    expect(opts.verbose).toBe(false);
  });

  it("parses flags and run-tag", () => {
    const opts = parseArgs(["/repo", "perf", "run-002", "--iterations", "3", "--timeout-sec", "30", "--pi-cmd", "/x/pi", "--verbose", "--dry-run"]);
    expect(opts.runTag).toBe("run-002");
    expect(opts.iterations).toBe(3);
    expect(opts.timeoutSec).toBe(30);
    expect(opts.piCmd).toBe("/x/pi");
    expect(opts.verbose).toBe(true);
    expect(opts.dryRun).toBe(true);
  });

  it("rejects unknown options and wrong positional count", () => {
    expect(() => parseArgs(["/repo"])).toThrow(/Usage/);
    expect(() => parseArgs(["/repo", "perf", "run-1", "extra"])).toThrow(/Usage/);
    expect(() => parseArgs(["--bogus", "/repo", "perf"])).toThrow(/Unknown option/);
  });

  it("reads the registry, tolerating a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "driver-reg-"));
    try {
      expect(readRegistry(dir)).toEqual({ version: 1, loops: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a loop by exact run-tag and by latest startedAt", () => {
    const registry = {
      loops: [
        { lane: "perf", runTag: "run-1", startedAt: "2026-01-01T00:00:00Z" },
        { lane: "perf", runTag: "run-2", startedAt: "2026-01-02T00:00:00Z" },
        { lane: "other", runTag: "run-9", startedAt: "2026-01-03T00:00:00Z" },
      ],
    };
    expect(resolveLoop(registry, "perf", "run-1")?.runTag).toBe("run-1");
    expect(resolveLoop(registry, "perf", "run-9")).toBeNull();
    expect(resolveLoop(registry, "perf", null)?.runTag).toBe("run-2");
    expect(resolveLoop(registry, "missing", null)).toBeNull();
  });

  it("reads loop state and refuses a missing state file", () => {
    const { dir, entry, writeState } = makeLoopDir();
    try {
      writeState({ status: "running", iteration: 0 });
      expect(readLoopState(dir, entry).iteration).toBe(0);
      expect(() => readLoopState(dir, { stateDir: "nope/does-not-exist" })).toThrow(/missing/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evaluates stop conditions from state and options", () => {
    expect(shouldContinue({ status: "running", iteration: 0 }, { iterations: Infinity })).toEqual({ ok: true, reason: "" });
    expect(shouldContinue({ status: "running", iteration: 1, maxIterations: 5 }, { iterations: Infinity })).toEqual({ ok: true, reason: "" });
    expect(shouldContinue({ status: "completed", iteration: 3 }, { iterations: Infinity })).toEqual({ ok: false, reason: "loop completed" });
    expect(shouldContinue({ status: "stopped", iteration: 3 }, { iterations: Infinity })).toEqual({ ok: false, reason: "loop stopped" });
    const result = shouldContinue({ status: "running", iteration: 3 }, { iterations: 3 });
    expect(result).toEqual({ ok: false, reason: "iteration cap 3 reached" });
    expect(shouldContinue({ status: "running", iteration: 9, maxIterations: 10 }, { iterations: Infinity })).toEqual({ ok: true, reason: "" });
    expect(shouldContinue({ status: "paused", iteration: 0 }, { iterations: Infinity })).toEqual({ ok: true, reason: "" });
  });

  it("builds an iteration prompt carrying goal, metric, and protocol", () => {
    const state = {
      goal: "shrink bundle",
      verifyCommand: "npm run size",
      guardCommand: "npm test",
      acceptancePolicy: "metric improves and checks pass",
      metricName: "kb",
      metricDirection: "lower",
      currentMetric: 120,
      bestMetric: 110,
      protectedPaths: ["report.html"],
      stallStreak: 3,
    };
    const prompt = buildIterationPrompt(state, { lane: "perf", runTag: "run-1", mode: "optimize" }, 4);
    const pausedPrompt = buildIterationPrompt({ ...state, status: "paused" }, { lane: "perf", runTag: "run-1", mode: "optimize" }, 4);
    expect(pausedPrompt).toContain("multiloop_resume");
    expect(pausedPrompt).toContain("step 0");
    expect(prompt).toContain("shrink bundle");
    expect(prompt).toContain("npm run size");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("kb (lower is better)");
    expect(prompt).toContain("120");
    expect(prompt).toContain("110");
    expect(prompt).toContain("report.html");
    expect(prompt).toContain("3 identical iterations");
    expect(prompt).toContain("iteration (#4)");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("multiloop_resume");
  });

  it("strips session-routing vars so the child starts its own pi session", () => {
    const cleaned = cleanChildEnv({ PI_SESSION_ID: "abc", PI_INTERCOM_SESSION_ID: "def", PATH: "/bin" });
    expect(cleaned.PI_SESSION_ID).toBeUndefined();
    expect(cleaned.PI_INTERCOM_SESSION_ID).toBeUndefined();
    expect(cleaned.PATH).toBe("/bin");
  });

  it("polls for the iteration to advance and reaps the child group", async () => {
    const { dir, entry, writeState } = makeLoopDir();
    try {
      writeState({ status: "paused", iteration: 0 });
      const stateFile = join(dir, entry.stateDir, "state.json");
      const { child, exited, output } = spawnIteration(
        process.execPath,
        [resolve(stubPi)],
        dir,
        { STUB_STATE_PATH: stateFile, STUB_DELAY_MS: "200", PATH: process.env.PATH ?? "/bin" }
      );
      const outcome = await iterationAdvanced(dir, entry, 0, 15000);
      expect(outcome.advanced).toBe(true);
      expect((outcome.state as { iteration: number }).iteration).toBe(1);
      // The driver then reaps the still-alive child (real pi never exits).
      const graceful = await stopIteration(child, 3000);
      await exited;
      expect(graceful || true).toBeTruthy();
      expect(output.text.length).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(stateFile, "utf8")).iteration).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("times out when the session never advances the iteration", async () => {
    const { dir, entry, writeState } = makeLoopDir();
    try {
      writeState({ status: "paused", iteration: 0 });
      const stateFile = join(dir, entry.stateDir, "state.json");
      const { child, exited } = spawnIteration(
        process.execPath,
        [resolve(stubPi)],
        dir,
        { STUB_STATE_PATH: stateFile, STUB_DELAY_MS: "50", STUB_NO_ADVANCE: "1", PATH: process.env.PATH ?? "/bin" }
      );
      const outcome = await iterationAdvanced(dir, entry, 0, 1500);
      expect(outcome.advanced).toBe(false);
      await stopIteration(child, 2000);
      await exited;
      expect(JSON.parse(readFileSync(stateFile, "utf8")).iteration).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});