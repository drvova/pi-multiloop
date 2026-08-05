import {
  type ModeEntryLike,
  MODE_ENTRY_TYPE,
  classifyUserInput,
  latestModeDecision,
  shouldArmLoopMode,
  shouldQueueContinuation,
  shouldDisarmAfterLaneOperation,
} from "../../extensions/pi-multiloop/mode.js";
import { collectRunningLoops } from "../../extensions/pi-multiloop/index.js";
import {
  type LoopState,
  createInitialState,
  saveState,
  loadState,
} from "../../extensions/pi-multiloop/state.js";
import { type LaneId, registerLoop, updateLoopStatus, ensureLaneDir } from "../../extensions/pi-multiloop/lanes.js";

/**
 * Session simulator, shared by the session-lifecycle and long-horizon
 * environment suites.
 *
 * Mirrors the handler wiring in index.ts: session_start arms mode from the
 * recorded decision plus disk, input reclassifies, tools set the per-turn flag,
 * and agent_end asks whether to continue. Composition only -- every decision
 * below is the production function.
 *
 * What this cannot prove is that index.ts still calls these; that gap is closed
 * by the type signatures and covered explicitly in the mutation sweep.
 */
export class Session {
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

  /** Attached running lanes still carrying a durable continuation intent. */
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

  /** /multiloop off: forces mode off, dropping any durable continuation intent. */
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

  /** pi.on("agent_end") — queue a follow-up only when all three gates hold. */
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

export interface StartLoopOptions {
  maxIterations?: number;
  targetMetric?: number;
}

/** Register a running punchlist loop on disk at the given cwd. */
export function startLoopOnDisk(cwd: string, id: LaneId, options: StartLoopOptions = {}): LoopState {
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