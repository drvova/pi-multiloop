<p align="center"><img src="pi-logo-animated.svg" width="200" alt="pi-multiloop logo"></p>

# pi-multiloop

> **Special thanks to [lhl/pi-multiloop](https://github.com/lhl/pi-multiloop) — the original multi-lane loop engine that inspired this project.**
> Same dream, fresh batteries. 💖

A [Pi](https://pi.dev) extension for running **many autonomous loops at once** in a single worktree — each with its own little lane, its own state, and its own dreams.

## Why

Most loop tools run *one* loop at a time. Real work is rarely that linear — you might be shaving bundle size while also fixing flaky tests, or cutting latency while chewing through a TODO list. Those tasks touch different files but share the same build.

pi-multiloop gives each loop its own **lane** so they can run side by side without separate branches or worktrees. Parallel loops, zero turf wars.

## Features

- **Multi-loop isolation** — multiple loops on one worktree, each with independent state
- **Four modes:**
  - **Optimize** — edit, measure, keep or revert, repeat
  - **Research** — log results without keep/revert, for experiments and sweeps
  - **Dev** — implement, test, commit with iteration tracking
  - **Punchlist** — work through a markdown checklist
- **Flexible verification** — use any script or command to measure progress
- **Compound verifiers** — combine a metric with test guards and correctness checks
- **Stop conditions** — cap by iteration count or target metric, stored in loop state
- **Confidence scoring** — MAD-based scoring for noisy benchmarks
- **Durable history** — append-only JSONL log per lane, survives restarts and compaction
- **Auto-continuation** — loops queue their next step automatically
- **Compaction-aware resume** — loops recover gracefully after context compaction
- **Escalation** — strategy adjusts after repeated failures
- **Stall detection** — notices when iterations repeat without progress and says "hey, try something else"
- **Durable intent** — a queued continuation survives a crash between queue and delivery
- **Frozen anchors** — declare files the loop must never modify (`protectedPaths`); their content is hash-verified at every measure, so acceptance blocks a keep if the optimizer touched them. Pin your verifier scripts there too: an audit that quietly changes is a silent downgrade of the audit
- **Config pinning** — the verifier and stop-condition fields are pinned at start; editing them mid-loop stops the line and names the tampered field
- **Independent re-verification** — optional `auditVerifier` command that the extension itself executes at every measure (never the agent), compares its numeric output against the reported metric, and blocks acceptance on disagreement — the graded party cannot present its own grade
- **Rollback verified, not asserted** — optional `revertVerifier` command the extension runs at iterate to fingerprint the workspace (content hash), then re-runs at revert: the fingerprint must be reproduced byte-for-byte or the revert is refused. The workspace must actually be restored to its pre-change state, on the extension's word — a coincidentally unchanged metric proves nothing. The boundary is hashed at loop start and after every decision, so even the first iteration refuses edits that happened outside an iteration
- **No more deciding on a coin flip** — optional `minMeasurements` (default 1) raises how many runs must back a keep/revert; undersampled loops degrade to log instead of promoting on noise (deterministic metrics keep the fast path)
- **Out-of-band edits refused** — the extension fingerprints the workspace at loop start and at every decision boundary; editing files outside an iteration is detected at the next `multiloop_iterate` and stops the line, so a revert can never be verified against a dirty baseline. With a `revertVerifier` the verifier command defines the fingerprint; without one, a built-in git working-tree fingerprint covers every loop automatically
- **Pivots actually teach** — the latest pivot lesson is rendered into every continuation prompt instead of disappearing into a `lessons.md` nobody reads
- **Champion comparison** — `multiloop_compare` (or `/multiloop compare perf mem`) renders two runs side by side with a champion verdict, reading archived runs too: offline champion-challenger evaluation on frozen history, with zero cross-lane writes

## Install

```bash
pi install git:https://github.com/drvova/pi-multiloop
```

## Quick start

```bash
# No args = show status, or launch setup guide if no loops exist yet
/multiloop

# Start a new loop with a goal
/multiloop improve inference latency, verify likely ./bench.py --quick

# Check status
/multiloop status
/multiloop ls

# Pause, resume, stop, or archive
/multiloop pause perf
/multiloop resume perf/run-001
/multiloop stop perf/run-001
```

## Modes

| Mode | What it does | Best for |
|---|---|---|
| **Optimize** | Edit, measure, keep if better or revert, repeat | Performance tuning, latency, bundle size |
| **Research** | Run experiments and log all results for comparison | Ablations, parameter sweeps |
| **Dev** | Pick a task, implement, test, commit | Feature work with iteration tracking |
| **Punchlist** | Parse a checklist, do each item, check it off | TODO lists, migration tasks |

## Compound verifiers

Combine a metric with verification checks. A result is accepted only when the metric improves **and** all checks pass:

```json
{
  "lane": "perf",
  "measurements": [356],
  "checks": [
    {"name": "unit tests", "kind": "mechanical", "passed": true, "command": "npm test"},
    {"name": "output correctness", "kind": "prompt", "passed": true, "evidence": "Output matches fixtures"}
  ]
}
```

If a configured check is missing from the measurement, it counts as failed. This prevents a faster-but-broken result from being kept.

## Confidence scoring

One measurement works for deterministic metrics (bundle size, LOC). For noisy metrics (timing, training loss), provide multiple measurements — the improvement must clear the MAD noise floor, not just show any gain.

| Measurements | Improvement test |
|---|---|
| 1 | `delta > 0` |
| 2+ | `delta > 2 × MAD` |

## Stop conditions

Set how a loop ends at setup time. The bound persists in loop state, surviving compaction and restarts.

| Setup answer | Argument | Loop stops when |
|---|---|---|
| "cap at 10 iterations" | `maxIterations: 10` | iteration reaches 10 |
| "until checklist is done" | `targetMetric: 0` | open items hit 0 |
| "stop at 200ms" | `targetMetric: 200` | metric reaches target |
| "until I stop it" | omit both | manual stop only |

## How state works

All state lives in `.multiloop/` at your repo root:

```
.multiloop/
├── registry.json          # index of all loops
├── active/<lane>/<run>/
│   ├── results.jsonl      # append-only iteration log
│   ├── state.json         # resume snapshot
│   └── lessons.md         # strategy notes (optional)
└── archive/               # archived runs
```

Each lane is independent. The JSONL log is human-readable and diff-friendly — you can commit it to track optimization history alongside code, or gitignore it.

### Lifecycle

1. **`/multiloop`** — show status or launch setup guide
2. **Iterate** — `multiloop_iterate` marks the start, `multiloop_measure` records results, `multiloop_decide` keeps or reverts
3. **Auto-continue** — loops queue the next step automatically while running
4. **Stop or complete** — manual stop, or automatic when a stop condition is met
5. **Resume** — reconstructs state from disk after restart or compaction
6. **Archive** — moves finished runs to `archive/`

### Loop mode

Loop mode is durable — a running loop on disk means the previous session intended it to keep going. A new session picks it up automatically.

```bash
/multiloop off   # pause auto-continuation, loop stays on disk
/multiloop on    # resume auto-continuation
```

## Detached mode (v0.2)

Drive a loop with zero human and zero interactive session: `bin/multiloop-run.mjs` spawns a headless `pi -p --mode json` per iteration, waits for the iteration counter to advance, reaps the child (real pi workers never exit on their own), and moves on.

```bash
node bin/multiloop-run.mjs <repo> <lane> [<runTag>] --iterations N
```

- The driver pauses the loop first so `session_start` never auto-continues; each child is told to `multiloop_resume` as step 0, so exactly one session owns each iteration.
- Polls `state.json` for the iteration counter; on advance it gives the child a short grace period, then terminates the whole process group.
- Exits `0` when the loop completes or the iteration cap is reached, `1` on a stuck session or driver error, `2` on usage errors.
- Flags: `--iterations N` (cap), `--timeout-sec` (per-iteration, default 900), `--pi-cmd` (override), `--dry-run` (print the prompt, spawn nothing), `--verbose`.
- The driver leaves the loop `running` when it stops early — pick it up interactively or drive it again.

## Composability

Works alongside other Pi extensions:

- **pi-boomerang** — context compression for long loops
- **pi-supervisor** — goal enforcement and steering
- **pi-review-loop** — quality gates between iterations

## Development

```bash
git clone https://github.com/drvova/pi-multiloop
cd pi-multiloop
npm install
npx tsc --noEmit     # typecheck
npx vitest run       # tests
pi install .         # load locally
```

The test suite draws a fresh random seed each run. To reproduce a failure, copy the seed from the output and replay it:

```bash
MULTILOOP_TEST_SEED=46d5c2a7 npx vitest run
```

## More docs

- [Loop setup guide](skills/multiloop/references/LOOP_GUIDE.md)
- [State and lifecycle](docs/STATE.md)
- [Project plan](docs/PLAN.md)

## Related projects

**Autoresearch / autoloop:**

- [lhl/pi-multiloop](https://github.com/lhl/pi-multiloop) — the original multi-lane pi loop that inspired this one
- [karpathy/autoresearch](https://github.com/karpathy/autoresearch) — the original edit → benchmark → keep/revert pattern
- [lhl/codex-autoresearch](https://github.com/lhl/codex-autoresearch) — multi-loop support for Codex
- [uditgoenka/autoresearch](https://github.com/uditgoenka/autoresearch) — Claude Code / OpenCode / Codex skill
- [armgabrielyan/autoloop](https://github.com/armgabrielyan/autoloop) — agent-agnostic autoloop

**Pi extensions:**

- [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch)
- [mikeyobrien/pi-autoloop](https://github.com/mikeyobrien/pi-autoloop)
- [nicobailon/pi-boomerang](https://github.com/nicobailon/pi-boomerang)
- [tintinweb/pi-supervisor](https://github.com/tintinweb/pi-supervisor)
- [nicobailon/pi-review-loop](https://github.com/nicobailon/pi-review-loop)
- [samfoy/pi-ralph](https://github.com/samfoy/pi-ralph)
- [nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger)
- [burggraf/pi-teams](https://github.com/burggraf/pi-teams)
- [lsj5031/PiSwarm](https://github.com/lsj5031/PiSwarm)
- [ArtemisAI/pi-loop](https://github.com/ArtemisAI/pi-loop)
- [tintinweb/pi-schedule-prompt](https://github.com/tintinweb/pi-schedule-prompt)

## License

MIT
