import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findInvalidProtectedPaths,
  snapshotProtectedHashes,
  hashFile,
} from "../extensions/pi-multiloop/anchors.js";
import {
  readLoopState,
  shouldContinue,
} from "../../multiloop-run/bin/multiloop-run.mjs";
import { laneFor, tmpPrefix } from "./support/seed.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), tmpPrefix("fix")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("protectedPaths file validation (EISDIR prevention)", () => {
  it("flags directories as invalid protected paths", () => {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "ok.txt"), "content");

    const invalid = findInvalidProtectedPaths(cwd, ["src", "ok.txt", "ghost.txt"]);

    expect(invalid).toEqual(["src"]);
  });

  it("accepts missing files as legal protected state", () => {
    expect(findInvalidProtectedPaths(cwd, ["does-not-exist.txt"])).toEqual([]);
  });

  it("snapshotProtectedHashes throws on a directory instead of EISDIR-ing mid-iteration", () => {
    writeFileSync(join(cwd, "a.txt"), "a");
    mkdirSync(join(cwd, "dir"));

    const snapshot = snapshotProtectedHashes(cwd, ["a.txt", "missing.txt"]);
    expect(snapshot["a.txt"]).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot["missing.txt"]).toBe("<missing>");

    // Choke-point guard: the throw names the offending directory.
    expect(() => snapshotProtectedHashes(cwd, ["a.txt", "dir"])).toThrow(/not directories.*dir/);
    // And the raw hasher on a directory still throws (documents why the guard exists).
    expect(() => hashFile(join(cwd, "dir"))).toThrow();
  });
});

describe("driver self-completion exit (multiloop-run)", () => {
  function writeLoop(status: string) {
    const id = laneFor("selfcomplete");
    const dir = join(cwd, ".multiloop", "active", id.lane, id.runTag);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ lane: id.lane, runTag: id.runTag, status, iteration: 3 })
    );
    return { repo: cwd, entry: { lane: id.lane, runTag: id.runTag, stateDir: join(".multiloop", "active", id.lane, id.runTag) } };
  }

  it("a loop that completed mid-session is not an error", () => {
    const { repo, entry } = writeLoop("completed");
    const state = readLoopState(repo, entry);
    // The fix's predicate: terminal status means no further iteration required.
    expect(state.status).toBe("completed");
    expect(shouldContinue(state, { iterations: Infinity }).ok).toBe(false);
  });

  it("a loop still running after a dead session IS an error", () => {
    const { repo, entry } = writeLoop("running");
    const state = readLoopState(repo, entry);
    expect(shouldContinue(state, { iterations: Infinity }).ok).toBe(true);
  });
});
