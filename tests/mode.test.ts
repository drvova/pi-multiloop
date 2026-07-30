import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MODE_ENTRY_TYPE,
  type ModeEntryLike,
  classifyUserInput,
  latestModeDecision,
  shouldArmLoopMode,
  shouldQueueContinuation,
  shouldDisarmAfterLaneOperation,
} from "../extensions/pi-multiloop/mode.js";
import { collectRunningLoops } from "../extensions/pi-multiloop/index.js";
import { createInitialState, saveState } from "../extensions/pi-multiloop/state.js";
import { type LaneId, registerLoop, ensureLaneDir, laneDir } from "../extensions/pi-multiloop/lanes.js";
import { laneFor, tmpPrefix, reproHint, seedFor, rng, pick } from "./support/seed.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), tmpPrefix("mode"))); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

function entry(cwdValue: string, active: boolean): ModeEntryLike {
  return { type: "custom", customType: MODE_ENTRY_TYPE, data: { version: 1, cwd: cwdValue, active } };
}

function seedLoop(id: LaneId, status: "running" | "paused" | "stopped", registryStatus: "active" | "paused" | "completed") {
  const state = createInitialState(id, "optimize", "bench");
  state.status = status;
  ensureLaneDir(cwd, id);
  saveState(cwd, id, state);
  registerLoop(cwd, {
    lane: id.lane,
    runTag: id.runTag,
    mode: "optimize",
    status: registryStatus,
    startedAt: state.startedAt,
    stateDir: `.multiloop/active/${id.lane}/${id.runTag}`,
  });
}

describe("classifyUserInput", () => {
  it("treats slash commands as neutral so they cannot stall a running loop", () => {
    // This is the defect the verdict exists for: /multiloop status used to
    // disarm the loop and silently stop auto-continuation.
    for (const text of ["/multiloop status", "/multiloop ls", "/compact", "/tree", "/help"]) {
      expect(classifyUserInput(text)).toBe("neutral");
    }
  });

  it("treats an empty message as neutral", () => {
    expect(classifyUserInput("")).toBe("neutral");
    expect(classifyUserInput("   \n  ")).toBe("neutral");
  });

  it("arms on ordinary conversation", () => {
    for (const text of ["how is it going", "what is the current metric?", "keep going"]) {
      expect(classifyUserInput(text)).toBe("arm");
    }
  });

  it("suspends on an explicit request to stop the loop", () => {
    for (const text of [
      "stop the loop",
      "pause this loop please",
      "halt the multiloop",
      "loop should stop now",
      "suspend the iteration",
      "do not continue",
      "don't continue",
      "dont continue",
    ]) {
      expect(classifyUserInput(text)).toBe("suspend");
    }
  });

  it("does not suspend on unrelated uses of the words", () => {
    expect(classifyUserInput("the build stopped failing")).toBe("arm");
    expect(classifyUserInput("remove the unused import")).toBe("arm");
  });

  it("leaves /multiloop stop to its handler instead of disarming the session", () => {
    // stopLoop/pauseLoop are lane-scoped and clear session mode only when no
    // loop is left running. Classifying the command as a suspend here would
    // apply a session-global disarm first and kill every sibling lane.
    expect(classifyUserInput("/multiloop stop perf")).toBe("neutral");
    expect(classifyUserInput("/multiloop pause")).toBe("neutral");
  });

  it("does not treat a question about the loop as a request to stop it", () => {
    for (const text of [
      "why did the loop stop?",
      "did the iteration stop early?",
      "should I pause the loop?",
    ]) {
      expect(classifyUserInput(text)).not.toBe("suspend");
    }
  });

  it("does not suspend on a negated stop", () => {
    for (const text of [
      "the loop should not stop until tests pass",
      "don't stop the loop yet",
      "never pause the iteration",
    ]) {
      expect(classifyUserInput(text)).not.toBe("suspend");
    }
  });

  it("does not match a stop verb and a loop noun across sentence boundaries", () => {
    // Proximity matching is bounded to one sentence; otherwise any message that
    // mentions stopping something and later mentions the loop would suspend it.
    for (const text of [
      "please stop editing that file. the loop can keep running",
      "pause here for a second. what is the loop doing",
      "halt on errors. iteration count looks fine",
    ]) {
      expect(classifyUserInput(text)).toBe("arm");
    }
  });

  it("does not treat code instructions as loop control", () => {
    // remove/archive/delete are overwhelmingly about code, and they are already
    // slash subcommands when they mean the loop.
    for (const text of [
      "remove the loop guard",
      "archive the old iteration results",
      "delete the loop helper in utils",
    ]) {
      expect(classifyUserInput(text)).toBe("arm");
    }
  });
});

describe("latestModeDecision", () => {
  it("returns null when the session recorded nothing", () => {
    expect(latestModeDecision([], "/repo")).toBeNull();
    expect(latestModeDecision([{ type: "message" }], "/repo")).toBeNull();
  });

  it("returns the most recent decision, not the first", () => {
    expect(latestModeDecision([entry("/repo", true), entry("/repo", false)], "/repo")).toBe(false);
    expect(latestModeDecision([entry("/repo", false), entry("/repo", true)], "/repo")).toBe(true);
  });

  it("ignores decisions recorded for another cwd", () => {
    expect(latestModeDecision([entry("/other", false)], "/repo")).toBeNull();
    expect(latestModeDecision([entry("/other", false), entry("/repo", true)], "/repo")).toBe(true);
  });

  it("ignores entries of another custom type", () => {
    const foreign: ModeEntryLike = { type: "custom", customType: "something-else", data: { cwd: "/repo", active: false } };
    expect(latestModeDecision([foreign], "/repo")).toBeNull();
  });

  it("ignores malformed payloads instead of trusting them", () => {
    const bad: ModeEntryLike[] = [
      { type: "custom", customType: MODE_ENTRY_TYPE },
      { type: "custom", customType: MODE_ENTRY_TYPE, data: null },
      { type: "custom", customType: MODE_ENTRY_TYPE, data: { cwd: 7, active: true } },
      { type: "custom", customType: MODE_ENTRY_TYPE, data: { cwd: "/repo", active: "yes" } },
    ];
    expect(latestModeDecision(bad, "/repo")).toBeNull();
  });
});

describe("shouldArmLoopMode", () => {
  it("arms when a running loop is on disk and nothing was decided", () => {
    expect(shouldArmLoopMode({ hasRunningLoopOnDisk: true, recordedDecision: null })).toBe(true);
  });

  it("stays off with no running loop", () => {
    expect(shouldArmLoopMode({ hasRunningLoopOnDisk: false, recordedDecision: null })).toBe(false);
  });

  it("lets an explicit off survive a reload", () => {
    // The whole point of replaying the session branch: /multiloop off must not
    // snap back on after /tree, compaction, or a restart.
    expect(shouldArmLoopMode({ hasRunningLoopOnDisk: true, recordedDecision: false })).toBe(false);
  });

  it("lets an explicit on win even without a running loop yet", () => {
    expect(shouldArmLoopMode({ hasRunningLoopOnDisk: false, recordedDecision: true })).toBe(true);
  });
});

describe("shouldQueueContinuation", () => {
  const cases: Array<[boolean, boolean, boolean, boolean]> = [
    // loopMode, loopTurnActive, hasRunningStates, expected
    [true, true, true, true],
    [false, true, true, false],
    [true, false, true, false],
    [true, true, false, false],
    [false, false, false, false],
  ];

  it.each(cases)("mode=%s turn=%s running=%s -> %s", (loopMode, loopTurnActive, hasRunningStates, expected) => {
    expect(shouldQueueContinuation({ loopMode, loopTurnActive, hasRunningStates })).toBe(expected);
  });

  it("requires the per-turn flag so a chat-only turn cannot re-prompt itself forever", () => {
    expect(shouldQueueContinuation({ loopMode: true, loopTurnActive: false, hasRunningStates: true })).toBe(false);
  });
});

describe("shouldDisarmAfterLaneOperation", () => {
  it("keeps mode on while a sibling lane is still running", () => {
    // Pausing one lane must not silently stop every other lane on the worktree.
    expect(shouldDisarmAfterLaneOperation(1)).toBe(false);
    expect(shouldDisarmAfterLaneOperation(5)).toBe(false);
  });

  it("clears mode once the last loop is gone", () => {
    expect(shouldDisarmAfterLaneOperation(0)).toBe(true);
  });
});

describe("collectRunningLoops", () => {
  it("finds an active registry entry whose snapshot is running", () => {
    const id = laneFor("perf");
    seedLoop(id, "running", "active");
    const found = collectRunningLoops(cwd, new Set());
    expect(found).toHaveLength(1);
    expect(found[0].lane).toBe(id.lane);
  });

  it("skips loops already attached", () => {
    const id = laneFor("perf");
    seedLoop(id, "running", "active");
    expect(collectRunningLoops(cwd, new Set([`${id.lane}/${id.runTag}`]))).toHaveLength(0);
  });

  it("skips a registry entry that is not active", () => {
    const id = laneFor("perf");
    seedLoop(id, "running", "completed");
    expect(collectRunningLoops(cwd, new Set())).toHaveLength(0);
  });

  it("skips a snapshot that is not running even when the registry says active", () => {
    for (const status of ["paused", "stopped"] as const) {
      const id = laneFor(status === "paused" ? "pa" : "st");
      seedLoop(id, status, "active");
      expect(collectRunningLoops(cwd, new Set()).map((s) => s.lane)).not.toContain(id.lane);
    }
  });

  it("returns nothing when no registry exists", () => {
    expect(collectRunningLoops(cwd, new Set())).toEqual([]);
  });

  it("skips a corrupt snapshot instead of throwing", () => {
    // One unreadable lane must not stop a session from starting.
    const good = laneFor("good");
    const bad = laneFor("bad");
    seedLoop(good, "running", "active");
    seedLoop(bad, "running", "active");
    writeFileSync(join(laneDir(cwd, bad), "state.json"), "{ not json");

    const found = collectRunningLoops(cwd, new Set());
    expect(found).toHaveLength(1);
    expect(found[0].lane).toBe(good.lane);
  });

  it("attaches several lanes on one worktree", () => {
    const a = laneFor("a");
    const b = laneFor("b");
    seedLoop(a, "running", "active");
    seedLoop(b, "running", "active");
    expect(collectRunningLoops(cwd, new Set())).toHaveLength(2);
  });
});

describe(`property: input classification is total and stable (${reproHint()})`, () => {
  const CASES = Array.from({ length: 1500 }, (_, i) => i + 1);
  const WORDS = [
    "stop", "pause", "loop", "multiloop", "iteration", "work", "status", "metric",
    "please", "the", "now", "build", "remove", "continue", "don't", "/multiloop",
    "/compact", "keep", "going", "check", "halt", "archive",
  ];

  it.each(CASES)("case %i", (index) => {
    const next = rng(seedFor("classify", index));
    const length = 1 + Math.floor(next() * 6);
    const text = Array.from({ length }, () => pick(next, WORDS)).join(" ");

    const verdict = classifyUserInput(text);
    expect(["suspend", "arm", "neutral"]).toContain(verdict);
    // Deterministic: the same text always classifies the same way.
    expect(classifyUserInput(text)).toBe(verdict);
    // Whitespace and case must not change the verdict.
    expect(classifyUserInput(`  ${text.toUpperCase()}  `)).toBe(verdict);
  });
});
