# Changelog

All notable changes to pi-multiloop are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
practices [Semantic Versioning](https://semver.org/).

Releases are tagged `vX.Y.Z` and published on
[GitHub Releases](https://github.com/drvova/pi-multiloop/releases).

## [0.3.2] - 2026-08-04

### Fixed
- **Driver no longer hangs on an unkillable child.** `stopIteration` killed
  spawned sessions with `process.kill(-pid)` — a POSIX process-group kill.
  On Windows that call throws and is silently swallowed, so a child that
  refused to die left the driver blocked on `await exited` forever, and the
  two poll-and-reap tests timed out at the 60s vitest cap on every platform.
  The driver now reaps on Windows with the native tree kill
  (`taskkill /pid <pid> /T /F` via the new `winKillArgs` helper, plus a
  `child.kill()` fallback), listens for spawn `error` events (a failed spawn
  previously hung the driver with no diagnostic), and `main()`'s stuck-session
  branch no longer awaits the child exit a second time. Reaping is
  best-effort by design — the durable `state.json` result is trusted, never
  the child's liveness.
- **Windows CI is green.** Three Windows-only test failures fixed:
  CRLF shebang on `bin/multiloop-run.mjs` broke vite's transform (0 tests
  collected) — fixed with `.gitattributes: *.mjs text eol=lf`; the
  "refuses loudly" verifier test used single quotes that `cmd.exe` does not
  strip, so node evaluated the string literal and exited 0 — now double-quoted;
  and the archived-runs test helper built `stateDir` from raw ISO timestamps,
  whose `:` is illegal in Windows path segments — the helper now sanitizes
  like production `archiveLoop`.
- **Null-safe stop conditions.** A literal `null` `maxIterations`/`targetMetric`
  in a hand-edited `state.json` (which config-pin normalization already treats
  as absent) no longer coerces to `0` and completes the loop at baseline or at
  first measure; nullish guards treat null as absent everywhere.
- **Driver pre-flight probe.** `multiloop-run` now probes the pi binary once
  before driving; a missing or non-responsive `--pi-cmd` stops the run loudly
  before a single iteration is spawned.

### Added
- `scripts/e2e-optimize.sh` + `scripts/e2e-mkloop.mjs`: a manual real-headless
  end-to-end that drives two optimize iterations through the detached driver
  and asserts the keep/revert acceptance gates, audit checks and the built-in
  revert verifier all work inside actual headless sessions.

## [0.2.0] - 2026-08-03

### Added
- **Detached background mode (the v0.2 milestone).** `bin/multiloop-run.mjs`
  drives a loop with zero human and zero interactive session: it spawns one
  headless `pi -p --mode json` per iteration, polls `state.json` for the
  iteration counter to advance, then reaps the child (real pi workers never
  exit on their own). Flags: `--iterations`, `--timeout-sec`, `--pi-cmd`,
  `--dry-run`, `--verbose`. The loop is paused for the duration so
  `session_start` never races the prompt, and each child is told to
  `multiloop_resume` as step 0 so exactly one session owns each iteration.
- **Frozen anchors (anti-Goodhart).** `protectedPaths` — a pin-list of files
  the loop must never modify; their SHA-256 baseline is captured at start and
  re-hashed at every measure, blocking acceptance when content changed.
  `pinnedConfig` freezes the verifier and stop-condition fields at start;
  editing them mid-loop stops the line and names the tampered field.
- **Extension-run audit verifier.** `auditVerifier` is a pinned command the
  extension itself executes at every measure (never the graded agent); its
  numeric output must match the reported metric within 1e-6 or acceptance is
  blocked — the graded party cannot present its own grade.
- **Extension-run revert verification.** `revertVerifier` fingerprints the
  workspace (content hash) at iterate and the fingerprint must be reproduced
  byte-for-byte at revert, or the rollback is refused. The boundary is hashed
  at loop start and after every decision, and a built-in git working-tree
  fingerprint covers loops without a custom verifier — verifier-less loops
  refuse unverified rollbacks at decide.
- **Out-of-band edit detection.** The extension fingerprints the workspace at
  loop start and every decision boundary; edits outside an iteration are
  refused at the next `multiloop_iterate` with the live workspace state echoed,
  so a revert can never be verified against a dirty baseline.
- **Minimum-measurement gate.** `minMeasurements` (default 1) raises how many
  runs must back a keep/revert; undersampled loops degrade to log instead of
  promoting on noise.
- **Stall detection.** Three consecutive identical iterations (same changes +
  metric) trigger an escalation prompt instead of spinning forever.
- **Durable continuation intent.** A queued auto-continue survives a crash
  between queue and delivery; explicit `/multiloop off` drops the intent.
- **Champion comparison.** `multiloop_compare` / `/multiloop compare` renders
  two runs side by side with a champion verdict, reading archived runs too —
  offline champion-challenger evaluation on frozen history.
- **Pivot lessons surfaced.** The latest pivot lesson renders into every
  continuation prompt instead of disappearing into an unread `lessons.md`.
- **CI across OS.** First workflow runs the full suite on ubuntu, windows and
  macOS (vitest 4 fixes worker RPC timeouts); the environment-matrix suite
  proves the Windows dir-fsync guard host-portably.

### Changed
- README rewritten with a bold special thanks to
  [lhl/pi-multiloop](https://github.com/lhl/pi-multiloop), the inspiration.

## [0.1.0] - 2026-06-01

### Added
- **Multi-lane autonomous loops.** Many loops run side by side on a single
  worktree, each with independent state under `.multiloop/active/<lane>/<run>/`.
- **Four modes** — Optimize (edit, measure, keep/revert), Research (log-only
  sweeps), Dev (implement/test/commit tracking), Punchlist (markdown
  checklist).
- **Phase tools** — `multiloop_iterate`, `multiloop_measure`,
  `multiloop_decide`, `multiloop_log` own the on-disk state machine.
- **Commands** — `/multiloop` with status, ls, stop, pause, resume, archive,
  rm, help, and the `on`/`off` auto-continuation switch.
- **Flexible and compound verifiers** — any script measures progress; a
  metric plus mechanical/prompt checks must all pass for a keep.
- **Stop conditions** — cap by `maxIterations` or `targetMetric`, persisted in
  loop state.
- **Confidence scoring** — MAD-based improvement test for noisy benchmarks.
- **Durable history** — append-only JSONL per lane, resumable across restarts
  and compaction, with a live dashboard widget.
- **Escalation** — strategy adjusts after repeated failures (refine → pivot),
  and loops auto-continue their next step.

[Unreleased]: https://github.com/drvova/pi-multiloop/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/drvova/pi-multiloop/compare/v0.2.0...v0.3.2
[0.2.0]: https://github.com/drvova/pi-multiloop/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/drvova/pi-multiloop/releases/tag/v0.1.0