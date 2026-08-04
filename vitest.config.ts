import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/support/global-setup.ts"],
    // The long-horizon suites replay up to 60 simulated turns per case with
    // real filesystem I/O; on slow CI runners (Windows) 5000ms is not enough.
    testTimeout: 60_000,
  },
});
