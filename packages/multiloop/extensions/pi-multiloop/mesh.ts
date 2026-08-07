// Mesh mailbox: file-based inter-lane messaging for pi-multiloop.
//
// Design: stigmergy, not live IPC. Lane workers are ephemeral sessions, so a
// message sent to a running worker is a message to nobody. Instead, each lane
// owns an append-only mailbox (`.multiloop/active/<lane>/<runTag>/mesh.jsonl`)
// that other lanes write into; a lane drains its own mailbox at the start of
// its next iteration. The mailbox file is the shared medium — the same role
// `results.jsonl` plays for cross-lane metric learning, but for directed
// notes, hints, and handoffs between lanes.
//
// Discipline mirrors state.ts: laneDir/assertValidLaneId construct every path
// from a validated LaneId (never raw user input), appends are atomic single
// writes, and reads tolerate a corrupt tail line by dropping it rather than
// failing the whole mailbox.

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  type LaneId,
  assertValidLaneId,
  laneDir,
  ensureLaneDir,
  formatLaneId,
} from "./lanes.js";

export interface MeshMessage {
  /** Sender identity (lane/run-tag). */
  from: string;
  /** Recipient identity (lane/run-tag). */
  to: string;
  /** ISO timestamp of the send. */
  sentAt: string;
  /** Free-form body — a note, hint, or handoff. */
  body: string;
}

const MESH_FILE = "mesh.jsonl";

function meshPath(cwd: string, id: LaneId): string {
  assertValidLaneId(id);
  return join(laneDir(cwd, id), MESH_FILE);
}

/**
 * Append a message to the recipient's mailbox. Returns the stored message.
 * The sender never touches its own mailbox; delivery is strictly one-way and
 * the recipient drains on its own schedule. This is the "no live sibling IPC"
 * seam made explicit: the only write path is an atomic append to the
 * recipient's file.
 */
export function sendMessage(
  cwd: string,
  from: LaneId,
  to: LaneId,
  body: string
): MeshMessage {
  assertValidLaneId(from);
  assertValidLaneId(to);
  ensureLaneDir(cwd, to);
  const message: MeshMessage = {
    from: formatLaneId(from),
    to: formatLaneId(to),
    sentAt: new Date().toISOString(),
    body,
  };
  appendFileSync(meshPath(cwd, to), JSON.stringify(message) + "\n");
  return message;
}

/**
 * Read the full mailbox for a lane without consuming it. A corrupt tail line
 * (crash mid-append) is dropped, not fatal — the mailbox is a hint channel,
 * not the source of truth. Returns messages in arrival order.
 */
export function readMessages(cwd: string, id: LaneId): MeshMessage[] {
  const path = meshPath(cwd, id);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const messages: MeshMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as MeshMessage);
    } catch {
      // Dropped corrupt line: a torn append must not poison the mailbox.
    }
  }
  return messages;
}

/**
 * Peek at the latest `count` messages addressed to a lane, newest last.
 * Used to fold peer context into an iteration prompt without consuming the
 * mailbox — draining is the recipient's decision, not the reader's.
 */
export function peekMessages(cwd: string, id: LaneId, count: number): MeshMessage[] {
  const all = readMessages(cwd, id);
  return count >= all.length ? all : all.slice(all.length - count);
}

/**
 * Render pending messages as prompt lines for an iteration. The caller
 * (buildIterationContext) folds these into the worker's context so a lane
 * starts its next iteration aware of what sibling lanes told it.
 */
export function formatMessages(messages: MeshMessage[]): string[] {
  return messages.map((m) => `- [${m.sentAt}] from ${m.from}: ${m.body}`);
}
