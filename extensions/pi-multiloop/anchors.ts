import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadState, type LoopState, type VerificationCheck } from "./state.js";
import type { LaneId } from "./lanes.js";

/**
 * Grounded anchors for a loop: files the optimizer may not modify, and a
 * verifier/stop-condition config that is frozen after start.
 *
 * Enforcement is measurement, not permission: the extension cannot intercept
 * writes (it has no tool-call hook), and read-only instructions are
 * circumventable (CircumEval). So the anchor is a hash baseline captured at
 * start and re-verified at every measure — the loop cannot silently tune what
 * measures it. A tampered pin stops the line (Jidoka).
 */

/** Hash of a missing file; any file appearing where none existed is a change. */
export const MISSING_FILE_HASH = "<missing>";

export function hashFile(path: string): string {
  if (!existsSync(path)) return MISSING_FILE_HASH;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Content hashes of repo-relative protected paths, resolved against cwd. */
export function snapshotProtectedHashes(
  cwd: string,
  paths: string[]
): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const path of paths) {
    snapshot[path] = hashFile(resolve(cwd, path));
  }
  return snapshot;
}

/**
 * Failed check naming every protected file that changed since baseline, or
 * null when there is nothing to protect, no baseline, or nothing changed.
 * Callers inject the result into the checks pipeline so acceptance blocks the
 * keep exactly like any other mechanical check.
 */
export function protectedFileCheck(
  cwd: string,
  protectedPaths: string[] | undefined,
  baseline: Record<string, string> | undefined
): VerificationCheck | null {
  if (!protectedPaths?.length || !baseline) return null;
  const changed = protectedPaths.filter(
    (path) => hashFile(resolve(cwd, path)) !== baseline[path]
  );
  if (changed.length === 0) return null;
  return {
    name: "protected-files",
    kind: "mechanical",
    passed: false,
    evidence: `Protected file(s) changed since loop start: ${changed.join(", ")}. Frozen files must not be modified by the loop.`,
  };
}

/**
 * The frozen rule set: the fields that define what the loop measures and when
 * it stops. Pinned once at start; any drift is treated as tampering because a
 * loop that cannot pass its guard must not be allowed to edit the guard.
 */
export function pinnedConfigFields(state: LoopState): Record<string, unknown> {
  return {
    verifyCommand: state.verifyCommand,
    guardCommand: state.guardCommand ?? null,
    promptVerifier: state.promptVerifier ?? null,
    metricName: state.metricName ?? null,
    metricDirection: state.metricDirection,
    targetMetric: state.targetMetric ?? null,
    maxIterations: state.maxIterations ?? null,
    protectedPaths: state.protectedPaths ?? [],
  };
}

/** Names of pinned fields whose current value differs from the stored pin. */
export function pinnedFieldsChanged(state: LoopState): string[] {
  const pinned = state.pinnedConfig;
  if (!pinned) return [];
  const current = pinnedConfigFields(state);
  return Object.keys(pinned).filter(
    (key) => JSON.stringify(pinned[key]) !== JSON.stringify(current[key])
  );
}

/**
 * Stop-the-line check against the on-disk state (the in-memory copy is a
 * snapshot from attach time, so tampering is only visible on disk). Returns a
 * refusal message naming the changed fields, or null when the pin holds.
 */
export function configPinRefusal(cwd: string, id: LaneId): string | null {
  const onDisk = loadState(cwd, id);
  if (!onDisk?.pinnedConfig) return null;
  const changed = pinnedFieldsChanged(onDisk);
  if (changed.length === 0) return null;
  return [
    `Pinned loop config was edited after start (${id.lane}/${id.runTag}): ${changed.join(", ")}.`,
    "The verifier and stop-condition fields are frozen anchors — a loop must not tune what measures it.",
    `Restore the pinned values in .multiloop/active/${id.lane}/${id.runTag}/state.json, or stop this loop and start a new one.`,
    "Refusing to proceed.",
  ].join("\n");
}
