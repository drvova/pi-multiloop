#!/usr/bin/env node
// Test double for the `pi` binary in the multiloop-run driver unit tests.
// Behavior:
//   - After STUB_DELAY_MS (default 300), if STUB_NO_ADVANCE is unset, reads
//     the loop state at STUB_STATE_PATH, writes iteration+1 back, and appends
//     one fake result line, exactly like a real headless pi session that ran
//     multiloop_log (the durable write happens before the session ends).
//   - Prints one fake JSON line, then stays alive until killed — mimicking
//     the real pi worker fan-out that never exits, so the driver's
//     poll-and-reap path is exercised for real.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const stateFile = process.env.STUB_STATE_PATH;
const delayMs = Number(process.env.STUB_DELAY_MS ?? 300);
const noAdvance = process.env.STUB_NO_ADVANCE === "1";

setTimeout(() => {
  if (!noAdvance) {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const next = { ...state, iteration: (state.iteration ?? 0) + 1 };
    writeFileSync(stateFile, JSON.stringify(next, null, 2) + "\n");
    const resultsFile = join(stateFile, "..", "results.jsonl");
    appendFileSync(
      resultsFile,
      JSON.stringify({ iteration: next.iteration, action: "log", metric: 1 }) + "\n"
    );
  }
  console.log('{"type":"message_end","message":{"role":"assistant"}}');
}, delayMs);

setInterval(() => {}, 1000); // keep alive until the driver reaps the group