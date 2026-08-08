#!/usr/bin/env node
// Detached loop driver for pi-multiloop (v0.2).
// Keeps the iterate -> measure -> decide cadence running without an
// interactive session by spawning one headless `pi -p --mode json` session
// per iteration. The extension's state machine, acceptance gates and anchors
// do all deciding inside that session; this script only orchestrates the
// sessions and enforces stop conditions.
//
// Why the driver reaps the child instead of waiting for it to exit:
// headless `pi -p` runs that execute tools spawn a large worker fan-out that
// keeps the process alive after the turn completes, so waiting on exit would
// stall every iteration. The iteration's durable result is written to
// state.json/results.jsonl by the loop tool handler DURING the turn, before
// the turn ends, so the driver detects "iteration advanced past the previous
// count" and then kills the session's process group.
//
// The driver pauses the loop for the duration of the run (the extension's
// phase tools answer regardless of pause status) so headless sessions never
// race the extension's session_start auto-continue; the extension itself
// marks completed/stopped on stop conditions, and the driver then exits.
//
// Usage:
//   node bin/multiloop-run.mjs <repo> <lane> [<runTag>] [options]
// Options:
//   --iterations N    Cap how many iterations this driver run drives
//   --timeout-sec S   Per-iteration pi timeout (default 900)
//   --pi-cmd CMD      Pi binary (default "pi")
//   --dry-run         Print the iteration prompt and exit without spawning
//   --verbose         Print per-iteration output
// Exit codes: 0 completed/stopped, 1 error/stuck, 2 usage.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

export function parseArgs(argv) {
  const args = [...argv];
  const opts = { iterations: Infinity, timeoutSec: 900, piCmd: "pi", dryRun: false, verbose: false };
  const positional = [];
  while (args.length) {
    const a = args.shift();
    if (a === "--iterations") opts.iterations = Number(args.shift());
    else if (a === "--timeout-sec") opts.timeoutSec = Number(args.shift());
    else if (a === "--pi-cmd") opts.piCmd = args.shift();
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--verbose") opts.verbose = true;
    else if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional.length < 2 || positional.length > 3) {
    throw new Error("Usage: multiloop-run <repo> <lane> [<runTag>] [--iterations N] [--timeout-sec S] [--pi-cmd CMD] [--dry-run] [--verbose]");
  }
  return { repo: positional[0], lane: positional[1], runTag: positional[2] ?? null, ...opts };
}

/** Strip session-routing variables so the child pi starts its own session. */
export function cleanChildEnv(env) {
  const clean = { ...env };
  delete clean.PI_SESSION_ID;
  delete clean.PI_INTERCOM_SESSION_ID;
  return clean;
}

export function probePi(piCmd) {
  // The probe exists to catch a missing/unexecutable pi binary early — not to
  // validate its flags, so any nonzero status counts as "pi responded". Only a
  // spawn error (ENOENT/EACCES) or a hang is a hard failure.
  let output = "";
  try {
    const r = spawnSync(piCmd, ["--help"], { encoding: "utf8", timeout: 15000 });
    output = String(r.stdout || "") + String(r.stderr || "");
    if (r.error) {
      return { ok: false, output, error: r.error.message };
    }
    if (r.status === null) {
      return { ok: false, output, error: `${piCmd} --help was killed by the 15000ms probe timeout` };
    }
    return { ok: true, output, error: null };
  } catch (e) {
    return { ok: false, output, error: String(e && e.message ? e.message : e) };
  }
}

export function readRegistry(repo) {
  const p = join(repo, ".multiloop", "registry.json");
  if (!existsSync(p)) return { version: 1, loops: [] };
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Resolve a loop: exact lane/run-tag, else latest by startedAt for the lane. */
export function resolveLoop(registry, lane, runTag) {
  const loops = (registry.loops ?? []).filter((l) => l.lane === lane);
  if (!loops.length) return null;
  if (runTag) return loops.find((l) => l.runTag === runTag) ?? null;
  return loops.slice().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
}

export function readLoopState(repo, entry) {
  const p = join(repo, entry.stateDir, "state.json");
  if (!existsSync(p)) throw new Error(`Loop state missing: ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Stop the loop from being auto-continued by session_start in the child pi.
 * A paused loop still answers every phase tool (the extension never gates the
 * tools on status), but session_start will not attach it, arm loop mode, or
 * queue a follow-up run. Written atomically (tmp + rename) like the
 * extension's own saveState. */
export function pauseLoop(repo, entry, state) {
  if (state.status !== "running") return state;
  const p = join(repo, entry.stateDir, "state.json");
  const tmp = p + ".tmp";
  const next = { ...state, status: "paused" };
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, p);
  return next;
}

/** Stop-condition gate. The extension completes loops itself; this is the driver's own. */
export function shouldContinue(state, opts) {
  if (state.status === "completed" || state.status === "stopped") {
    return { ok: false, reason: `loop ${state.status}` };
  }
  const cap = opts.iterations < Infinity ? opts.iterations : state.maxIterations;
  if (cap !== undefined && cap !== null && state.iteration >= cap) {
    return { ok: false, reason: `iteration cap ${cap} reached` };
  }
  return { ok: true, reason: "" };
}

/**
 * Thin kick for one detached iteration. The extension is the single source of
 * truth for the loop protocol: multiloop_resume's tool output carries the full
 * iteration context (goal, verify/guard commands, protected paths, stall and
 * drift warnings, mesh inbox) plus the iterate/measure/decide cadence, so this
 * prompt only names the target and the headless boundaries the driver owns.
 */
export function buildIterationPrompt(entry, nextIteration) {
  return [
    `You are executing exactly one iteration of the pi-multiloop loop lane '${entry.lane}' (run ${entry.runTag}, mode ${entry.mode}) in this repository — iteration #${nextIteration}.`,
    ``,
    `Step 0: call multiloop_resume with target '${entry.lane}/${entry.runTag}'. Its tool output is your full iteration context and protocol — follow it. (The driver paused the loop so this session owns the iteration; resuming is expected.)`,
    ``,
    `Boundaries:`,
    `- Run exactly one iteration (iterate, change, verify, measure, decide/log), then stop — the driver reaps this session once the iteration is recorded.`,
    `- If the resumed context warns about out-of-band edits, pinned config drift, or a failed check, stop and report it verbatim instead of working around it.`,
    `- Finish with a one-paragraph summary of what you changed and the recorded result.`,
  ].join("\n");
}

/**
 * Spawn a headless pi session in its own process group. The child is reaped
 * by the driver (see file header); detached:true gives it a fresh group that
 * the driver can SIGTERM/SIGKILL as a whole, covering the worker fan-out.
 * Returns the child, its collected output buffers, and the promisified exit.
 */
export function spawnIteration(cmd, argv, cwd, env) {
  const child = spawn(cmd, argv, {
    cwd,
    env: cleanChildEnv(env ?? process.env),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { text: "" };
  const tee = (chunk) => {
    if (chunk) output.text += chunk.toString();
  };
  child.stdout.on("data", tee);
  child.stderr.on("data", tee);
  const exited = new Promise((resolveExit) => {
    child.on("exit", (code, signal) => resolveExit({ code, signal }));
    // A failed spawn has no exit event; without this the driver would hang
    // forever on `await exited`. Surface the cause instead.
    child.on("error", (err) => {
      output.text += `[spawn error] ${err.message}\n`;
      resolveExit({ code: null, signal: null, error: err.message });
    });
  });
  return { child, output, exited };
}

/** Kill a detached child's whole process tree.
 *
 * POSIX: SIGTERM/SIGKILL the process group via process.kill(-pid).
 * Windows: process.kill(-pid) (group kill) is unsupported and throws, so the
 * native tree kill is taskkill /pid <pid> /T /F (there is no graceful
 * equivalent for a detached tree on Windows).
 */
/** taskkill argv for a Windows tree kill (no graceful kill exists there). */
export function winKillArgs(pid) {
  return ["taskkill", "/pid", String(pid), "/T", "/F"];
}

export function stopIteration(child, graceMs) {
  if (process.platform === "win32") {
    return new Promise((resolveStop) => {
      child.once("exit", () => resolveStop(true));
      setTimeout(() => {
        try {
          spawnSync("taskkill", winKillArgs(child.pid), { stdio: "ignore" });
        } catch {
          // Tree already gone.
        }
        try {
          child.kill(); // direct TerminateProcess fallback
        } catch {
          // Child already gone.
        }
        resolveStop(false);
      }, graceMs).unref();
    });
  }
  const group = -child.pid;
  const kill = (signal) => {
    try {
      process.kill(group, signal);
    } catch {
      // Group already gone.
    }
  };
  kill("SIGTERM");
  return new Promise((resolveStop) => {
    child.once("exit", () => resolveStop(true));
    setTimeout(() => {
      kill("SIGKILL");
      resolveStop(false);
    }, graceMs).unref();
  });
}

/** Poll state.json until the iteration counter passes `before`. */
export async function iterationAdvanced(repo, entry, before, timeoutMs, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const state = readLoopState(repo, entry);
      if ((state.iteration ?? 0) > before) return { advanced: true, state };
    } catch {
      // Transient read (mid-rename); keep polling.
    }
    if (Date.now() >= deadline) return { advanced: false, state: null };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message));
    return 2;
  }
  const repo = resolve(opts.repo);
  const registry = readRegistry(repo);
  const entry = resolveLoop(registry, opts.lane, opts.runTag);
  if (!entry) {
    console.error(`No loop found for lane '${opts.lane}'${opts.runTag ? ` run '${opts.runTag}'` : ""} in ${repo}.multiloop/registry.json`);
    return 1;
  }
  if (!opts.dryRun) {
    const probe = probePi(opts.piCmd);
    if (!probe.ok) {
      console.error(`multiloop-run: cannot run pi binary '${opts.piCmd}' (${probe.error}). Install pi or pass --pi-cmd <path>.`);
      if (probe.output.trim()) console.error(probe.output.trim().slice(0, 400));
      return 1;
    }
  }

  let state = pauseLoop(repo, entry, readLoopState(repo, entry));
  let driven = 0;
  while (driven < opts.iterations) {
    // The previous iteration's child may have resumed the loop; re-assert the
    // pause so session_start never auto-continues into the next child.
    state = pauseLoop(repo, entry, readLoopState(repo, entry));
    const gate = shouldContinue(state, opts);
    if (!gate.ok) {
      console.log(`multiloop-run: stopping — ${gate.reason}`);
      return 0;
    }
    const nextIteration = state.iteration + 1;
    const prompt = buildIterationPrompt(entry, nextIteration);
    if (opts.dryRun) {
      console.log(prompt);
      return 0;
    }
    console.log(`multiloop-run: iteration ${nextIteration} — spawning ${opts.piCmd} -p --mode json`);
    const before = state.iteration;
    const { child, output, exited } = spawnIteration(opts.piCmd, ["-p", "--mode", "json", prompt], repo);
    const outcome = await Promise.race([
      iterationAdvanced(repo, entry, before, opts.timeoutSec * 1000),
      exited.then(() => ({ advanced: false, state: null, exited: true })),
    ]);
    if (outcome.advanced) {
      // Result is durable in state.json; reap the session's process group.
      const graceful = await stopIteration(child, 3000);
      if (!graceful) console.log("multiloop-run: child did not exit on SIGTERM; killed");
    } else {
      await stopIteration(child, 3000).catch(() => {});
      // outcome.exited already tells whether the process ended; do not await
      // `exited` again — a child that survived the reap would hang the driver.
      if (outcome.exited) {
        // A session that exits without recording may still have finished the
        // work: the extension completes loops mid-session (target met, then
        // idle), and no new iteration is recorded because none is needed.
        // Distinguish completion from a dead session before blaming the child.
        const latest = readLoopState(repo, entry);
        if (latest.status === "completed" || latest.status === "stopped") {
          console.log(`multiloop-run: loop ${latest.status} during iteration ${nextIteration} — no further iteration required`);
          return 0;
        }
        console.error(`multiloop-run: session for iteration ${nextIteration} exited without recording the iteration`);
      } else {
        console.error(`multiloop-run: iteration ${nextIteration} timed out after ${opts.timeoutSec}s with no recorded result`);
      }
      if (opts.verbose && output.text.length) console.error(output.text.slice(-2000));
      return 1;
    }
    if (opts.verbose && output.text.length) console.log(output.text.slice(-2000));
    state = readLoopState(repo, entry);
    if (state.iteration === before) {
      console.error(`multiloop-run: iteration ${nextIteration} finished but no iteration was recorded — loop is stuck`);
      return 1;
    }
    driven++;
  }
  console.log(`multiloop-run: drove ${driven} iteration(s); loop status ${state.status}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main();
  process.exit(code);
}