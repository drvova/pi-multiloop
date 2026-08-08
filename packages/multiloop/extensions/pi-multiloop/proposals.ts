// Lane proposals: speciation with an approval gate.
//
// A lane that discovers orthogonal work mid-loop cannot start a lane itself —
// workers drive exactly one loop. Instead it writes a structured proposal to
// the swarm's commons (.multiloop/shared/proposals.json), the parent session
// surfaces it, and a human (or the parent agent) approves or rejects. Approval
// starts the lane through the extension's own startLoop path — the proposal
// carries evidence (rationale + the proposer's identity, whose measured track
// record is readable via multiloop_results), and the budget becomes the new
// lane's maxIterations, so every spawned lane is born bounded.
//
// Discipline mirrors lanes.ts registry handling: JSON read-modify-write (not
// JSONL — proposals have mutable status, and the file is tiny), the path is a
// constant never built from user input, and every identifier is validated at
// the boundary. Two mechanical caps make misuse structurally impossible:
// a pending-proposal ceiling and one pending proposal per lane name.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type LaneId, validateLaneId, formatLaneId } from "./lanes.js";

export interface LaneProposal {
  id: number;
  /** Proposer identity, "lane/runTag" — its peer results are the evidence. */
  from: string;
  /** Proposed new lane name. */
  lane: string;
  mode: string;
  goal: string;
  verifyCommand: string;
  /** Why this emerged — what the proposer measured that justifies a new lane. */
  rationale: string;
  /** Cost bound: becomes the new lane's maxIterations on approval. */
  maxIterations?: number;
  metricDirection?: "lower" | "higher";
  status: "pending" | "approved" | "rejected";
  proposedAt: string;
  resolvedAt?: string;
  resolveNote?: string;
}

export type ProposeResult =
  | { ok: true; proposal: LaneProposal }
  | { ok: false; reason: string };

export const MAX_PENDING_PROPOSALS = 5;

const PROPOSALS_FILE = join(".multiloop", "shared", "proposals.json");

function proposalsPath(cwd: string): string {
  return resolve(cwd, PROPOSALS_FILE);
}

export function readProposals(cwd: string): LaneProposal[] {
  const path = proposalsPath(cwd);
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf-8")) as { proposals: LaneProposal[] }).proposals;
}

function writeProposals(cwd: string, proposals: LaneProposal[]): void {
  mkdirSync(resolve(cwd, join(".multiloop", "shared")), { recursive: true });
  writeFileSync(proposalsPath(cwd), JSON.stringify({ version: 1, proposals }, null, 2) + "\n");
}

export function pendingProposals(cwd: string): LaneProposal[] {
  return readProposals(cwd).filter((p) => p.status === "pending");
}

export function proposeLane(
  cwd: string,
  from: LaneId,
  spec: Pick<LaneProposal, "lane" | "mode" | "goal" | "verifyCommand" | "rationale" | "maxIterations" | "metricDirection">
): ProposeResult {
  const fromError = validateLaneId(from);
  if (fromError) return { ok: false, reason: fromError };
  const laneError = validateLaneId({ lane: spec.lane, runTag: "run" });
  if (laneError) return { ok: false, reason: `Proposed lane invalid: ${laneError}` };

  const proposals = readProposals(cwd);
  const pending = proposals.filter((p) => p.status === "pending");
  if (pending.length >= MAX_PENDING_PROPOSALS) {
    return {
      ok: false,
      reason: `Proposal queue full (${MAX_PENDING_PROPOSALS} pending). Approve or reject pending proposals first — unbounded speciation is a compute firehose, not a swarm.`,
    };
  }
  const duplicate = pending.find((p) => p.lane === spec.lane);
  if (duplicate) {
    return { ok: false, reason: `Lane "${spec.lane}" already has pending proposal #${duplicate.id}.` };
  }

  const proposal: LaneProposal = {
    id: proposals.reduce((max, p) => Math.max(max, p.id), 0) + 1,
    from: formatLaneId(from),
    lane: spec.lane,
    mode: spec.mode,
    goal: spec.goal,
    verifyCommand: spec.verifyCommand,
    rationale: spec.rationale,
    maxIterations: spec.maxIterations,
    metricDirection: spec.metricDirection,
    status: "pending",
    proposedAt: new Date().toISOString(),
  };
  proposals.push(proposal);
  writeProposals(cwd, proposals);
  return { ok: true, proposal };
}

export function resolveProposal(
  cwd: string,
  id: number,
  resolution: "approved" | "rejected",
  note?: string
): ProposeResult {
  const proposals = readProposals(cwd);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) return { ok: false, reason: `No proposal #${id}.` };
  if (proposal.status !== "pending") {
    return { ok: false, reason: `Proposal #${id} is already ${proposal.status} — a resolved proposal cannot be re-resolved.` };
  }
  proposal.status = resolution;
  proposal.resolvedAt = new Date().toISOString();
  proposal.resolveNote = note;
  writeProposals(cwd, proposals);
  return { ok: true, proposal };
}

/** Render pending proposals as prompt lines for the parent session. */
export function formatProposals(proposals: LaneProposal[]): string[] {
  return proposals.map((p) =>
    `- #${p.id} from ${p.from}: lane "${p.lane}" (${p.mode}${p.maxIterations ? `, ≤${p.maxIterations} iterations` : ""}) — ${p.goal} — rationale: ${p.rationale} — approve with /multiloop approve ${p.id} or reject with /multiloop reject ${p.id}`
  );
}
