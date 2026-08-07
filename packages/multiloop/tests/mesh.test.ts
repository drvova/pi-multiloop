import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sendMessage,
  readMessages,
  peekMessages,
  formatMessages,
} from "../extensions/pi-multiloop/mesh.js";
import { buildIterationContext } from "../extensions/pi-multiloop/loop.js";
import { createInitialState } from "../extensions/pi-multiloop/state.js";
import { ensureLaneDir } from "../extensions/pi-multiloop/lanes.js";
import { laneFor, tmpPrefix } from "./support/seed.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), tmpPrefix("mesh")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("mesh mailbox", () => {
  it("delivers a message from one lane to another", () => {
    const from = laneFor("quant");
    const to = laneFor("perf");
    ensureLaneDir(cwd, from);

    const stored = sendMessage(cwd, from, to, "cache flush halves p99 — try it");

    expect(stored.from).toBe(`${from.lane}/${from.runTag}`);
    expect(stored.to).toBe(`${to.lane}/${to.runTag}`);
    expect(stored.body).toContain("cache flush");

    const inbox = readMessages(cwd, to);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].body).toBe("cache flush halves p99 — try it");
    // Sender's own mailbox stays empty: delivery is one-way.
    expect(readMessages(cwd, from)).toHaveLength(0);
  });

  it("returns an empty inbox for a lane with no mailbox file", () => {
    expect(readMessages(cwd, laneFor("ghost"))).toEqual([]);
  });

  it("keeps arrival order and peeks the newest N", () => {
    const a = laneFor("a");
    const b = laneFor("b");
    const c = laneFor("c");
    sendMessage(cwd, a, c, "first");
    sendMessage(cwd, b, c, "second");
    sendMessage(cwd, a, c, "third");

    expect(readMessages(cwd, c).map((m) => m.body)).toEqual(["first", "second", "third"]);
    expect(peekMessages(cwd, c, 2).map((m) => m.body)).toEqual(["second", "third"]);
    expect(peekMessages(cwd, c, 99)).toHaveLength(3);
  });

  it("drops a corrupt tail line instead of failing the mailbox", () => {
    const from = laneFor("writer");
    const to = laneFor("reader");
    sendMessage(cwd, from, to, "good line");
    const mailboxPath = join(cwd, ".multiloop", "active", to.lane, to.runTag, "mesh.jsonl");
    appendFileSync(mailboxPath, "{torn-append");

    const inbox = readMessages(cwd, to);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].body).toBe("good line");
  });

  it("rejects unsafe lane identifiers on both ends", () => {
    const good = laneFor("ok");
    const bad = { lane: "../escape", runTag: "r1" };
    expect(() => sendMessage(cwd, good, bad, "x")).toThrow(/Invalid lane/);
    expect(() => sendMessage(cwd, bad, good, "x")).toThrow(/Invalid lane/);
  });
});

describe("mesh inbox in iteration context", () => {
  it("renders pending peer messages into buildIterationContext", () => {
    const id = laneFor("perf");
    const state = createInitialState(id, "optimize", "./bench.py", {
      metricDirection: "lower",
      goal: "reduce latency",
    });
    const peers = formatMessages([
      { from: "quant/r9", to: `${id.lane}/${id.runTag}`, sentAt: "2026-08-07T00:00:00.000Z", body: "LR schedule saturates past 0.9" },
    ]);

    const context = buildIterationContext(state, peers);

    expect(context).toContain("Mesh inbox (1 pending from sibling lanes):");
    expect(context).toContain("from quant/r9: LR schedule saturates past 0.9");
  });

  it("omits the mesh block entirely when the inbox is empty", () => {
    const state = createInitialState(laneFor("solo"), "optimize", "./bench.py", {
      metricDirection: "lower",
    });
    expect(buildIterationContext(state)).not.toContain("Mesh inbox");
    expect(buildIterationContext(state, [])).not.toContain("Mesh inbox");
  });

  it("threads a real mailbox through the context builder end to end", () => {
    const from = laneFor("quant");
    const to = laneFor("perf");
    sendMessage(cwd, from, to, "verify command is flaky under load");

    const state = createInitialState(to, "optimize", "./bench.py", {
      metricDirection: "lower",
    });
    const pending = peekMessages(cwd, to, 10);
    const context = buildIterationContext(state, formatMessages(pending));

    expect(context).toContain("Mesh inbox (1 pending");
    expect(context).toContain("verify command is flaky under load");
    expect(context).toContain(`Active Loop: ${to.lane}/${to.runTag}`);
  });
});
