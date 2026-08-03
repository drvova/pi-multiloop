import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type ModeEntryLike,
  MODE_ENTRY_TYPE,
  classifyUserInput,
  latestModeDecision,
  shouldArmLoopMode,
  shouldQueueContinuation,
  shouldDisarmAfterLaneOperation,
} from "../extensions/pi-multiloop/mode.js";
import { collectRunningLoops } from "../extensions/pi-multiloop/index.js";
import {
  type LoopState,
  createInitialState,
  saveState,
  loadState,
  readResults,
  stallStreak,
} from "../extensions/pi-multiloop/state.js";
import { applyLogIteration, establishBaseline } from "../extensions/pi-multiloop/loop.js";
import { type LaneId, registerLoop, updateLoopStatus, ensureLaneDir } from "../extensions/pi-multiloop/lanes.js";
import { laneFor, tmpPrefix, reproHint, seedFor, rng, pick, intBetween } from "./support/seed.js";

/**
 * Session simulator.
 *
 * Mirrors the handler wiring in index.ts: session_start arms mode from the
 * recorded decision plus disk, input reclassifies, tools set the per-turn flag,
 * and agent_end asks whether to continue. Composition only -- every decision
 * below is the production function.
 *
 * What this cannot prove is that index.ts still calls these; that gap is closed
 * by the type signatures and covered explicitly in the mutation sweep.
 */
class Session {
  loopMode = false;
  loopTurnActive = false;
  continuations = 0;
  readonly attached = new Set<string>();

  constructor(
    readonly cwd: string,
    /** Persists across sessions, as pi's session branch does. */
    readonly branch: ModeEntryLike[]
  ) {}

  private record(active: boolean): void {
    this.loopMode = active;
    this.branch.push({ type: "custom", customType: MODE_ENTRY_TYPE, data: { version: 1, cwd: this.cwd, active } });
  }

  /** pi.on("session_start") */
  start(): this {
    const found = collectRunningLoops(this.cwd, this.attached);
    for (const state of found) this.attached.add(`${state.lane}/${state.runTag}`);
    this.loopMode = shouldArmLoopMode({
      hasRunningLoopOnDisk: this.attached.size > 0,
      recordedDecision: latestModeDecision(this.branch, this.cwd),
    });
    // Mirrors index.ts: an armed mode queues a continuation for the first
    // turn; the durable flag is marked at queue time and cleared at delivery,
    // so a later start re-arms via the owed branch only if nothing delivered.
    if (this.loopMode && this.runningCount() > 0) {
      this.queueContinuation("session-start");
      return this;
    }
    const owed = this.owedCount();
    if (owed.length > 0) {
      this.queueContinuation(owed[0].reason);
    }
    return this;
  }

  /** Count attached running lanes still carrying a durable continuation intent. */
  owedCount(): { reason: string }[] {
    const owed: { reason: string }[] = [];
    for (const key of this.attached) {
      const [lane, runTag] = key.split("/");
      const state = loadState(this.cwd, { lane, runTag });
      if (state?.status === "running" && state.pendingContinue) owed.push(state.pendingContinue);
    }
    return owed;
  }

  /** queueLoopAutoContinue: mark the durable intent, count the queued follow-up. */
  private queueContinuation(reason: string): void {
    for (const key of this.attached) {
      const [lane, runTag] = key.split("/");
      const state = loadState(this.cwd, { lane, runTag });
      if (state?.status !== "running") continue;
      state.pendingContinue = { reason, queuedAt: new Date().toISOString() };
      saveState(this.cwd, { lane, runTag }, state);
    }
    this.continuations++;
  }

  /** Simulate the follow-up send succeeding: delivery clears the flag. */
  deliverContinuation(): this {
    this.clearOwed();
    return this;
  }

  /** Simulate process death between queue and delivery (flag already on disk). */
  crashBeforeDelivery(): this {
    return this;
  }

  private clearOwed(): void {
    for (const key of this.attached) {
      const [lane, runTag] = key.split("/");
      const state = loadState(this.cwd, { lane, runTag });
      if (!state?.pendingContinue) continue;
      delete state.pendingContinue;
      saveState(this.cwd, { lane, runTag }, state);
    }
  }

  /** pi.on("input") for a non-extension message */
  input(text: string): this {
    switch (classifyUserInput(text)) {
      case "suspend":
        this.loopMode = false;
        this.loopTurnActive = false;
        this.clearOwed();
        break;
      case "arm":
        if (this.runningCount() > 0) this.loopTurnActive = true;
        break;
      case "neutral":
        break;
    }
    return this;
  }

  /** Any multiloop_* tool calling markLoopTurn(). */
  toolCall(): this {
    this.loopTurnActive = true;
    return this;
  }

  /** multiloop_start / multiloop_resume */
  armViaTool(): this {
    this.record(true);
    return this;
  }

  /** /multiloop off — session-scoped, so it forces mode off outright. */
  disarmViaCommand(): this {
    this.record(false);
    this.loopTurnActive = false;
    this.clearOwed();
    return this;
  }

  /** pauseLoop/stopLoop — lane-scoped, so it only clears mode when nothing is left. */
  endLane(id: LaneId, status: "paused" | "stopped"): this {
    const state = loadState(this.cwd, id)!;
    state.status = status;
    if (status === "paused") this.clearOwed();
    saveState(this.cwd, id, state);
    updateLoopStatus(this.cwd, id, status === "paused" ? "paused" : "completed");
    this.attached.delete(`${id.lane}/${id.runTag}`);
    if (shouldDisarmAfterLaneOperation(this.runningCount())) this.record(false);
    return this;
  }

  /** pi.on("agent_end") */
  endTurn(): this {
    const ended = this.loopTurnActive;
    this.loopTurnActive = false;
    if (shouldQueueContinuation({
      loopMode: this.loopMode,
      loopTurnActive: ended,
      hasRunningStates: this.runningCount() > 0,
    })) {
      // Mirrors queueLoopAutoContinue: queue marks the durable intent;
      // delivery clears it.
      this.queueContinuation("auto-continue:loop-turn");
    }
    return this;
  }

  runningCount(): number {
    let n = 0;
    for (const key of this.attached) {
      const [lane, runTag] = key.split("/");
      const state = loadState(this.cwd, { lane, runTag });
      if (state?.status === "running") n++;
    }
    return n;
  }
}

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), tmpPrefix("sessions"))); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

function startLoopOnDisk(id: LaneId, options: { maxIterations?: number; targetMetric?: number } = {}): LoopState {
  const state = createInitialState(id, "punchlist", "count", {
    metricName: "open_items",
    metricDirection: "lower",
    ...options,
  });
  ensureLaneDir(cwd, id);
  saveState(cwd, id, state);
  registerLoop(cwd, {
    lane: id.lane,
    runTag: id.runTag,
    mode: "punchlist",
    status: "active",
    startedAt: state.startedAt,
    stateDir: `.multiloop/active/${id.lane}/${id.runTag}`,
  });
  return state;
}

describe("session lifecycle: the copied-session case", () => {
  it("a fresh session picks up a running loop without any command", () => {
    const id = laneFor("perf");
    startLoopOnDisk(id);

    const branch: ModeEntryLike[] = [];
    const second = new Session(cwd, branch).start();

    expect(second.loopMode).toBe(true);
    expect(second.attached.size).toBe(1);
    expect(second.continuations).toBe(1);
  });

  it("a fresh session in a repo with no loops stays off", () => {
    const fresh = new Session(cwd, []).start();
    expect(fresh.loopMode).toBe(false);
    expect(fresh.continuations).toBe(0);
  });

  it("a fresh session ignores a loop the previous session stopped", () => {
    const id = laneFor("perf");
    const state = startLoopOnDisk(id);
    state.status = "stopped";
    saveState(cwd, id, state);
    updateLoopStatus(cwd, id, "completed");

    expect(new Session(cwd, []).start().loopMode).toBe(false);
  });
});

describe("session lifecycle: explicit decisions win", () => {
  it("off survives a reload instead of snapping back on", () => {
    const id = laneFor("perf");
    startLoopOnDisk(id);

    const branch: ModeEntryLike[] = [];
    new Session(cwd, branch).start().disarmViaCommand();

    // Reload: same disk state, same branch.
    const reloaded = new Session(cwd, branch).start();
    expect(reloaded.loopMode).toBe(false);
    expect(reloaded.continuations).toBe(0);
  });

  it("on after off re-arms and survives the next reload", () => {
    const id = laneFor("perf");
    startLoopOnDisk(id);
    const branch: ModeEntryLike[] = [];

    new Session(cwd, branch).start().disarmViaCommand().armViaTool();
    expect(new Session(cwd, branch).start().loopMode).toBe(true);
  });
});

describe("session lifecycle: a slash command must not stall the loop", () => {
  it("keeps continuing after /multiloop status", () => {
    const id = laneFor("perf");
    startLoopOnDisk(id);
    const session = new Session(cwd, []).start();
    const before = session.continuations;

    session.input("/multiloop status").toolCall().endTurn();

    expect(session.loopMode).toBe(true);
    expect(session.continuations).toBe(before + 1);
  });

  it("keeps continuing across several unrelated slash commands", () => {
    const id = laneFor("perf");
    startLoopOnDisk(id);
    const session = new Session(cwd, []).start();

    for (const cmd of ["/multiloop ls", "/compact", "/tree", "/help"]) {
      session.input(cmd).toolCall().endTurn();
    }
    expect(session.loopMode).toBe(true);
    expect(session.continuations).toBe(5);
  });

  it("still stops when the user asks in words", () => {
    const id = laneFor("perf");
    startLoopOnDisk(id);
    const session = new Session(cwd, []).start();

    session.input("stop the loop").toolCall().endTurn();
    expect(session.loopMode).toBe(false);
    expect(session.continuations).toBe(1); // only the session-start one
  });

  it("stops via the /multiloop stop handler, not via input classification", () => {
    // The input layer stays neutral; stopLoop owns the semantics so a lane-
    // scoped stop cannot disarm the session while siblings are still running.
    const id = laneFor("perf");
    startLoopOnDisk(id);
    const session = new Session(cwd, []).start();

    session.input("/multiloop stop perf");
    expect(session.loopMode).toBe(true);          // input alone changes nothing

    session.endLane(id, "stopped");               // the handler runs
    expect(session.loopMode).toBe(false);          // last lane gone -> mode clears
    expect(session.runningCount()).toBe(0);
  });
});

describe("session lifecycle: a chat-only turn cannot self-perpetuate", () => {
  it("does not continue when no tool ran and the user said nothing", () => {
    const id = laneFor("perf");
    startLoopOnDisk(id);
    const session = new Session(cwd, []).start();
    const before = session.continuations;

    session.endTurn();                 // agent chatted, no tool
    session.endTurn();                 // and again
    expect(session.continuations).toBe(before);
  });
});

describe("session lifecycle: completion ends continuation", () => {
  it("stops continuing once the stop condition completes the loop", () => {
    const id = laneFor("plan");
    const state = startLoopOnDisk(id, { targetMetric: 0 });
    establishBaseline(cwd, id, state, 3);

    const session = new Session(cwd, []).start();
    expect(session.loopMode).toBe(true);

    applyLogIteration(cwd, id, state, "log", 0);   // hits the target, completes
    expect(loadState(cwd, id)!.status).toBe("completed");

    const before = session.continuations;
    session.toolCall().endTurn();
    expect(session.continuations).toBe(before);    // no running states left
  });
});

describe(`long horizon: a 60-turn session never continues without cause (${reproHint()})`, () => {
  // 120 x 60 turns = 7,200 simulated turns against a real filesystem; the
  // corpus differs every run, so coverage accumulates across runs rather than
  // being bought once with a slower suite.
  const CASES = Array.from({ length: 120 }, (_, i) => i + 1);

  it.each(CASES)("case %i", (index) => {
    const next = rng(seedFor("session", index));
    const id = laneFor("lh", index);
    startLoopOnDisk(id, { maxIterations: 200 });
    const state = loadState(cwd, id)!;
    establishBaseline(cwd, id, state, 50);

    const branch: ModeEntryLike[] = [];
    const session = new Session(cwd, branch).start();

    const inputs = ["/multiloop status", "/compact", "how is it going", "", "stop the loop", "/tree"];
    let expectedMode = session.loopMode;

    for (let turn = 0; turn < 60; turn++) {
      if (next() < 0.4) {
        const text = pick(next, inputs);
        session.input(text);
        const verdict = classifyUserInput(text);
        if (verdict === "suspend") expectedMode = false;
      }

      const ranTool = next() < 0.7;
      if (ranTool) {
        session.toolCall();
        applyLogIteration(cwd, id, state, "log", intBetween(next, 1, 60));
      }

      const running = session.runningCount() > 0;
      const shouldContinue = expectedMode && session.loopTurnActive && running;
      const before = session.continuations;
      session.endTurn();

      // INVARIANT: continuation happens exactly when all three conditions hold.
      expect(session.continuations).toBe(before + (shouldContinue ? 1 : 0));
      // INVARIANT: mode only ever changes through an explicit decision.
      expect(session.loopMode).toBe(expectedMode);
    }

    // INVARIANT: a suspended session stays suspended across a reload.
    if (!expectedMode && branch.length > 0) {
      expect(new Session(cwd, branch).start().loopMode).toBe(false);
    }
  });
});

describe(`long horizon: durable intent and stall bookkeeping survive 60 turns (${reproHint()})`, () => {
  // Second long horizon. The first proves continuation is cause-gated; this
  // one proves the durable-intent flag and the stall streak survive crashes,
  // restarts, and disarm without drifting from their invariants.
  const CASES = Array.from({ length: 80 }, (_, i) => i + 1);

  it.each(CASES)("case %i", (index) => {
    const next = rng(seedFor("durable", index));
    const id = laneFor("dur", index);
    startLoopOnDisk(id, { maxIterations: 200 });
    const state = loadState(cwd, id)!;
    establishBaseline(cwd, id, state, 50);

    const branch: ModeEntryLike[] = [];
    let session = new Session(cwd, branch).start();
    let expectedMode = session.loopMode;

    const inputs = ["/multiloop status", "/compact", "how is it going", "", "stop the loop", "/tree"];

    // INVARIANT: pendingContinue survives a crash and stays owed until
    // delivery, and a session_start that would otherwise stay off re-arms it.
    for (let turn = 0; turn < 60; turn++) {
      if (next() < 0.25 && expectedMode) {
        // Crash between queueing and delivery: the flag is on disk and the
        // follow-up never sent. A fresh process with armed mode re-queues
        // exactly one continuation at start (its own first-turn queue); the
        // durable flag persists until delivery.
        session.crashBeforeDelivery();
        session = new Session(cwd, branch).start();
        expect(session.continuations).toBe(1);
        expect(session.owedCount().length).toBe(1);
        session.deliverContinuation();
        expect(session.owedCount().length).toBe(0);
      }

      if (next() < 0.15) {
        // Explicit disarm must drop the durable intent: a later crash
        // replay cannot resurrect the continuation.
        session.disarmViaCommand();
        expect(session.owedCount().length).toBe(0);
        session = new Session(cwd, branch).start();
        expect(session.loopMode).toBe(false);
        expect(session.continuations).toBe(0);
        expectedMode = false;
      }

      const ranTool = next() < 0.7;
      if (ranTool) {
        session.toolCall();
        // Repeated identical attempts feed the stall streak.
        const changes = next() < 0.5 ? "same tweak" : pick(next, ["tweak-a", "tweak-b", "tweak-c"]);
        applyLogIteration(cwd, id, state, "log", intBetween(next, 1, 60), changes);
      }

      const running = session.runningCount() > 0;
      const shouldContinue = expectedMode && session.loopTurnActive && running;
      const before = session.continuations;
      session.endTurn();

      expect(session.continuations).toBe(before + (shouldContinue ? 1 : 0));

      // INVARIANT: stallStreak agrees with the persisted log after every turn.
      const fresh = loadState(cwd, id)!;
      const results = readResults(cwd, id);
      expect(fresh.stallStreak).toBe(stallStreak(results));
      expect(fresh.stallStreak).toBeLessThanOrEqual(60);
    }
  });
});

describe("session lifecycle: lane operations must not stop sibling lanes", () => {
  it("pausing one lane leaves the other continuing", () => {
    const perf = laneFor("perf");
    const quant = laneFor("quant");
    startLoopOnDisk(perf);
    startLoopOnDisk(quant);

    const session = new Session(cwd, []).start();
    expect(session.attached.size).toBe(2);
    expect(session.loopMode).toBe(true);

    session.endLane(perf, "paused");

    expect(session.loopMode).toBe(true);
    expect(session.runningCount()).toBe(1);

    const before = session.continuations;
    session.toolCall().endTurn();
    expect(session.continuations).toBe(before + 1);
  });

  it("pausing one lane does not poison the next session", () => {
    const perf = laneFor("perf");
    const quant = laneFor("quant");
    startLoopOnDisk(perf);
    startLoopOnDisk(quant);

    const branch: ModeEntryLike[] = [];
    new Session(cwd, branch).start().endLane(perf, "paused");

    const next = new Session(cwd, branch).start();
    expect(next.loopMode).toBe(true);
    expect(next.attached.size).toBe(1);
    expect(next.continuations).toBe(1);
  });

  it("stopping the last lane clears mode and keeps it clear across a reload", () => {
    const only = laneFor("solo");
    startLoopOnDisk(only);

    const branch: ModeEntryLike[] = [];
    const session = new Session(cwd, branch).start().endLane(only, "stopped");
    expect(session.loopMode).toBe(false);

    const next = new Session(cwd, branch).start();
    expect(next.loopMode).toBe(false);
    expect(next.continuations).toBe(0);
  });

  it("/multiloop off still forces mode off with lanes running", () => {
    startLoopOnDisk(laneFor("perf"));
    startLoopOnDisk(laneFor("quant"));

    const session = new Session(cwd, []).start().disarmViaCommand();
    expect(session.loopMode).toBe(false);
    expect(session.runningCount()).toBe(2);   // loops survive; only auto-continue stops
  });
});
