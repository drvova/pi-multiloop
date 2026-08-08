import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  proposeLane,
  resolveProposal,
  readProposals,
  pendingProposals,
  formatProposals,
  MAX_PENDING_PROPOSALS,
} from "../extensions/pi-multiloop/proposals.js";
import { laneFor, tmpPrefix } from "./support/seed.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), tmpPrefix("proposals")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const SPEC = {
  lane: "deps",
  mode: "optimize",
  goal: "Shrink the dominant dependency",
  verifyCommand: "node scripts/bundle-size.mjs",
  rationale: "Measured: 80% of bundle is dep X — orthogonal to this lane's code edits",
  maxIterations: 8,
  metricDirection: "lower" as const,
};

describe("lane proposals", () => {
  it("files a pending proposal attributed to the proposer", () => {
    const from = laneFor("perf");
    const result = proposeLane(cwd, from, SPEC);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.id).toBe(1);
    expect(result.proposal.from).toBe(`${from.lane}/${from.runTag}`);
    expect(result.proposal.status).toBe("pending");
    expect(pendingProposals(cwd)).toHaveLength(1);
  });

  it("assigns sequential ids", () => {
    const from = laneFor("perf");
    const a = proposeLane(cwd, from, SPEC);
    const b = proposeLane(cwd, from, { ...SPEC, lane: "types" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.proposal.id).toBe(a.proposal.id + 1);
  });

  it("refuses a duplicate pending proposal for the same lane name", () => {
    const from = laneFor("perf");
    proposeLane(cwd, from, SPEC);
    const dup = proposeLane(cwd, laneFor("quant"), SPEC);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toContain("already has pending proposal #1");
  });

  it("enforces the pending-proposal ceiling", () => {
    const from = laneFor("perf");
    for (let i = 1; i <= MAX_PENDING_PROPOSALS; i++) {
      const r = proposeLane(cwd, from, { ...SPEC, lane: `lane${i}` });
      expect(r.ok).toBe(true);
    }
    const overflow = proposeLane(cwd, from, { ...SPEC, lane: "overflow" });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.reason).toContain("queue full");
  });

  it("resolves exactly once — approve then reject is refused", () => {
    const from = laneFor("perf");
    proposeLane(cwd, from, SPEC);
    const approved = resolveProposal(cwd, 1, "approved", "started as deps/run-x");
    expect(approved.ok).toBe(true);

    const again = resolveProposal(cwd, 1, "rejected", "changed my mind");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toContain("already approved");

    const proposals = readProposals(cwd);
    expect(proposals[0].status).toBe("approved");
    expect(proposals[0].resolveNote).toBe("started as deps/run-x");
    expect(pendingProposals(cwd)).toHaveLength(0);
  });

  it("rejects unknown proposal ids", () => {
    const result = resolveProposal(cwd, 99, "approved");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("No proposal #99");
  });

  it("refuses unsafe identifiers on both proposer and proposed lane", () => {
    const good = laneFor("ok");
    const bad = { lane: "../escape", runTag: "r1" };
    expect(proposeLane(cwd, bad, SPEC).ok).toBe(false);
    expect(proposeLane(cwd, good, { ...SPEC, lane: "../escape" }).ok).toBe(false);
  });

  it("renders pending proposals with the approve/reject commands", () => {
    proposeLane(cwd, laneFor("perf"), SPEC);
    const lines = formatProposals(pendingProposals(cwd));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("#1");
    expect(lines[0]).toContain('lane "deps"');
    expect(lines[0]).toContain("≤8 iterations");
    expect(lines[0]).toContain("/multiloop approve 1");
    expect(lines[0]).toContain(SPEC.rationale);
  });

  it("returns empty reads when no store exists", () => {
    expect(readProposals(cwd)).toEqual([]);
    expect(pendingProposals(cwd)).toEqual([]);
  });
});
