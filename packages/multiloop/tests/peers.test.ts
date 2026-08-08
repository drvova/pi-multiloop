import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readPeerResults,
  formatPeerResults,
} from "../extensions/pi-multiloop/peers.js";
import { buildIterationContext } from "../extensions/pi-multiloop/loop.js";
import {
  createInitialState,
  appendResult,
  saveState,
  type IterationResult,
} from "../extensions/pi-multiloop/state.js";
import { ensureLaneDir, registerLoop, laneDir, formatLaneId, type LaneId } from "../extensions/pi-multiloop/lanes.js";
import { laneFor, tmpPrefix } from "./support/seed.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), tmpPrefix("peers")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** Register a loop and seed its journal with the given results. */
function seedLane(id: LaneId, results: IterationResult[]): void {
  ensureLaneDir(cwd, id);
  saveState(cwd, id, createInitialState(id, "optimize", "echo 1"));
  registerLoop(cwd, {
    lane: id.lane,
    runTag: id.runTag,
    mode: "optimize",
    status: "active",
    stateDir: laneDir(cwd, id),
    startedAt: new Date().toISOString(),
  });
  for (const r of results) appendResult(cwd, id, r);
}

function result(iteration: number, action: IterationResult["action"], metric?: number, hypothesis?: string): IterationResult {
  return {
    iteration,
    timestamp: new Date(2026, 0, 1, 0, 0, iteration).toISOString(),
    action,
    metric,
    hypothesis,
  };
}

describe("cross-lane peer results", () => {
  it("excludes the reader's own lane", () => {
    const me = laneFor("quant");
    const other = laneFor("perf");
    seedLane(me, [result(1, "keep", 10, "mine")]);
    seedLane(other, [result(1, "keep", 20, "theirs")]);

    const peers = readPeerResults(cwd, me, 15);
    expect(peers).toHaveLength(1);
    expect(peers[0].from).toBe(formatLaneId(other));
    expect(peers[0].summary).toBe("theirs");
  });

  it("surfaces only decided iterations that carry a metric", () => {
    const me = laneFor("a");
    const peer = laneFor("b");
    seedLane(me, []);
    seedLane(peer, [
      result(1, "keep", 5, "kept"),
      result(2, "skip", undefined, "skipped-no-metric"), // in-flight / undecided
      result(3, "crash", 9, "crashed"),
      result(4, "log", 7, "logged"),
    ]);

    const peers = readPeerResults(cwd, me, 15);
    expect(peers.map((p) => p.action)).toEqual(["keep", "log"]);
    expect(peers.every((p) => p.metric !== undefined)).toBe(true);
  });

  it("keeps newest-last order across lanes and bounds by limit", () => {
    const me = laneFor("me");
    const x = laneFor("x");
    const y = laneFor("y");
    seedLane(me, []);
    seedLane(x, [result(1, "keep", 1, "x1"), result(3, "keep", 3, "x3")]);
    seedLane(y, [result(2, "revert", 2, "y2")]);

    const all = readPeerResults(cwd, me, 15);
    expect(all.map((p) => p.metric)).toEqual([1, 2, 3]);
    const tail = readPeerResults(cwd, me, 2);
    expect(tail.map((p) => p.metric)).toEqual([2, 3]);
  });

  it("skips a peer whose journal has a torn tail instead of failing", () => {
    const me = laneFor("me");
    const good = laneFor("good");
    const torn = laneFor("torn");
    seedLane(me, []);
    seedLane(good, [result(1, "keep", 42, "intact")]);
    seedLane(torn, [result(1, "keep", 1, "before-tear")]);
    // Simulate a crash mid-append: a partial JSON line at the tail.
    appendFileSync(join(laneDir(cwd, torn), "results.jsonl"), '{"iteration":2,"timesta');

    const peers = readPeerResults(cwd, me, 15);
    expect(peers.map((p) => p.from)).toEqual([formatLaneId(good)]);
  });

  it("returns [] when no sibling lanes are registered", () => {
    const me = laneFor("solo");
    seedLane(me, [result(1, "keep", 1)]);
    expect(readPeerResults(cwd, me, 15)).toEqual([]);
  });

  it("folds peer outcomes into the iteration context", () => {
    const me = laneFor("me");
    const peer = laneFor("peer");
    seedLane(me, []);
    seedLane(peer, [result(1, "revert", 99, "batch_size=64 regressed")]);

    const state = createInitialState(me, "optimize", "echo 1");
    const peers = readPeerResults(cwd, me, 15);
    const ctx = buildIterationContext(state, [], [], formatPeerResults(peers));

    expect(ctx).toContain("Peer results (1 measured outcomes");
    expect(ctx).toContain("revert metric=99");
    expect(ctx).toContain("batch_size=64 regressed");
  });

  it("omits the peer section from context when no sibling has measured", () => {
    const me = laneFor("me");
    seedLane(me, []);
    const state = createInitialState(me, "optimize", "echo 1");
    const ctx = buildIterationContext(state, [], [], formatPeerResults(readPeerResults(cwd, me, 15)));
    expect(ctx).not.toContain("Peer results");
  });
});
