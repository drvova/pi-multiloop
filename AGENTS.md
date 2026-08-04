# pi-multiloop — Agent Guide

Pi extension for multi-lane autonomous iteration loops. Supports optimization, punchlist, research, and dev modes with lane-isolated state on a single worktree.

## Non-Negotiables

1. **Commit after every logical work unit.** Do not wait to be asked.
2. **Never use `git add .`, `git add -A`, or `git commit -a`.** Stage files explicitly by name.
3. **Extension code goes in `extensions/pi-multiloop/`.** Skills go in `skills/`. Tests go in `tests/`.

## Summary

- Primary purpose: pi extension package (npm: `pi-multiloop`)
- Source-of-truth docs: `docs/PLAN.md` (project plan + north stars), `README.md` (user-facing docs)
- Extension entry point: `extensions/pi-multiloop/index.ts`
- Skill: `skills/multiloop/skill.md`

## Key Files

| Path | Purpose |
|---|---|
| `package.json` | Pi package manifest + npm metadata |
| `extensions/pi-multiloop/index.ts` | Extension entry point — events, tools, commands |
| `extensions/pi-multiloop/lanes.ts` | Lane/run-tag path resolution and registry |
| `extensions/pi-multiloop/state.ts` | JSONL log + JSON snapshot persistence |
| `extensions/pi-multiloop/metrics.ts` | Metric parsing and MAD confidence scoring |
| `extensions/pi-multiloop/loop.ts` | Core iterate/keep/revert/escalation engine |
| `extensions/pi-multiloop/modes.ts` | Mode definitions and punchlist parser |
| `extensions/pi-multiloop/ui.ts` | TUI dashboard widget |
| `skills/multiloop/skill.md` | Setup wizard skill prompt |
| `docs/PLAN.md` | North stars, gap analysis, implementation checklist |

## Architecture

### Lane Isolation

All state lives in a single `.multiloop/` directory at repo root:
```
.multiloop/
├── registry.json
├── active/<LANE>/<RUN_TAG>/
│   ├── results.jsonl    # Append-only iteration log
│   ├── state.json       # Resume snapshot
│   └── lessons.md       # Cross-run learning (optional)
└── archive/             # Completed loops moved here
```

### Pi Extension API Usage

- Events: `session_start` (passive resume list only), `input`, `agent_start`, `session_before_compact`, `session_compact`, `agent_end`
- Tools: `multiloop_iterate`, `multiloop_measure`, `multiloop_decide`, `multiloop_log`
- Commands: `/multiloop` (with subcommands: status, ls, stop, pause, resume, archive, rm, help)
- UI: Widget for lane status dashboard

### Testing

```bash
npm install
npx vitest run
```

## Verification

| Scope | Check |
|---|---|
| Build | `npx tsc --noEmit` passes |
| Tests | `npx vitest run` passes |
| Install | `pi install .` loads without errors |
| Extension | `/multiloop status` shows "no active loops" |

### Test layers

| File | Kind | Purpose |
|---|---|---|
| `tests/*.test.ts` | unit | Per-module behaviour |
| `tests/lifecycle.test.ts` | integration | Full run across a simulated restart |
| `tests/scenarios.test.ts` | integration | Multi-lane, upgrade path, registry desync, hand-edited state |
| `tests/mode.test.ts` | unit + property | Loop-mode decisions: input classification, decision replay, arming, continuation gate |
| `tests/sessions.test.ts` | simulation | Whole session lifecycles across restarts, including a 60-turn randomised horizon for durable intent + stall bookkeeping |
| `tests/longhorizon-env.test.ts` | simulation | The same 60-turn horizon replayed under 5 simulated platforms; a mocked Windows filesystem EPERMs on dir fsync to prove the guard skips it on win32 and runs it on POSIX |
| `tests/exhaustive.test.ts` | enumeration | Cross-product of the decision space vs `tests/support/oracle.ts` |
| `tests/properties.test.ts` | property | Invariants over seeded random histories on the real filesystem |
| `tests/metamorphic.test.ts` | metamorphic | Relations between related inputs |

`tests/support/session-harness.ts` is the shared Session simulator used by `sessions.test.ts` and `longhorizon-env.test.ts`. It mirrors the index.ts wiring (session_start arms from recorded decision plus disk; tools arm the per-turn flag; agent_end asks `shouldQueueContinuation`) and is composition-only — every decision goes through the production function.

`tests/support/oracle.ts` is an independent model of the stop-condition contract, written from README/STATE.md rather than from `loop.ts`. Keep it that way: if it is ever derived from the implementation, the exhaustive suite stops proving anything.

### Run seed

Every run draws a fresh seed. Generated values, lane identifiers, run tags, and temp directories all differ run to run, so no two runs exercise the same corpus. The seed is printed at startup and pins the whole run:

```bash
npx vitest run                              # fresh corpus, seed echoed
MULTILOOP_TEST_SEED=cafe1234 npx vitest run # byte-identical replay
```

Copy the seed out of a failing log before doing anything else — it is the only way back to that corpus.

Randomisation applies to *values*, never to *coverage*. `tests/exhaustive.test.ts` enumerates relations (iteration under/at/over the cap, metric short of/exactly at/past the target) and draws fresh numbers for each; the grid stays complete on every seed. Never randomise which relations are visited — that trades a guarantee for a lottery. Assertions must compare against generated ids (`id.lane`) rather than literals, or they break the first time the seed changes.

### Judging coverage

A green suite only measures the code you chose to exercise. Before claiming a change is verified, break it on purpose and confirm the suite fails — revert the guard, flip a comparison, drop a persistence call. Three defects in this repo shipped past a green suite because the tests replayed a private copy of the logic instead of calling production. If a mutation survives, the test is decorative.

## Git Discipline

Same as devstack — commit immediately on logical completion, stage explicitly, conventional prefixes (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
