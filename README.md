# pi-multiloop

An autoloop/autoresearch extension for [Pi](https://pi.dev) coding agent that lets you run multiple loops in the same worktree with isolated state per lane.

## Why

Other loop extensions only support one loop per session or worktree. If you're tuning a CUDA kernel and sweeping quantization parameters at the same time, those experiments touch different files but share the same build artifacts. pi-multiloop lets each loop have its own lane with independent state, so you don't need extra worktrees or branches.

## Features

- **Multi-loop isolation** — run multiple loops on the same worktree, each with its own lane and state
- **Four modes** — flexibly supports different types of loops:
  - **Optimize** — the classic edit, measure, keep/revert cycle
  - **Research** — log results from ablations or parameter sweeps without keep/revert
  - **Dev** — implement, test, commit with iteration tracking
  - **Punchlist** — iterate through a checklist until everything is done
- **Flexible goals** — verify with any script or command you want
- **Compound verifiers** — combine a metric with mechanical guards and prompt-based correctness checks; keep is recommended only when the metric improves and all checks pass
- **Bounded stop conditions** — cap a loop by iteration count or metric target at setup; the bound lives in loop state, so it survives compaction and restarts
- **Confidence scoring** — supports Median Absolute Deviation (MAD) to handle noisy benchmarks like GPU timing or training loss
- **Durable history** — append-only JSONL per lane, survives context resets and restarts
- **Mechanical continuation** — loop-owned turns automatically queue the next required action while the loop remains running, while still allowing brief answers to user status questions
- **Compaction-aware resume** — when pi auto-compacts during a loop explicitly started or resumed in the current session, pi-multiloop injects a loop-aware resume prompt after the interrupted turn ends
- **Escalation** — refines strategy automatically after consecutive failures
- **Pi-native status surfaces** — footer status, resumable-loop notices, and `/multiloop status` / `/multiloop ls` views

## Install

```bash
pi install git:https://github.com/drvova/pi-multiloop
```

## Quick Start

```bash
# Show current loop state. If there is no existing loop state, this launches the setup guide.
/multiloop

# Explicitly launch the setup guide for a new loop.
/multiloop guide
# The guide scans the repo, proposes verify/guard/checks, asks for confirmation,
# then starts the loop after you reply "go".

# Seed the guide with a natural-language goal. This does not bypass scan/clarify/confirm.
/multiloop improve inference latency, verify likely ./bench.py --quick

# Seed a compound verifier loop: metric + mechanical correctness + prompt review.
/multiloop improve latency while completing docs/TODO.md; use npm test as guard and review output semantics against fixtures

# Check detailed status and list runs.
/multiloop status
/multiloop ls
/multiloop ls --archived

# Resume, pause, stop, or archive. Lane-only works only when unambiguous; exact id is safest.
/multiloop resume perf/run-001
/multiloop pause perf
/multiloop stop perf/run-001
/multiloop archive perf/run-001
```

## More docs

- [Loop setup guide](skills/multiloop/references/LOOP_GUIDE.md) — setup contract and launch handoff (canonical version shipped with the multiloop skill).
- [State and lifecycle](docs/STATE.md) — registry/snapshot/runtime states, refusals, and compaction behavior.
- [Project plan](docs/PLAN.md) — north stars and scope.
- [Current TODO](docs/TODO.md) — publish gate and follow-on work.

## Modes

### Optimize
Edit, measure, keep if improved or revert if not, repeat. Good for kernel tuning, performance work, training sweeps. If guard/prompt checks are configured or supplied to `multiloop_measure`, keep is recommended only when the metric improves **and** every check passes.

### Research
Hypothesis, implement, measure, log results. All results are preserved for comparison rather than kept/reverted. Good for ablation studies and parameter sweeps.

### Dev
Pick a task, implement, test, commit. General development with iteration tracking.

### Punchlist
Parse a markdown checklist, pick the next open (`[ ]`) or partial (`[~]`) item, implement, verify, and check it off (`[x]`) or leave it partial with a reason. Punchlist loops default to log/progress acceptance using the `open_or_partial_items` metric; use keep/revert only for explicit metric optimization goals.

## Compound Verifiers

`multiloop_measure` accepts optional verification checks alongside metric measurements:

```json
{
  "lane": "perf",
  "measurements": [356],
  "checks": [
    {"name": "unit tests", "kind": "mechanical", "passed": true, "command": "npm test"},
    {"name": "output correctness", "kind": "prompt", "passed": true, "evidence": "Output preserves required semantics"}
  ]
}
```

For keep/revert modes, the recorded acceptance passes only when the metric improves and every check passes. If a loop was started with `guard:` or `prompt verifier:` and the agent omits the corresponding check verdict, pi-multiloop records that missing verifier as a failed check. `multiloop_decide` rejects mismatched decisions, so a faster-but-incorrect output is mechanically forced to `revert` unless the agent reruns verification and records a passing result.

### How many measurements to pass

`measurements` accepts one value, but "improved" is decided differently depending on how many you give it:

| Measurements | MAD | Improvement test |
|---|---|---|
| 1 | `0` | `delta > 0` — a bare better/worse comparison |
| 2+ | computed | `delta > 2 × MAD` — the gain must clear the noise floor |

One measurement is right for a **deterministic** metric — bundle size, LOC, `open_or_partial_items` — where repeat runs would return the same number and only waste time. It is wrong for a **noisy** one such as GPU timing, benchmark latency, or training loss, because any jitter then reads as an improvement.

Nothing in the recorded state can tell those two cases apart, so keep/revert loops print a note when a decision rests on a single measurement rather than refusing it. The note is advisory; heed it when the metric is noisy. A keep also moves `currentMetric`, so a keep driven by jitter leaves the next iteration having to beat an optimistic outlier — the error compounds instead of washing out.

## Stop Conditions

A running loop auto-continues after every iteration. By default it keeps going until you pause or stop it, or until escalation exhausts its pivots. The setup guide also asks how the loop should end, and that answer is recorded in loop state rather than left in the conversation — so it survives compaction and session restarts.

| Answer at setup | `multiloop_start` argument | Loop completes when |
|---|---|---|
| “cap at 10 iterations” | `maxIterations: 10` | `iteration` reaches 10 |
| “until all checklist items are done” | `targetMetric: 0` | `open_or_partial_items` hits 0 |
| “stop at 200ms” | `targetMetric: 200` | metric reaches 200 (`<=` for `lower`, `>=` for `higher`) |
| “until I stop it” | omit both | never — pause/stop/escalation only |

When both are set, whichever fires first wins. A loop that reaches its stop condition is marked `completed` and drops out of auto-continuation; escalation exhaustion is reported separately as `stopped`, keeping “goal reached” distinct from “gave up”. Remaining budget is rendered into every resume prompt, so the agent always sees how much is left.

Two consequences worth knowing:

- **A goal already met at baseline completes immediately.** If the first measurement already satisfies `targetMetric` — a punchlist with nothing open, a latency budget the repo already meets — the loop completes without iterating instead of sending the agent to look for work that does not exist. An iteration cap cannot fire here, because baseline is not an iteration.
- **Resume refuses a loop whose condition is still met.** Resuming would grant one bonus iteration and then re-complete, so `multiloop_resume` and `/multiloop resume` decline and tell you why. Start a new run, or raise the bound in the lane's `state.json`. Escalation-stopped loops carry no stop condition and stay resumable.

## How State Works

pi-multiloop keeps everything in a single `.multiloop/` directory at your repo root:

```
your-repo/
└── .multiloop/
    ├── registry.json                 # index of all loops
    ├── active/                       # running/paused/completed loops
    │   ├── perf/                     # one dir per lane
    │   │   └── run-20260503-053708/  # one dir per run
    │   │       ├── results.jsonl     # append-only iteration log
    │   │       ├── state.json        # resume snapshot
    │   │       └── lessons.md        # cross-run learning (optional)
    │   └── quant/                    # second lane, same worktree
    │       └── run-20260503-054200/
    │           ├── results.jsonl
    │           └── state.json
    └── archive/                      # moved here by /multiloop archive
        └── 2026-05-03T05-39-...-perf-run-20260503-053708/
            ├── results.jsonl
            └── state.json
```

### File Reference

| File | Written when | Contents |
|---|---|---|
| `registry.json` | Loop start/stop/archive | Index of all loops (lane, run-tag, mode, status, verify command). One file per repo. |
| `state.json` | Every iteration + start/stop | Atomic resume snapshot: iteration count, action counters, baseline, current/best metric, consecutive failures, pivot count, acceptance mode, stop conditions (`maxIterations`, `targetMetric`), config, and any active measured-but-not-decided iteration. |
| `results.jsonl` | Every iteration | Append-only log — one JSON line per iteration with: action (keep/revert/log/skip/crash/blocked), metric, baseline, delta, confidence, hypothesis, changes, measurements array, verification checks, and acceptance verdict. Never overwritten. |
| `lessons.md` | On pivot escalation | Freeform notes appended when the loop pivots strategy. Carried forward to bias future hypotheses. |

With existing loop state, bare `/multiloop` is status-first: it shows attached running loops, detached resumable loops, inactive/history buckets, and archived-run counts. If there is no useful existing state, bare `/multiloop` launches the setup guide. `/multiloop guide` always launches the guide explicitly. The guide scans the repo, asks at least one clarification round, proposes metric/verify/guard/checks, and starts via `multiloop_start` only after explicit approval.

### Lifecycle

1. **`/multiloop`** — Shows current loop state. If no useful state exists, launches the setup guide. A loop is created only after explicit approval and `multiloop_start`, which writes `.multiloop/registry.json` and `active/<lane>/<run-tag>/state.json`.
2. **Each iteration** — `multiloop_iterate` records an active iteration marker in `state.json`; `multiloop_measure` records pending measurements plus optional mechanical/prompt checks; `multiloop_decide`/`multiloop_log` appends to `results.jsonl`, updates action counters, clears the active marker, evaluates the stop condition, and atomically replaces `state.json`.
3. **Completion** — When a configured stop condition is met, the loop is marked `completed` in both `state.json` and the registry, and drops out of auto-continuation. No command is needed; it happens on the iteration that reaches the bound.
4. **`/multiloop stop`** — Updates status in both `state.json` and registry. Files stay on disk.
5. **`/multiloop resume`** — Explicitly reconstructs in-memory state from `results.jsonl` + `state.json` and sends a loop-aware resume prompt. Refused when the loop's stop condition is still met, since resuming would immediately re-complete it. No new files until next iteration.
6. **Auto-continuation during a current-session loop** — After a loop-owned turn ends, if the loop is still `running` and no user message is pending, pi-multiloop sends a follow-up prompt for the next required action. If a measurement is pending, the prompt forces decide/log before new work.
7. **Auto-compaction during a current-session loop** — Sends a resume prompt grounded in active `.multiloop/` state after compaction, including the common Pi threshold path where compaction happens immediately after `agent_end`. Manual idle `/compact` does not restart the agent.
8. **`/multiloop archive`** — Moves the run directory from `active/` to `archive/` with a timestamp prefix.

### Loop mode

Whether a session is looping is durable state, not a per-turn flag. Loop mode is armed by `multiloop_start` and `/multiloop resume`, re-armed at session start when a `running` loop exists on disk, and cleared only by an explicit stop, pause, or `/multiloop off`.

```bash
/multiloop off   # stop auto-continuing; the loop stays running on disk
/multiloop on    # re-attach the running loop and continue
```

This is what makes a new session pick up where the last one left off without any command. A running loop on disk implies intent — the previous session did not stop it. An explicit decision always wins over that default and is replayed from the session branch, so `/multiloop off` survives `/tree`, compaction, and restarts instead of snapping back on.

Slash commands are neutral: `/multiloop status` and friends drive the extension rather than abandon the loop, so they no longer stall it. Asking in words (“stop the loop”, “don't continue”) still suspends.

Loop mode alone never starts work. A continuation is queued only when mode is on **and** a loop tool ran that turn **and** a loop is still running — so a chat-only turn cannot re-prompt itself forever. Session start queues the first prompt but deliberately leaves the turn flag unarmed, so that turn has to earn the next continuation by calling a tool.

### Gitignore

Add this to `.gitignore` if you don't want loop state in version control:

```
.multiloop/
```

You can also commit the state if you want a record of optimization runs alongside the code. The JSONL results are human-readable and diff-friendly.

### Path Conventions

Everything lives under `.multiloop/` relative to your repo root (pi's cwd).

## Composability

pi-multiloop handles iteration logic and composes with other Pi extensions:
- **pi-boomerang** — context compression for long-running loops
- **pi-supervisor** — goal enforcement and methodology steering
- **pi-review-loop** — quality gate at the end of iterations

## Development

```bash
git clone https://github.com/drvova/pi-multiloop
cd pi-multiloop
npm install
npx tsc --noEmit     # types
npx vitest run       # tests
pi install .         # load the extension locally
```

### Tests

The suite draws a **fresh seed every run**. Generated values, lane identifiers, run tags, and temp directories all differ between invocations, so no two runs exercise the same corpus. The seed is printed at startup and pins the whole run:

```bash
npx vitest run
#   pi-multiloop test seed: 46d5c2a7 (random)
#   reproduce this exact run: MULTILOOP_TEST_SEED=46d5c2a7 npx vitest run

MULTILOOP_TEST_SEED=46d5c2a7 npx vitest run   # byte-identical replay
```

Copy the seed out of a failing log before anything else — it is the only route back to that corpus.

| Layer | What it covers |
|---|---|
| unit | Per-module behaviour |
| lifecycle | A full run across a simulated restart |
| scenarios | Multi-lane, upgrade path, registry desync, hand-edited state |
| exhaustive | Cross-product of the decision space against an independent oracle |
| property | Invariants over seeded random histories on a real filesystem |
| metamorphic | Relations between related inputs |

Randomisation applies to **values**, never to **coverage**: the exhaustive layer enumerates relations (iteration under/at/over the cap, metric short of/exactly at/past the target) and draws fresh numbers for each, so the grid is complete on every seed.

`tests/support/oracle.ts` is an independent model of the stop-condition contract, written from this README and `docs/STATE.md` rather than from `loop.ts`. If it is ever derived from the implementation, the exhaustive layer stops proving anything.

A green suite only measures the code you chose to exercise. Before calling a change verified, break it on purpose and confirm the suite goes red — revert a guard, flip a comparison, drop a persistence call. If a mutation survives, the test is decorative.

## Related Projects

### Autoresearch / Autoloop

- [karpathy/autoresearch](https://github.com/karpathy/autoresearch) — The original: edit → benchmark → keep/revert → repeat. Established the pattern.
- [lhl/codex-autoresearch](https://github.com/lhl/codex-autoresearch) — Multi-loop-per-worktree support via `LANE` + `RUN_TAG` isolation for Codex. pi-multiloop is the pi equivalent.
- [uditgoenka/autoresearch](https://github.com/uditgoenka/autoresearch) — Claude Code / OpenCode / Codex autoresearch skill. Generalizes beyond ML to any domain with a measurable metric.
- [armgabrielyan/autoloop](https://github.com/armgabrielyan/autoloop) — Agent-agnostic autoloop with repo-aware setup inference, guardrails, and keep/discard verdicts. Works with Claude Code, Codex, Cursor, Gemini CLI.

### Awesome Lists

- [WecoAI/awesome-autoresearch](https://github.com/WecoAI/awesome-autoresearch) — Use cases with actual optimization traces (Vesuvius Challenge, Bitcoin prediction, agent improvement)
- [yibie/awesome-autoresearch](https://github.com/yibie/awesome-autoresearch) — Tools + real-world use cases (stock portfolios, cold email, fare search)
- [alvinreal/awesome-autoresearch](https://github.com/alvinreal/awesome-autoresearch) — Self-improving agents, end-to-end research automation, curated papers

### Pi Extensions

- [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) — Autonomous optimization loops for pi with TUI dashboard, MAD confidence scoring, and branch workflow
- [mikeyobrien/pi-autoloop](https://github.com/mikeyobrien/pi-autoloop) — Autonomous LLM loops for pi
- [nicobailon/pi-boomerang](https://github.com/nicobailon/pi-boomerang) — Token-efficient autonomous loops via execute → summarize → compact history
- [tintinweb/pi-supervisor](https://github.com/tintinweb/pi-supervisor) — Goal supervision with separate supervisor LLM steering the main agent
- [nicobailon/pi-review-loop](https://github.com/nicobailon/pi-review-loop) — Self-review until no issues remain, with smart exit detection
- [samfoy/pi-ralph](https://github.com/samfoy/pi-ralph) — Event-driven state machine with hat-based role transitions and workflow presets
- [nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger) — PRD → dependency DAG → wave execution for multi-agent coordination
- [burggraf/pi-teams](https://github.com/burggraf/pi-teams) — Persistent multi-agent teams with shared task board and terminal pane management
- [lsj5031/PiSwarm](https://github.com/lsj5031/PiSwarm) — Commander → Captain → wave workers with isolated git worktrees
- [ArtemisAI/pi-loop](https://github.com/ArtemisAI/pi-loop) — Cron/repeating prompts with dynamic pacing and dual-gate verify+guard
- [tintinweb/pi-schedule-prompt](https://github.com/tintinweb/pi-schedule-prompt) — Cron-like recurring prompt scheduling

## License

MIT
