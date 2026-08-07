export interface DriverOpts {
  repo: string;
  lane: string;
  runTag: string | null;
  iterations: number;
  timeoutSec: number;
  piCmd: string;
  dryRun: boolean;
  verbose: boolean;
}
export interface LoopRegistryEntry {
  lane: string;
  runTag: string;
  mode?: string;
  status?: string;
  startedAt?: string;
  stateDir?: string;
}
export interface GateResult {
  ok: boolean;
  reason: string;
}
export interface SpawnedIteration {
  child: import("node:child_process").ChildProcess;
  output: { text: string };
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
export interface AdvanceResult {
  advanced: boolean;
  state: Record<string, unknown> | null;
}
export function parseArgs(argv: string[]): DriverOpts;
export function probePi(piCmd: string): { ok: boolean; output: string; error: string | null };
export function winKillArgs(pid: number | string): string[];
export function cleanChildEnv(env: Record<string, string | undefined>): Record<string, string | undefined>;
export function readRegistry(repo: string): { version: number; loops: LoopRegistryEntry[] };
export function resolveLoop(registry: { loops: LoopRegistryEntry[] }, lane: string, runTag: string | null): LoopRegistryEntry | null;
export function readLoopState(repo: string, entry: { stateDir?: string }): Record<string, unknown>;
export function pauseLoop(repo: string, entry: { stateDir?: string }, state: Record<string, unknown>): Record<string, unknown>;
export function shouldContinue(state: Record<string, unknown>, opts: Partial<DriverOpts>): GateResult;
export function buildIterationPrompt(entry: { lane: string; runTag: string; mode?: string }, nextIteration: number): string;
export function spawnIteration(cmd: string, argv: string[], cwd: string, env?: Record<string, string | undefined>): SpawnedIteration;
export function stopIteration(child: import("node:child_process").ChildProcess, graceMs: number): Promise<boolean>;
export function iterationAdvanced(repo: string, entry: { stateDir?: string }, before: number, timeoutMs: number, intervalMs?: number): Promise<AdvanceResult>;
export function main(): Promise<number>;