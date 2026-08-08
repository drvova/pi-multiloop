#!/usr/bin/env bash
# End-to-end proof that the extension's keep/revert acceptance gate works in a
# detached (headless pi) iteration driven by packages/multiloop-run/bin/multiloop-run.mjs.
#
# Creates a temp repo with an optimize-mode loop (verifyCommand: cat value.txt,
# metric 1, direction higher), drives 2 iterations, then asserts that at least
# one iteration recorded action 'keep' and the metric reached >= 2 — i.e. the
# headless session really edited the file, measured the improvement, and the
# extension's acceptance machinery promoted it. Exit 0 on success, 1 on any
# failed assertion.
#
# Usage: scripts/e2e-optimize.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/ml-e2e-XXXXXX)"
REPO="$WORK/repo"
SESSION_GLOB="$HOME/.pi/agent/sessions/"*"$(basename "$WORK")"*
RESULT=1
cleanup() {
  # Remove the temp repo and the headless children's session dir (the driver
  # SIGKILLs the worker fan-out; the stale session dir would block the next pi
  # in the same cwd).
  rm -rf "$WORK"
  rm -rf $SESSION_GLOB
}
trap cleanup EXIT

mkdir -p "$REPO"
node "$ROOT/scripts/e2e-mkloop.mjs" "$REPO" opt run-001 >/dev/null || exit 1

echo "== driving detached optimize loop (2 iterations, real headless pi) =="
# Timeout note: the thin-kick prompt adds one round-trip (multiloop_resume) per
# iteration, and iteration 1 also pays session load + baseline establishment in
# the same window. 480s was calibrated to the old inline-protocol prompt; align
# with the driver's own default (900s) so slow/local models are not failed for
# being slow.
node "$ROOT/packages/multiloop-run/bin/multiloop-run.mjs" "$REPO" opt run-001 --iterations 2 --timeout-sec 900 || {
  echo "FAIL: driver exited non-zero"
  exit 1
}

STATE="$REPO/.multiloop/active/opt/run-001/state.json"
RESULTS="$REPO/.multiloop/active/opt/run-001/results.jsonl"

echo "== assertions =="
ITERATION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).iteration)' "$STATE")"
METRIC="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(s.currentMetric??"null")' "$STATE")"
KEEPS="$(grep -c '"action":"keep"' "$RESULTS" 2>/dev/null || echo 0)"
echo "iteration=$ITERATION currentMetric=$METRIC keeps=$KEEPS"

if [ "$ITERATION" -ge 1 ] && [ "$KEEPS" -ge 1 ] && [ "$METRIC" != "null" ] && [ "$METRIC" -ge 2 ]; then
  echo "PASS: keep/revert acceptance gated a real detached iteration (keep recorded, metric $METRIC)"
  RESULT=0
else
  echo "FAIL: expected iteration>=1 keeps>=1 metric>=2, got iteration=$ITERATION keeps=$KEEPS metric=$METRIC"
  echo "--- results.jsonl ---"
  cat "$RESULTS" 2>/dev/null
fi

exit "$RESULT"
