import { randomBytes } from "node:crypto";

/**
 * Per-run randomisation with exact reproducibility.
 *
 * Every run draws a fresh seed, so no two runs exercise the same values, lane
 * identifiers, or temp directories. The seed is printed once at startup and can
 * be pinned to reproduce any failure byte for byte:
 *
 *   MULTILOOP_TEST_SEED=a1b2c3d4 npx vitest run
 *
 * Randomness without reproducibility is a CI failure nobody can chase, so the
 * seed is treated as part of the test output rather than an implementation
 * detail.
 */

export const SEED_ENV = "MULTILOOP_TEST_SEED";

function parseSeed(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 16);
  return Number.isFinite(value) ? value >>> 0 : null;
}

/** Draw a fresh seed. Called once per run by the global setup. */
export function drawSeed(): string {
  return randomBytes(4).toString("hex");
}

/** The seed governing this run, as an unsigned 32-bit integer. */
export const RUN_SEED: number =
  parseSeed(process.env[SEED_ENV]) ?? parseSeed(drawSeed())!;

/** Short stable token for this run, safe for lane ids and directory names. */
export const RUN_HASH: string = RUN_SEED.toString(16).padStart(8, "0");

/** FNV-1a, used to fold a test label into the run seed. */
function fold(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Derive a seed for one test. Stable within a run so a failure reproduces from
 * RUN_SEED alone, and different across runs so coverage keeps moving.
 */
export function seedFor(label: string, index = 0): number {
  return (fold(`${RUN_HASH}:${label}:${index}`) ^ RUN_SEED) >>> 0;
}

/** Deterministic RNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length) % values.length];
}

export function intBetween(next: () => number, min: number, max: number): number {
  return min + Math.floor(next() * (max - min + 1));
}

/** A value that is sometimes fractional, to catch integer-only assumptions. */
export function numberBetween(next: () => number, min: number, max: number): number {
  const raw = min + next() * (max - min);
  return next() < 0.5 ? Math.round(raw) : Math.round(raw * 4) / 4;
}

/**
 * Lane id unique to this run. Distinct identifiers every run prove the code
 * never depends on a particular lane name, and stop state from one run bleeding
 * into another.
 */
export function laneFor(prefix: string, suffix: string | number = ""): { lane: string; runTag: string } {
  const tail = suffix === "" ? "" : `-${suffix}`;
  return {
    lane: `${prefix}${RUN_HASH}`,
    runTag: `r${RUN_HASH}${tail}`,
  };
}

/** Temp-directory prefix carrying the run hash, so stray dirs are traceable. */
export function tmpPrefix(label: string): string {
  return `multiloop-${label}-${RUN_HASH}-`;
}

/** Reproduction hint attached to generated-test names. */
export function reproHint(): string {
  return `${SEED_ENV}=${RUN_HASH}`;
}
