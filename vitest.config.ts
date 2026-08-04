import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/support/global-setup.ts"],
    // The long-horizon suites replay up to 60 simulated turns per case with
    // real filesystem I/O; on slow CI runners (Windows) 5000ms is not enough.
    testTimeout: 60_000,
    // Heavy sync suites (31k tests, 60-turn horizons) flood the main-process
    // RPC when every worker streams results; cap parallelism so the worker
    // IPC ("Timeout calling onTaskUpdate") stays healthy on small runners.
    maxWorkers: 2,
  },
});
