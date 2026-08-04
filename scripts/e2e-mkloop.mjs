#!/usr/bin/env node
// Creates an optimize-mode loop on disk for the detached-driver e2e.
// Writes the state/registry JSON directly (mirrors createInitialState) and
// seeds a git repo with value.txt=1 so the built-in workspace boundary has
// something to fingerprint. Usage: node scripts/e2e-mkloop.mjs <repo> <lane> <runTag>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const [repo, lane, runTag] = process.argv.slice(2);
if (!repo || !lane || !runTag) {
  console.error("usage: node scripts/e2e-mkloop.mjs <repo> <lane> <runTag>");
  process.exit(2);
}

const stateDir = join(".multiloop", "active", lane, runTag);
mkdirSync(join(repo, stateDir), { recursive: true });
mkdirSync(join(repo, ".multiloop"), { recursive: true });

const now = new Date().toISOString();
const goal = "Increase the integer in value.txt to at least 2 by editing the file (rewrite 1 to 2), then run the verification command and decide.";

// Mirrors createInitialState: optional fields are ABSENT, never null — the
// extension reads absence with `!== undefined`, so a literal null would be
// treated as a configured value (e.g. targetMetric: null coerces to 0).
const state = {
  lane,
  runTag,
  mode: "optimize",
  iteration: 0,
  baseline: null,
  currentMetric: null,
  bestMetric: null,
  consecutiveFailures: 0,
  stallStreak: 0,
  pivotCount: 0,
  keeps: 0,
  reverts: 0,
  logs: 0,
  crashes: 0,
  blocked: 0,
  lastAction: null,
  status: "running",
  verifyCommand: "cat value.txt",
  minMeasurements: 1,
  acceptancePolicy: "metric improves and checks pass",
  metricName: "value",
  metricDirection: "higher",
  acceptanceMode: "keep-revert",
  scope: "value.txt",
  goal,
  maxIterations: 2,
  startedAt: now,
  lastUpdated: now,
  config: {},
};
writeFileSync(join(repo, stateDir, "state.json"), JSON.stringify(state, null, 2) + "\n");
writeFileSync(join(repo, stateDir, "results.jsonl"), "");

const registry = {
  version: 1,
  loops: [
    {
      lane,
      runTag,
      mode: "optimize",
      status: "active",
      startedAt: now,
      stateDir,
      verifyCommand: state.verifyCommand,
      acceptancePolicy: state.acceptancePolicy,
      metric: state.metricName,
    },
  ],
};
writeFileSync(join(repo, ".multiloop", "registry.json"), JSON.stringify(registry, null, 2) + "\n");

writeFileSync(join(repo, "value.txt"), "1\n");

execSync("git init -q", { cwd: repo });
execSync("git add value.txt && git -c user.email=e2e@test -c user.name=e2e commit -qm seed", { cwd: repo });
console.log(`loop ${lane}/${runTag} created at ${repo}`);
