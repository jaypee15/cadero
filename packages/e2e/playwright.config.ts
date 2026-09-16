import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 120000,
  globalSetup: "tests/global-setup.ts",
  // One retry absorbs the known-flaky assertion paths (see backlog: parked
  // opencode E2E flake); the explicit list reporter keeps CI logs readable.
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
  },
  workers: 1,
});
