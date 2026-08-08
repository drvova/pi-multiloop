<p align="center"><img src="pi-logo-animated.svg" width="200" alt="pi-multiloop logo"></p>

# pi-multiloop

> **Special thanks to [lhl/pi-multiloop](https://github.com/lhl/pi-multiloop) — the original multi-lane loop engine that inspired this project.**
> Same dream, fresh batteries. 💖

A [Pi](https://pi.dev) extension for running **many autonomous loops at once** in a single worktree — each with its own little lane, its own state, and its own dreams.

## Why

Most loop tools run *one* loop at a time. Real work is rarely that linear — you might be shaving bundle size while also fixing flaky tests, or cutting latency while chewing through a TODO list. Those tasks touch different files but share the same build.

pi-multiloop gives each loop its own **lane** so they can run side by side without separate branches or worktrees. Parallel loops, zero turf wars.

> **New — Loop subagents & mesh.** Hand a loop to an isolated background agent
> (`multiloop_agent`) that runs the whole cadence itself — live fleet widget,
> mid-run steering, completion reports. Lanes talk to each other via file-based
> mailboxes (`multiloop_send` / `multiloop_inbox`) — dead-end warnings and
> breakthrough hints surface in the next iteration's context automatically.

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
- **Loop subagents** — `multiloop_agent` spawns a loop into an isolated background subagent that inherits your session's model: live fleet widget, completion notifications, mid-run steering, and result/stop/list management tools
- **Mesh mailbox** — `multiloop_send` posts a note to another lane's inbox; `multiloop_inbox` reads it. Messages surface automatically in the recipient's next iteration context as a "Mesh inbox" block, so sibling lanes share dead-end warnings and breakthrough hints without live IPC — the mailbox file is the channel, mirroring the role `results.jsonl` plays for metrics
- **Lane proposals (speciation with an approval gate)** — a lane that discovers orthogonal work files a structured proposal (`multiloop_propose_lane`) instead of starting a lane itself; the parent session surfaces pending proposals, and only a human approval (`/multiloop approve <id>`) starts the lane — born bounded by the proposer's `maxIterations` budget. Pending-queue cap and one-pending-per-lane make uncontrolled speciation structurally impossible
- **Shared knowledge board** — `multiloop_publish` distills a durable lesson (dead end, saturation point, verifier gotcha) to `.multiloop/shared/knowledge.md`; every lane's future iteration context carries it under "Shared knowledge". Pivot lessons are mirrored automatically, so the board fills even if nobody publishes by hand
- **Peer results** — `multiloop_results` reads sibling lanes' decided outcomes (keep/revert/log with a metric), newest last, excluding the caller's own lane; the same bounded tail folds into every iteration context as a "Peer results" block, so a lane never repeats a regression another lane already measured. Read-only, file-based — the shared-journal pattern (Optuna's JournalStorage), no live IPC
- **Swarm homeostasis** — when a lane reaches its target metric, the extension broadcasts one `CONVERGED` mesh message to every active sibling (surfacing in their next iteration context), so the swarm stops or retargets instead of burning iterations after the goal is met; and a low-confidence improvement (MAD) is mechanically downgraded from keep to log with a remeasure directive — noisy data never becomes a permanent change or a sibling's peer result

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

## Subagents — autonomous loop runners

> `multiloop_agent` hands a loop to an isolated child Pi session that inherits
`multiloop_agent` hands a loop to an isolated child Pi session that inherits
your current model and runs the whole cadence itself — start, iterate,
measure, decide — until the stop condition, then reports back:

```
your session                    child Pi session (isolated)
┌─────────────────┐             ┌──────────────────────────────┐
│ multiloop_agent ├──── spawn ─▶│ Loop Runner: start → iterate │
│                 │             │ → measure → decide → … done  │
│  steer ─────────┼────────────▶│ (mesh, knowledge, peers,     │
│  result/stop    │             │  propose — full tool set)    │
│  fleet widget ◀─┼── progress  └──────────────┬───────────────┘
└────────┬────────┘   report ◀──┬──────────────┘
         │                      │ both read/write
         ▼                      ▼
              .multiloop/  (one shared state substrate)
```

```json
{
  "goal": "Reduce bundle size",
  "verifyCommand": "node scripts/bundle-size.mjs",
  "lane": "size",
  "metricDirection": "lower",
  "guardCommand": "npm test",
  "maxIterations": 10
}
```

Runs are background by default: progress shows live in the `multiloop-agents`
widget (spinner, tree, per-agent iteration/metric/decision stats), and the
report arrives as a follow-up message. Parallel runs share the `.multiloop/`
registry, so `/multiloop` status and `multiloop_compare` see them too. Steer a
running agent with `multiloop_agent_steer`, poll it with
`multiloop_agent_result`, stop it with `multiloop_agent_stop`, list the fleet
with `multiloop_agents` or `/multiloop-agents`. Details:
[packages/multiloop-agent](packages/multiloop-agent/README.md).

Fleet children get every `multiloop_*` tool including the mesh — `multiloop_send`
and `multiloop_inbox` are in the child allowlist, and the Loop Runner prompt
teaches the mesh as the one sanctioned cross-lane channel (the "drive only your
own loop" rule otherwise stands). Messages addressed to a fleet child surface in
its next iteration context alongside messages from interactive lanes.

## Mesh — inter-lane messaging

Lanes are independent by design, but sometimes one lane discovers something
another should know. The mesh is a file-based mailbox: `multiloop_send` posts a
note to another lane's inbox; `multiloop_inbox` reads it. Messages surface
automatically as a **Mesh inbox** block in the recipient's next iteration
context — no live IPC, no sockets, no race conditions. The mailbox file is the
channel, mirroring the role `results.jsonl` plays for metrics.

```
lane "perf"                                         lane "quant"
    │                                                    ▲
    │  multiloop_send                                    │  its next iteration context:
    ▼                                                    │  "Mesh inbox (1 pending):"
  .multiloop/active/quant/<run>/mesh.jsonl  ─────────────┘
    (append-only mailbox — the file is the channel)
```

```bash
# Lane "perf" warns lane "quant" about a flaky verify command
multiloop_send from="perf/run-001" to="quant/run-002" body="verify is flaky under load — add --retry 3"

# Read your inbox
multiloop_inbox target="quant/run-002"
```

Works across all three execution paths — interactive sessions, fleet
subagents, and detached headless runs. A fleet-tools sync test enforces that
the mesh tools stay in the child allowlist (the seam failed once; it is now
immune).

Mesh is directed and transient — "you should know this soon." For lessons
everyone should keep forever, see the knowledge board below.

## Peer results — learn from measured outcomes, not just prose

Every lane's `results.jsonl` is an append-only journal of *decided* iterations
(metric + keep/revert/log). `multiloop_results` reads sibling lanes' journals
read-only, and each iteration context carries a "Peer results" block — so a lane
never repeats a regression a peer already measured. Only decided outcomes
surface; a peer's in-flight half-state is invisible by construction.

```
lane A results.jsonl ─┐
lane B results.jsonl ─┼─▶ multiloop_results ─▶ "Peer results" block in every
lane C results.jsonl ─┘   (decided rows only)    lane's next iteration
```

## Knowledge board — durable cross-lane memory

Mesh is directed and transient ("you should know this soon"). The knowledge
board is undirected and durable ("everyone should know this forever").
`multiloop_publish` distills a lesson — a dead end, a saturation point, a
verifier gotcha — to `.multiloop/shared/knowledge.md`, and every lane's future
iteration context carries the tail under "Shared knowledge". Pivot lessons
mirror automatically, so the board fills even when nobody publishes by hand.

```
any lane ── multiloop_publish ──┐
pivot ──── automatic mirror ────┼─▶ .multiloop/shared/knowledge.md
                                │                │
                                ▼                ▼
                     every lane, every future iteration:
                     "Shared knowledge (N entries from all lanes)"
```

## Lane proposals — speciation with an approval gate

A lane that discovers orthogonal work mid-loop cannot start a lane itself —
workers drive exactly one loop. It files a structured proposal instead; the
parent session surfaces it; only a human approval starts the lane, born bounded
by the proposer's budget.

```
worker lane                    commons                      human
    │   multiloop_propose_lane   ▼                            │
    ├──────────────────────▶ proposals.json ── surfaces in ──▶│ /multiloop approve 3
    │                        (pending ≤ 5, one per lane name) │        │
    │   mesh: "approved — started as deps/run-x" ◀────────────┼────────┘
    ▼                                                         ▼
proposer notified either way                    new lane starts via the
                                                standard startLoop path
```

Fleet children can propose but never approve — `multiloop_approve` and
`multiloop_reject` are parent-only tools, enforced by the allowlist sync test.

## Swarm homeostasis — convergence and confidence reflexes

Two reflexes are enforced by the engine, not left to agent goodwill: when a lane
reaches its target metric, one CONVERGED mesh broadcast tells every active
sibling to stop or retarget instead of burning iterations; and a low-confidence
improvement is downgraded from keep to log with a remeasure directive, so noisy
data can never drive a permanent workspace change.

```
lane hits targetMetric ──▶ CONVERGED broadcast ──▶ every sibling's mesh inbox
noisy "improvement"  ──▶ confidence gate      ──▶ keep downgraded to log
                                                  (re-measure first)
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
│   ├── lessons.md         # strategy notes (optional)
│   └── mesh.jsonl         # inter-lane inbox (optional)
├── shared/
│   ├── knowledge.md       # durable cross-lane lessons (optional)
│   └── proposals.json     # lane proposals awaiting approval (optional)
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

Drive a loop with zero human and zero interactive session: `packages/multiloop-run/bin/multiloop-run.mjs` spawns a headless `pi -p --mode json` per iteration, waits for the iteration counter to advance, reaps the child (real pi workers never exit on their own), and moves on. The driver prompt is a thin kick — it names the target and tells the child to call `multiloop_resume` as step 0; the extension's tool output is the single source of truth for the iteration protocol (goal, verify command, guards, mesh inbox), so the driver never duplicates what the extension already owns.

```bash
node packages/multiloop-run/bin/multiloop-run.mjs <repo> <lane> [<runTag>] --iterations N
```

- The driver pauses the loop first so `session_start` never auto-continues; each child is told to `multiloop_resume` as step 0, so exactly one session owns each iteration.
- Polls `state.json` for the iteration counter; on advance it gives the child a short grace period, then reaps it — POSIX: SIGTERM then SIGKILL the whole process group; Windows: `taskkill /T /F` (native tree kill). Reaping is best-effort: the driver trusts the durable `state.json` result and never hangs on a child that refuses to exit.
- Probes the pi binary once before driving — a missing or non-responsive `--pi-cmd` stops the run before a single iteration is spawned.
- Exits `0` when the loop completes or the iteration cap is reached, `1` on a stuck session or driver error, `2` on usage errors.
- Flags: `--iterations N` (cap), `--timeout-sec` (per-iteration, default 900), `--pi-cmd` (override), `--dry-run` (print the prompt, spawn nothing), `--verbose`.
- The driver leaves the loop `running` when it stops early — pick it up interactively or drive it again.
- A human `/multiloop stop` or `/multiloop pause` takes effect **between** sessions: the running headless child finishes its pending iteration and records it, and the driver exits at the next stop-condition check.

## Architecture

The system is five packages that compose as one organism — one brain, one
session core, two execution faces, one front door:

```
multiloop-skill            setup wizard → multiloop_start
        │
multiloop (extension)      THE BRAIN — loop state machine, keep/revert
        │                  gates, anchors, mesh mailbox, all tools
        │
   child-agent             THE SESSION CORE — isolated in-process sessions
        │                  (single worker mechanism, shared by both faces)
   ┌────┴─────┐
multiloop-agent         multiloop-run
in-session fleet face   detached CLI face
fleet widget, steering   cron/CI, poll-and-reap
        └──── both delegate protocol to the extension's tools ────┘
```

Neither face encodes loop protocol — both get it from the extension's tool
outputs (the detached driver's prompt is a thin kick that calls
`multiloop_resume`; the fleet child loads the extension inline). `.multiloop/`
on disk is the single state substrate all five packages share.

| Package | Role |
|---|---|
| `@multiloop/extension` | Loop state machine, tools, mesh, anchors, widget |
| `@multiloop/skill` | Setup wizard skill |
| `@multiloop/child-agent` | Shared isolated session core (spawn, abort, report) |
| `@multiloop/agent` | Fleet runner: background Loop Runner children, widget, steering |
| `@multiloop/run` | Detached driver: headless `pi -p` per iteration, poll-and-reap |

A fleet-tools sync test (`packages/multiloop/tests/fleet-tools.test.ts`)
enforces that the extension's registered `multiloop_*` tools stay in exact set
sync with the fleet child allowlist — a tool added to the extension but not
allowlisted for children fails the build. The mesh tools shipped hidden once;
that seam is now immune.
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

[**CI**](https://github.com/drvova/pi-multiloop/actions/workflows/test.yml) runs the full suite on `ubuntu-latest`, `windows-latest` and `macos-latest` — the Windows job has caught and fixed real cross-platform bugs (CRLF shebangs, cmd.exe quoting, illegal path characters, process-group kills), so the suite is genuinely exercised everywhere, not assumed portable.

A real-headless end-to-end runs `scripts/e2e-optimize.sh` (spawns actual `pi` sessions via the detached driver and asserts keep/revert acceptance gates work headless — takes minutes, manual by design).

## More docs

- [Loop setup guide](packages/multiloop-skill/skills/multiloop/references/LOOP_GUIDE.md)
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
