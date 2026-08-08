// Shared knowledge board: durable cross-lane memory for pi-multiloop.
//
// The fourth quadrant of the loop memory map. results.jsonl and lessons.md
// are durable but per-lane; mesh.jsonl is cross-lane but directed and consumed
// transiently. The knowledge board is durable AND undirected: distilled
// lessons ("LR schedule saturates past 0.9", "verify is flaky under load")
// that every future iteration of every lane should inherit. Pivot lessons are
// mirrored here automatically (see applyDecision in loop.ts), so the board
// fills even when no agent calls multiloop_publish.
//
// Discipline mirrors mesh.ts/state.ts: the path is a constant under
// .multiloop/shared (never constructed from user input), appends are atomic
// single writes, and the lane id is validated even though it is only
// attribution text — a poisoned board is worse than a rejected write.

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type LaneId, assertValidLaneId, formatLaneId } from "./lanes.js";

const SHARED_DIR = join(".multiloop", "shared");
const KNOWLEDGE_FILE = "knowledge.md";

function knowledgePath(cwd: string): string {
  return resolve(cwd, SHARED_DIR, KNOWLEDGE_FILE);
}

/**
 * Append a distilled lesson to the shared board, attributed to its lane.
 * The write is a single atomic append; the board is plain markdown so it
 * stays human-readable and diff-friendly like lessons.md.
 */
export function appendKnowledge(cwd: string, id: LaneId, lesson: string): void {
  assertValidLaneId(id);
  mkdirSync(resolve(cwd, SHARED_DIR), { recursive: true });
  appendFileSync(
    knowledgePath(cwd),
    `- [${new Date().toISOString()}] (${formatLaneId(id)}) ${lesson}\n`
  );
}

/**
 * Tail-bounded read of the board, oldest-to-newest. `limit` caps how many
 * entries an iteration context carries; the file itself grows unbounded
 * (ponytail: rotation when a board measurably slows context assembly, not
 * before). Empty when no board exists yet.
 */
export function readKnowledge(cwd: string, limit: number): string[] {
  const path = knowledgePath(cwd);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  return limit >= lines.length ? lines : lines.slice(lines.length - limit);
}
