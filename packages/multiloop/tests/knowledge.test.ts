import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendKnowledge, readKnowledge } from "../extensions/pi-multiloop/knowledge.js";
import { buildIterationContext, applyDecision, establishBaseline } from "../extensions/pi-multiloop/loop.js";
import { createInitialState, saveState } from "../extensions/pi-multiloop/state.js";
import { ensureLaneDir } from "../extensions/pi-multiloop/lanes.js";
import { laneFor, tmpPrefix } from "./support/seed.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), tmpPrefix("knowledge")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function measurement(value: number) {
  return { median: value, mad: 1, confidence: "high" as const, measurements: [value], isSignificant: true };
}

describe("shared knowledge board", () => {
  it("appends attributed entries and reads them back oldest-to-newest", () => {
    const a = laneFor("quant");
    const b = laneFor("perf");
    appendKnowledge(cwd, a, "LR schedule saturates past 0.9");
    appendKnowledge(cwd, b, "verify is flaky under load");

    const entries = readKnowledge(cwd, 10);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain(`(${a.lane}/${a.runTag})`);
    expect(entries[0]).toContain("LR schedule saturates past 0.9");
    expect(entries[1]).toContain(`(${b.lane}/${b.runTag})`);
    // Durable + undirected: the file lives under .multiloop/shared, not a lane dir.
    const raw = readFileSync(join(cwd, ".multiloop", "shared", "knowledge.md"), "utf-8");
    expect(raw).toContain("LR schedule saturates past 0.9");
  });

  it("returns empty when no board exists", () => {
    expect(readKnowledge(cwd, 10)).toEqual([]);
  });

  it("tail-bounds the read to the newest N entries", () => {
    const id = laneFor("writer");
    for (let i = 1; i <= 20; i++) appendKnowledge(cwd, id, `lesson ${i}`);
    const entries = readKnowledge(cwd, 5);
    expect(entries).toHaveLength(5);
    expect(entries[0]).toContain("lesson 16");
    expect(entries[4]).toContain("lesson 20");
  });

  it("rejects unsafe lane identifiers even though the id is only attribution", () => {
    expect(() => appendKnowledge(cwd, { lane: "../escape", runTag: "r1" }, "x")).toThrow(/Invalid lane/);
  });
});

describe("shared knowledge in iteration context", () => {
  it("renders the knowledge block into buildIterationContext", () => {
    const id = laneFor("perf");
    const state = createInitialState(id, "optimize", "./bench.py", { metricDirection: "lower" });
    const knowledge = [`- [2026-08-08T00:00:00.000Z] (quant/r9) LR saturates past 0.9`];

    const context = buildIterationContext(state, [], knowledge);

    expect(context).toContain("Shared knowledge (1 entries from all lanes):");
    expect(context).toContain("LR saturates past 0.9");
  });

  it("omits the block when the board is empty", () => {
    const state = createInitialState(laneFor("solo"), "optimize", "./bench.py", { metricDirection: "lower" });
    expect(buildIterationContext(state)).not.toContain("Shared knowledge");
    expect(buildIterationContext(state, [], [])).not.toContain("Shared knowledge");
  });

  it("renders after the mesh block when both are present", () => {
    const state = createInitialState(laneFor("both"), "optimize", "./bench.py", { metricDirection: "lower" });
    const context = buildIterationContext(
      state,
      ["- [t] from quant/r9: directed hint"],
      ["- [t] (quant/r9) durable lesson"]
    );
    const meshIdx = context.indexOf("Mesh inbox");
    const knowledgeIdx = context.indexOf("Shared knowledge");
    expect(meshIdx).toBeGreaterThan(-1);
    expect(knowledgeIdx).toBeGreaterThan(meshIdx);
  });
});

describe("pivot mirror", () => {
  it("mirrors pivot lessons to the shared board automatically", () => {
    const id = laneFor("pivot");
    ensureLaneDir(cwd, id);
    const state = createInitialState(id, "optimize", "echo 1", {
      metricDirection: "higher",
      goal: "trigger a pivot",
    });
    establishBaseline(cwd, id, state, 1);
    saveState(cwd, id, state);

    // Three consecutive reverts escalate to a pivot (PIVOT_THRESHOLD).
    let current = state;
    for (let i = 0; i < 3; i++) {
      current = applyDecision(cwd, id, current, {
        action: "revert",
        reason: "no improvement",
        shouldEscalate: i === 2,
        escalationType: i === 2 ? "pivot" : undefined,
      }, measurement(1));
    }

    expect(current.pivotCount).toBe(1);
    const board = readKnowledge(cwd, 10);
    expect(board).toHaveLength(1);
    expect(board[0]).toContain(`(${id.lane}/${id.runTag})`);
    expect(board[0]).toContain("Pivot 1");
    // Per-lane lessons.md still gets its copy — mirror, not move.
    expect(current.lastLesson).toContain("Pivot 1");
  });
});
