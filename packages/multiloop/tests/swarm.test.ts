import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import multiloopExtension, { buildSwarmLines } from "../extensions/pi-multiloop/index.js";
import { createLiveDashboardWidget } from "../extensions/pi-multiloop/ui.js";
import { createInitialState } from "../extensions/pi-multiloop/state.js";
import { registerLoop, ensureLaneDir, type RegistryEntry } from "../extensions/pi-multiloop/lanes.js";
import { sendMessage } from "../extensions/pi-multiloop/mesh.js";
import { appendKnowledge } from "../extensions/pi-multiloop/knowledge.js";
import { proposeLane } from "../extensions/pi-multiloop/proposals.js";
import { laneFor, tmpPrefix } from "./support/seed.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), tmpPrefix("swarm")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const PLAIN = { fg: (_c: never, text: string) => text };

function registerActive(id: { lane: string; runTag: string }): void {
  ensureLaneDir(cwd, id);
  const entry: RegistryEntry = {
    lane: id.lane,
    runTag: id.runTag,
    mode: "optimize",
    status: "active",
    startedAt: new Date().toISOString(),
    stateDir: `.multiloop/active/${id.lane}/${id.runTag}`,
  };
  registerLoop(cwd, entry);
}

describe("buildSwarmLines", () => {
  it("returns [] when the swarm is quiet", () => {
    expect(buildSwarmLines(cwd)).toEqual([]);
  });

  it("summarizes lanes, mesh, knowledge, and proposals in one line", () => {
    const a = laneFor("perf");
    const b = laneFor("quant");
    registerActive(a);
    registerActive(b);
    sendMessage(cwd, a, b, "verify is flaky under load");
    appendKnowledge(cwd, a, "LR saturates past 0.9");
    proposeLane(cwd, a, {
      lane: "deps",
      mode: "optimize",
      goal: "Shrink the dominant dependency",
      verifyCommand: "node size.mjs",
      rationale: "80% of bundle is dep X",
    });

    const lines = buildSwarmLines(cwd);
    expect(lines[0]).toBe("Swarm: 2 live lane(s) · 1 mesh pending · 1 knowledge entries · 1 proposal(s) pending");
    expect(lines.join("\n")).toContain(`latest mesh from ${a.lane}/${a.runTag}: verify is flaky under load`);
    expect(lines.join("\n")).toContain("LR saturates past 0.9");
    expect(lines.join("\n")).toContain(`proposal #1 from ${a.lane}/${a.runTag}: lane "deps" — /multiloop approve 1`);
  });

  it("shows the knowledge board even with no live lanes — durable memory outlives runs", () => {
    appendKnowledge(cwd, laneFor("ghost"), "old lesson");
    const lines = buildSwarmLines(cwd);
    expect(lines[0]).toContain("0 live lane(s)");
    expect(lines.join("\n")).toContain("old lesson");
  });
});

describe("live widget swarm block", () => {
  it("appends swarm lines below the lane rows", () => {
    const states = [createInitialState(laneFor("perf"), "optimize", "bench", {})];
    const widget = createLiveDashboardWidget(() => states, PLAIN, () => ["Swarm: 1 live lane(s) · 0 mesh pending"]);
    const out = widget.render(120).join("\n");
    expect(out).toContain("perf");
    expect(out).toContain("Swarm: 1 live lane(s)");
  });

  it("keeps swarm lines visible when no loops are attached", () => {
    const widget = createLiveDashboardWidget(() => [], PLAIN, () => ["Swarm: 0 live lane(s) · 2 knowledge entries"]);
    const out = widget.render(120).join("\n");
    expect(out).toContain("idle");
    expect(out).toContain("2 knowledge entries");
  });

  it("defaults to no swarm lines — existing callers are unaffected", () => {
    const states = [createInitialState(laneFor("perf"), "optimize", "bench", {})];
    const out = createLiveDashboardWidget(() => states, PLAIN).render(120).join("\n");
    expect(out).not.toContain("Swarm:");
  });
});

describe("multiloop_pulse tool", () => {
  it("is registered and reports the swarm through a tool call", async () => {
    type CapturedTool = { execute: (id: string, params: object, signal: undefined, onUpdate: undefined, ctx: { cwd: string }) => Promise<{ content: { text: string }[] }> };
    const tools = new Map<string, CapturedTool>();
    const piStub = {
      registerTool: (def: { name: string }) => tools.set(def.name, def as never),
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      on: () => {},
    };
    multiloopExtension(piStub as never);
    const pulse = tools.get("multiloop_pulse");
    expect(pulse).toBeDefined();

    appendKnowledge(cwd, laneFor("quant"), "caches invalidate at dawn");
    const result = await pulse!.execute("call", {}, undefined, undefined, { cwd });
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain("caches invalidate at dawn");
  });
});
