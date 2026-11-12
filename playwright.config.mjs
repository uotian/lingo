import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/src/e2e",
  outputDir: "tests/results/e2e",
  workers: 1,
  webServer: {
    command: "node tests/src/e2e/mock-server.js",
    url: "http://127.0.0.1:4177/checks",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
