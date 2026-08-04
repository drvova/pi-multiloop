import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type LoopState,
  loadState,
  readResults,
  stallStreak,
} from "../extensions/pi-multiloop/state.js";
import { applyLogIteration, establishBaseline } from "../extensions/pi-multiloop/loop.js";
import { type LaneId } from "../extensions/pi-multiloop/lanes.js";
import { laneFor, tmpPrefix, reproHint, seedFor, rng, pick, intBetween } from "./support/seed.js";
import { Session, startLoopOnDisk } from "./support/session-harness.js";
import type { ModeEntryLike } from "../extensions/pi-multiloop/mode.js";

/**
 * Environment matrix long-horizon.
 *
 * Runs the same randomized 60-turn session scenarios under different simulated
 * platforms, on whatever host the suite happens to run on (Linux dev box,
 * Windows CI runner, macOS). The filesystem seam is the point: on win32,
 * saveState's directory fsync (the POSIX crash-durability idiom after rename)
 * is rejected by the OS with EPERM, so the production guard must skip it.
 * Every other platform must call it (the mock counts the attempt and
 * succeeds; a real host dir fsync is not the seam under test).
 *
 * Platform is simulated by (a) overriding process.platform, and (b) mocking
 * node:fs so that fsyncSync on a directory handle throws EPERM -- if and only
 * if the profile asks for the Windows filesystem. The guard's job is to keep
 * that fsync from ever firing on win32. If the guard is ever removed, the
 * win32 horizons fail loudly on the first saveState.
 *
 * Directory handles are virtualized by the mock (synthetic negative fds)
 * because opening a directory with openSync(dir, 'r') itself throws on real
 * Windows; that keeps every profile deterministic on every host.
 */

// Shared, mutable probe consulted at call time by the mocked fsync (the mock
// factory runs once per file, so state must live outside it and be reset per
// case).
const fsProbe = vi.hoisted(() => ({
  winFs: false,
  dirFsyncAttempts: 0,
  dirFds: new Set<number>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  let syntheticFd = -1; // negative fds can never collide with real ones
  return {
    ...real,
    openSync(path: string, flag: string, mode?: string | number | null): number {
      if (flag === "r") {
        try {
          if (real.statSync(path).isDirectory()) {
            fsProbe.dirFds.add(syntheticFd);
            return syntheticFd--;
          }
        } catch {
          // open succeeded for a non-directory or vanishing path; not a dir fd.
        }
      }
      return real.openSync(path, flag, mode);
    },
    fsyncSync(fd: number): void {
      if (fsProbe.dirFds.has(fd)) {
        fsProbe.dirFsyncAttempts++;
        if (fsProbe.winFs) {
          throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" });
        }
        return; // real dir fsync is host-dependent; the seam under test is the guard
      }
      return real.fsyncSync(fd);
    },
    closeSync(fd: number): void {
      if (fsProbe.dirFds.has(fd)) return; // synthetic handle; nothing to close
      return real.closeSync(fd);
    },
  };
});

const REAL_PLATFORM = process.platform;

/**
 * The platforms under test. Each pairs a process.platform value with the
 * filesystem the loop sees there. win32 gets the EPERM-on-dir-fsync layer;
 * every POSIX flavor must call the dir fsync (mock counts the attempt).
 */
const ENVIRONMENTS = [
  { name: "linux", platform: "linux", dirFsyncMustFire: true },
  { name: "darwin", platform: "darwin", dirFsyncMustFire: true },
  { name: "freebsd", platform: "freebsd", dirFsyncMustFire: true },
  { name: "windows-x64", platform: "win32", dirFsyncMustFire: false },
  { name: "windows-arm64", platform: "win32", dirFsyncMustFire: false },
] as const;

const CASES = Array.from({ length: 40 }, (_, i) => i + 1);

function applyFilesystem(platform: string, winFs: boolean): void {
  fsProbe.winFs = winFs;
  fsProbe.dirFsyncAttempts = 0;
  fsProbe.dirFds.clear();
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), tmpPrefix("envmat"))); });
afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
  rmSync(cwd, { recursive: true, force: true });
});

for (const env of ENVIRONMENTS) {
  describe(`long horizon per environment: ${env.name} (${reproHint()})`, () => {
    it.each(CASES)("case %i", (index) => {
      applyFilesystem(env.platform, !env.dirFsyncMustFire);

      const next = rng(seedFor(`env-${env.name}`, index));
      const id = laneFor(`env-${env.name}`, index);
      startLoopOnDisk(cwd, id, { maxIterations: 200 });
      const state = loadState(cwd, id)!;
      establishBaseline(cwd, id, state, 50);

      const branch: ModeEntryLike[] = [];
      let session = new Session(cwd, branch).start();
      let expectedMode = session.loopMode;

      for (let turn = 0; turn < 60; turn++) {
        // Scenario knobs, randomized per turn, identical distribution for
        // every environment so the only variable is the filesystem.
        if (next() < 0.25 && expectedMode) {
          // Crash between queueing and delivery: a fresh process re-arms the
          // owed continuation exactly once (its own first-turn queue), and the
          // durable flag clears only on delivery.
          session.crashBeforeDelivery();
          session = new Session(cwd, branch).start();
          expect(session.continuations).toBe(1);
          expect(session.owedCount().length).toBe(1);
          session.deliverContinuation();
          expect(session.owedCount().length).toBe(0);
        }

        if (next() < 0.15 && expectedMode) {
          // Explicit disarm must drop durable intent for good.
          session.disarmViaCommand();
          expect(session.owedCount().length).toBe(0);
          const fresh = new Session(cwd, branch).start();
          expect(fresh.loopMode).toBe(false);
          expect(fresh.continuations).toBe(0);
          session = fresh;
          expectedMode = false;
        }

        if (next() < 0.3 && !expectedMode) {
          session.armViaTool();
          expectedMode = true;
        }

        const ranTool = next() < 0.7;
        if (ranTool) {
          session.toolCall();
          // Identical "same tweak" repeats feed the stall streak.
          const changes = next() < 0.5 ? "same tweak" : pick(next, ["tweak-a", "tweak-b", "tweak-c"]);
          applyLogIteration(cwd, id, state, "log", intBetween(next, 1, 60), changes);
        }

        const running = session.runningCount() > 0;
        const shouldContinue = expectedMode && session.loopTurnActive && running;
        const before = session.continuations;
        session.endTurn();
        expect(session.continuations).toBe(before + (shouldContinue ? 1 : 0));

        // Every persisted snapshot stays consistent with the log across the
        // whole horizon, under every filesystem.
        const fresh = loadState(cwd, id)!;
        expect(fresh.stallStreak).toBe(stallStreak(readResults(cwd, id)));
      }

      if (env.dirFsyncMustFire) {
        // POSIX: the guard called the dir fsync (mock counted the attempt).
        expect(fsProbe.dirFsyncAttempts).toBeGreaterThan(0);
      } else {
        // Windows: the guard kept the EPERM-prone dir fsync from ever running.
        expect(fsProbe.dirFsyncAttempts).toBe(0);
      }
    });
  });
}