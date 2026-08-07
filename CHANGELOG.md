# Changelog

## Unreleased

### Added
- Added `@multiloop/agent`, autonomous loop subagents: `multiloop_agent`
  spawns a loop into an isolated background child Pi session that inherits the
  caller's model, drives the full iterate/measure/decide cadence, and reports
  back — with a live `multiloop-agents` fleet widget, follow-up completion
  notifications, mid-run steering (`multiloop_agent_steer`), and a management
  toolset (`multiloop_agent_result` with cancellable wait,
  `multiloop_agent_stop`, `multiloop_agents`, `/multiloop-agents`, and
  `resume` on spawn). This delivers the PLAN's mid-loop steerability north
  star at the fleet level. The root `pi` manifest and `files` list include
  the new packages, so install/update behavior is unchanged.
- Added `@multiloop/child-agent`, the shared isolated child-session core
  (spawn, resource isolation, abort discipline, report extraction) under the
  subagent. Requires pi-coding-agent 0.83 APIs, so the repo's devDependencies
  moved from ^0.74.0 to ^0.83.0.

### Changed
- Restructured the repository into an npm-workspaces monorepo. The extension,
  its tests, the `/multiloop` skill, and the detached driver moved into
  `packages/multiloop`, `packages/multiloop-skill`, and `packages/multiloop-run`.
  The root remains the published package: its `pi` manifest, `bin`, and `files`
  now point into `packages/`, so `npm install`, `pi install`, and `pi update`
  behave exactly as before. Layout and decisions are recorded in
  `docs/MONOREPO.md`.
- Cleaned the TypeScript configuration: a shared `tsconfig.base.json` now owns
  compiler options with `noEmit` (the repo is typecheck-only; pi loads the
  extension from source), dropping emit-only options and a stale
  machine-specific `paths` block.
- `vitest.config.ts` points its global setup at
  `packages/multiloop/tests/support/global-setup.ts`; all 18 suites and 32k
  tests run unchanged from their new home.

## 0.3.2 - 2026-08-04

### Added
- Add session-durable **loop mode**. Whether a session is looping now lives in a flag armed by `multiloop_start`/`/multiloop resume`, re-armed at session start when a `running` loop exists on disk, and cleared only by an explicit stop, pause, or the new `/multiloop off`. The decision is recorded as a session entry and replayed from the branch, so an explicit off survives `/tree`, compaction, and restarts. Adds `/multiloop on` and `/multiloop off`.
- Add a **live dashboard widget** (`multiloop-live`, placed below the editor) so loop progress is visible while you work. It is a `ctx.ui.setWidget` component factory whose `render()` reads the current attached loop states on every paint, and it is re-armed by `updateStatus` — the choke point every state mutation already flows through — so the widget tracks starts, iterations, pause/stop, and archive in real time. Rows show lane, mode, iteration, status (color-coded), metric, best, delta, failure count, and pivots; headers are muted, the lane is accented, failures toggle a warning tint, and lines truncate to the viewport width. Capped at 8 rows with a `… N more` overflow hint. Idle state renders when nothing is attached.
- Add the **detached background driver** (`bin/multiloop-run.mjs`): drives a loop with zero human and zero interactive session, spawning one headless `pi -p --mode json` per iteration, polling `state.json` for the iteration counter to advance, then reaping the child (real pi workers never exit on their own). Flags: `--iterations`, `--timeout-sec`, `--pi-cmd`, `--dry-run`, `--verbose`. The loop is paused for the duration so `session_start` never races the prompt, and each child is told to `multiloop_resume` as step 0 so exactly one session owns each iteration.
- Add **frozen anchors (anti-Goodhart)**: `protectedPaths` — a pin-list of files the loop must never modify; their SHA-256 baseline is captured at start and re-hashed at every measure, blocking acceptance when content changed. `pinnedConfig` freezes the verifier and stop-condition fields at start; editing them mid-loop stops the line and names the tampered field.
- Add the **extension-run audit verifier** (`auditVerifier`): a pinned command the extension itself executes at every measure (never the graded agent); its numeric output must match the reported metric within 1e-6 or acceptance is blocked — the graded party cannot present its own grade.
- Add **extension-run revert verification** (`revertVerifier`): fingerprints the workspace (content hash) at iterate; the fingerprint must be reproduced byte-for-byte at revert or the rollback is refused. The boundary is hashed at loop start and after every decision, and a built-in git working-tree fingerprint covers loops without a custom verifier — verifier-less loops refuse unverified rollbacks at decide.
- Add **out-of-band edit detection**: the workspace is fingerprinted at loop start and every decision boundary; edits outside an iteration are refused at the next `multiloop_iterate` with the live workspace state echoed, so a revert can never be verified against a dirty baseline.
- Add the **minimum-measurement gate** (`minMeasurements`, default 1): undersampled keep/revert loops degrade to log instead of promoting on noise.
- Add **stall detection**: three consecutive identical iterations (same changes + metric) trigger an escalation prompt instead of spinning forever.
- Add **durable continuation intent**: a queued auto-continue survives a crash between queue and delivery; explicit `/multiloop off` drops the intent.
- Add **champion comparison**: `multiloop_compare` / `/multiloop compare` renders two runs side by side with a champion verdict, reading archived runs too — offline champion-challenger evaluation on frozen history.
- Add **pivot lessons surfaced**: the latest pivot lesson renders into every continuation prompt instead of disappearing into an unread `lessons.md`.
- Add **CI across OS**: first workflow runs the full suite on ubuntu, windows and macOS (vitest 4 fixes worker RPC timeouts); the environment-matrix suite proves the Windows dir-fsync guard host-portably.
- Add `scripts/e2e-optimize.sh` + `scripts/e2e-mkloop.mjs`: a manual real-headless end-to-end that drives two optimize iterations through the detached driver and asserts keep/revert acceptance gates, audit checks and the built-in revert verifier work inside actual headless sessions.

### Fixed
- The detached driver no longer hangs on an unkillable child. `stopIteration` killed sessions with `process.kill(-pid)` — a POSIX process-group kill that throws on Windows and is silently swallowed, leaving the driver blocked on `await exited` forever. It now reaps on Windows with the native tree kill (`taskkill /pid <pid> /T /F` via the new `winKillArgs` helper, plus a `child.kill()` fallback), listens for spawn `error` events (a failed spawn previously hung the driver with no diagnostic), and `main()`'s stuck-session branch no longer awaits the child exit a second time. Reaping is best-effort by design — the durable `state.json` result is trusted, never the child's liveness.
- Windows CI is green: CRLF shebang on `bin/multiloop-run.mjs` broke vite's transform (0 tests collected) — fixed with `.gitattributes: *.mjs text eol=lf`; the "refuses loudly" verifier test used single quotes that `cmd.exe` does not strip, so node evaluated the string literal and exited 0 — now double-quoted; and the archived-runs test helper built `stateDir` from raw ISO timestamps, whose `:` is illegal in Windows path segments — the helper now sanitizes like production `archiveLoop`.
- Stop conditions are null-safe: a literal `null` `maxIterations`/`targetMetric` in a hand-edited `state.json` (which config-pin normalization already treats as absent) no longer coerces to `0` and completes the loop at baseline or first measure.
- The driver probes the pi binary once before driving; a missing or non-responsive `--pi-cmd` stops the run loudly before a single iteration is spawned.
- A lane-scoped stop/pause no longer disarms the whole session. `pauseLoop`/`stopLoop` cleared session loop mode unconditionally, so `/multiloop pause perf` silently stopped every other lane on the worktree — and because the decision was recorded to the session branch, a fresh session then refused to arm even with loops still running. Mode is now cleared only when no running loop remains (`shouldDisarmAfterLaneOperation`), checked after the lane leaves the active set.
- Slash commands are no longer classified as suspend requests. `/multiloop stop perf` was applying a session-global disarm from the input handler *before* the lane-scoped handler ran, defeating the fix above by a second path. Slash commands are now uniformly neutral; their handlers own loop semantics.
- Natural-language suspend detection no longer fires on questions, negations, or code instructions. "why did the loop stop?", "the loop should not stop until tests pass", and "remove the loop guard" all suspended the loop. Harmless when the verdict only cleared a per-turn flag, but session-durable mode made them permanent across reloads. Questions and negated stops are excluded, proximity matching is bounded to one sentence, and `archive`/`delete`/`remove` are dropped from the verb list — they are overwhelmingly about code, and are already slash subcommands when they mean the loop.
- A slash command no longer stalls a running loop. `loopTurnActive` was the only record that a loop existed; it is cleared on every `agent_end` and re-earned by the next tool call, and `shouldContinueAfterUserInput` treated any `/`-prefixed message as a reason to disarm. Typing `/multiloop status` mid-loop therefore stopped auto-continuation silently. Input is now classified `suspend` / `arm` / `neutral`, and slash commands are neutral — they drive the extension rather than abandon the loop. Asking in words still suspends, and `/multiloop stop` still suspends because the stop patterns are checked before the slash rule.
- A new session no longer refuses to pick up a running loop. `session_start` attaches loops the registry calls active whose snapshot reconstructs to `running`, then queues the first continuation. Previously the loop existed on disk but nothing in memory, so it sat idle until an explicit `/multiloop resume`.
- The setup guide has always asked for a stop condition ("cap at 10 iterations", "stop at a metric threshold"), but `multiloop_start` had no parameter to record the answer, so the bound survived only in the context window that compaction discards. Escalation was the sole mechanical stop, and it fires only on consecutive failures — `consecutiveFailures` resets to 0 on every accepted iteration, so a succeeding loop auto-continued with no ceiling at all. The stop condition now lives in `state.json` and is evaluated by both terminal paths (`multiloop_decide` via `applyDecision`, and `multiloop_log`).
- `multiloop_decide` and `multiloop_log` now report loop continuation through one shared path, so terminal-state reporting cannot drift between them.
- `multiloop_resume` and `/multiloop resume` now refuse a loop whose stop condition is still met. Previously `resumeLoop` flipped any status straight to `running`, so resuming a completed loop granted one silent bonus iteration before re-completing, and handed the agent a resume prompt that contradicted its own stop condition. Escalation-stopped loops carry no stop condition and remain resumable.
- `buildSetupGuidePrompt()` — the runtime source of truth for setup — asked the agent to confirm a "stop condition/iteration cap" without naming the argument that carries it. It now names `maxIterations`/`targetMetric` explicitly, so the answer lands in loop state even when the skill-side guide is not loaded.
- `reconstructState()` replayed `currentMetric` only for `keep` and `log` results, while `applyLogIteration()` moves it for any log-family action carrying a metric. A loop completed by a metric target recorded on a `skip`/`crash`/`blocked` iteration therefore rebuilt as incomplete after a restart, and became resumable again — defeating the stop-condition guard. Replay now matches the live write path. Found by property-based testing, not by inspection.
- `multiloop_measure` now evaluates the stop condition when it records the baseline. A loop whose target is already satisfied — a punchlist with nothing open, a latency budget the repo already meets — previously reported "Baseline recorded. Start optimizing." and auto-continued, sending the agent to find work that does not exist. It now completes without iterating.

### Changed
- `multiloop_measure` now prints a note when a keep/revert decision rests on a single measurement. One measurement yields MAD 0, so `isImprovement` falls back to `delta > 0` and any jitter reads as a gain — and because a keep moves `currentMetric`, the next iteration must then beat an optimistic outlier, so the error compounds. This warns rather than refuses: `delta > 0` is correct for a deterministic metric such as `open_or_partial_items`, and requiring repeats would force pointless reruns on the metrics multiloop ships by default. Log-mode loops are unaffected, since the metric does not gate their decisions.
- Extract `resolveAcceptanceMode()` in `verifiers.ts`. The `mode === "optimize" ? "keep-revert" : "log"` default was duplicated in `assessAcceptance()` and `buildIterationContext()`; callers that need to know whether the metric gates a decision now ask one place.
- Move baseline establishment and log-only iteration recording out of the `index.ts` tool bodies into `establishBaseline()` and `applyLogIteration()` in `loop.ts`, alongside `applyDecision()`. All three state-mutation paths now share one implementation of the terminal-state contract, so none can advance the iteration counter without evaluating the stop condition. `index.ts` drops 41 lines and the logic is reachable from tests rather than only through the extension runtime.

### Removed
- Delete `parseMetric()` and the `MetricResult` interface from `metrics.ts`. Both were inherited from the autoresearch lineage and had no production callers. Worse than unused: a metric parser implies pi-multiloop reads numbers out of command output, which it never does — the agent supplies `number[]` and the extension never executes anything.
- Delete `getActiveLoops()` from `lanes.ts`. Exported and tested, zero callers.
- The test suite now draws a fresh seed per run. Generated values, lane identifiers, run tags, and temp directories differ on every invocation, so no two runs exercise the same corpus. The seed is printed at startup and `MULTILOOP_TEST_SEED=<hex>` replays a run byte for byte. Coverage itself stays deterministic: `tests/exhaustive.test.ts` enumerates *relations* and randomises only the values realising them, so the grid is complete on every seed.

### Fixed
- Move the canonical loop setup guide from `docs/LOOP_GUIDE.md` into the multiloop skill at `skills/multiloop/references/LOOP_GUIDE.md`. Previously the skill prompt and `buildSetupGuidePrompt()` cited `docs/LOOP_GUIDE.md` as a bare relative path; on npm or git installs the agent's cwd is the user's repo (not the package install dir), so the path missed the shipped file or picked up an unrelated doc. The guide now travels with the skill and resolves correctly under every install source.
- Drop the filesystem-path reference from `buildSetupGuidePrompt()`. The inlined summary is the runtime source of truth; the skill-side canonical file is mentioned as an informational pointer only, so launch behavior no longer depends on a successful `read` of an external doc.

### Changed
- README link to the loop setup guide now points at the skill-relative path.

## 0.3.1 - 2026-05-08

### Changed
- Update peerDependencies to `@earendil-works/*` scope (Pi 0.74.0+)
- Update imports to use `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent`

## 0.3.0 - 2026-05-08

### Added
- Add loop-owned auto-continuation: after start/resume/tool turns, running loops queue the next required action instead of relying on the model to keep going after one decide/log.
- Persist `activeIteration` markers in `state.json` so measured-but-not-decided iterations survive compaction/resume.
- Support compound verifiers by recording mechanical/prompt checks with `multiloop_measure`; keep/revert recommendations now combine metric improvement with all-checks-pass acceptance.
- Add a guided loop setup flow (`/multiloop` or `/multiloop guide`) plus `multiloop_start` so agents scan, clarify, confirm, and then start a well-formed loop.
- Add status-first bare `/multiloop`, grouped `/multiloop ls`, freeform goal seeding into the setup guide, lane-only target resolution, typed human-operation tools, and LLM disambiguation handoff.
- Add punchlist `[~]` partial state, log/progress acceptance mode, `open_or_partial_items` verifier metric helper, and action counters in loop snapshots.

### Changed
- Default punchlist, research, and dev loops to log/progress acceptance; optimize loops continue to use keep/revert acceptance by default.
- Make `state.json` writes atomic via temp-file write, fsync, and rename.
- Document runtime refusal/recovery behavior, status vocabulary, guard execution policy, and the canonical setup contract.
- Clarify README state/lifecycle docs for status-first bare `/multiloop` behavior and reconcile remaining feedback follow-ups in `docs/TODO.md`.

### Fixed
- Require `multiloop_decide` measurements to match the last recorded `multiloop_measure`, preventing unrecorded or stale verification decisions.
- Soften auto-continue prompts so status questions are answered first and then loop work resumes only if the loop is still running.
- Reconstruct state from accepted/logged results so reverted measurements do not become the current metric after resume.
- Persist escalation metadata so pivot failure-streak resets survive reconstruction.
- Validate lane and run-tag identifiers before using them in `.multiloop/active/...` paths.
- Reject empty measurement arrays and require configured guard/prompt verifier verdicts to match the configured command/prompt explicitly.

## 0.2.0 - 2026-05-07

### Added
- Add compaction-aware resume: if Pi compacts during or immediately after an active multiloop turn, pi-multiloop injects a loop-aware resume prompt grounded in active `.multiloop/` state instead of relying on a generic "continue".
- Show a passive startup notice in chat history listing active loops available to resume without attaching them to the new session.

### Changed
- Stop auto-attaching persisted active loops on Pi `session_start`; `/multiloop resume <lane/run-tag>` is now required to reactivate an existing loop in a new session.
- Stop injecting active loop context into every user prompt. Loop state is now supplied by explicit start/resume prompts and compaction resume prompts instead of global `before_agent_start` system-prompt mutation.

### Fixed
- Re-arm compaction-aware resume after every auto-compaction. Pi threshold compaction is emitted after the extension `agent_end` hook, so the resume logic now sends after `session_compact` when it follows a recent active agent turn instead of waiting for a second `agent_end`.
- Make the startup resumable-loops notice scroll with chat history instead of staying pinned as a persistent widget.
- Render the startup resumable-loops notice with Pi theme colors instead of the default custom-message box.

## 0.1.1

### Commands
- Consolidate all commands under `/multiloop` with subcommands: status, ls, stop, pause, resume, archive, rm, help
- Remove separate `/multiloop-status` and `/multiloop-archive` commands
- Add `rm` subcommand to delete loops and their state files
- Add `help` subcommand (also shown for bare `/multiloop`)

### Bug fixes
- Fix `formatDelta` division by zero when baseline is 0
- Fix `formatDelta` labeling unchanged metrics as "regressed"
- Fix null state crash in `loopSummary` on session reload
- Fix `stateDir` in registry not updating after archive
- Fix archived `state.json` retaining pre-archive status
- Fix archive catch block leaving stale registry entries
- Fix `multiloop_decide` silently using baseline=0 before any measurement
- Fix pause handler silently failing for registry-only loops
- Fix `reconstructState` not counting reverts through log/skip entries

### Type safety
- Add `"archived"` to `LoopState.status` union type

### Docs
- Rewrite README for clarity
- Add publish checklist (`docs/PUBLISH.md`)
- Add CHANGELOG
- Add TODO with v0.2 candidates (`docs/TODO.md`)
- Fix `pi install file:.` → `pi install .` across all docs

### Tests
- Add 57 tests for loop.ts and modes.ts (43 → 100 total)

## 0.1.0

Initial release.

- Multi-lane loop isolation on a single worktree
- Four modes: optimize, research, dev, punchlist
- MAD confidence scoring for noisy benchmarks
- Append-only JSONL history per lane with resume support
- Automatic escalation on consecutive failures (refine at 3, pivot at 5, stop)
- TUI dashboard with per-lane status and metric history
- `/multiloop`, `/multiloop-status`, `/multiloop-archive` commands
- Setup wizard skill
- Consolidated all state under `.multiloop/` directory
