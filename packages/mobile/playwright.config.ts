import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120000,
  globalSetup: "tests/e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
  },
  workers: 1,
});
