// Cross-lane result learning: read-only access to sibling lanes' measured
// outcomes.
//
// Design: shared journal, not shared state. This is Optuna's JournalStorage
// pattern — N workers, one append-only log each, and each worker reads the
// others' *completed* trials before deciding its next move. Our
// `results.jsonl` files are already those journals; this module is the
// missing read path across lanes.
//
// Decision-only visibility (Poka-Yoke), mirroring Optuna's ask/tell: a
// peer's in-flight iteration is invisible. Only results that carry a metric
// plus a decided action (keep/revert/log) surface, so a lane can never act
// on a sibling's unmeasured half-state.
//
// Tolerance: a peer with a torn journal (crash mid-append) is skipped, not
// fatal — the same "hint channel, not source of truth" rule mesh.ts applies
// to mailboxes, reusing the exact-parse readers compareRuns already trusts.
//
// The mesh moves prose hints between lanes; this channel moves measured
// evidence. Together with the shared knowledge board (distilled prose) they
// complete the organism: coordination, doctrine, and data.

import {
  type LaneId,
  assertValidLaneId,
  readRegistry,
  formatLaneId,
} from "./lanes.js";
import { type IterationResult, readResults, readRunFiles } from "./state.js";

/** Peer-visible actions: measured outcomes only, never in-flight iterations. */
const PEER_ACTIONS = new Set(["keep", "revert", "log"]);

export interface PeerResult {
  /** Originating loop (lane/run-tag). */
  from: string;
  /** ISO timestamp of the peer's decision. */
  timestamp: string;
  /** Decided action: keep | revert | log. */
  action: string;
  /** Measured metric for the iteration. */
  metric?: number;
  /** What the peer tried (hypothesis first, else the changes summary). */
  summary?: string;
}

function toPeerResult(from: string, r: IterationResult): PeerResult | null {
  if (r.metric === undefined || !PEER_ACTIONS.has(r.action)) return null;
  return {
    from,
    timestamp: r.timestamp,
    action: r.action,
    metric: r.metric,
    summary: r.hypothesis ?? r.changes,
  };
}

/**
 * Read the measured outcomes of every other registered loop, excluding `id`
 * itself. Sorted oldest to newest across all peer lanes; bounded by `limit`
 * (most recent kept). A peer with no journal, an empty journal, only
 * in-flight iterations, or a torn tail contributes nothing — never an error.
 */
export function readPeerResults(
  cwd: string,
  id: LaneId,
  limit: number
): PeerResult[] {
  assertValidLaneId(id);
  const self = formatLaneId(id);
  const peers: PeerResult[] = [];
  for (const loop of readRegistry(cwd).loops) {
    const from = `${loop.lane}/${loop.runTag}`;
    if (from === self) continue;
    const peerId: LaneId = { lane: loop.lane, runTag: loop.runTag };
    let results: IterationResult[] = [];
    try {
      results = loop.stateDir
        ? readRunFiles(cwd, loop.stateDir).results
        : readResults(cwd, peerId);
    } catch {
      // Torn peer journal: skip the lane rather than fail the fold.
      continue;
    }
    for (const r of results) {
      const peer = toPeerResult(from, r);
      if (peer) peers.push(peer);
    }
  }
  peers.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return limit >= peers.length ? peers : peers.slice(peers.length - limit);
}

/**
 * Render peer outcomes as prompt lines for an iteration, mirroring
 * formatMessages in mesh.ts. The caller (buildIterationContext) folds these
 * in so a lane starts its next iteration aware of what sibling lanes have
 * already measured — and what regressed.
 */
export function formatPeerResults(peers: PeerResult[]): string[] {
  return peers.map(
    (p) =>
      `- [${p.timestamp}] ${p.from}: ${p.action} metric=${p.metric}${p.summary ? ` — ${p.summary}` : ""}`
  );
}
