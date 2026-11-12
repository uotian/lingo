import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/src/unit/**/*.test.js"],
    coverage: { provider: "v8", reportsDirectory: "tests/results/coverage", include: ["*.js", "scripts/**/*.mjs"] },
  },
});
