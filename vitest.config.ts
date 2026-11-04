import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Beside the other `pnpm verify` steps: half the cores for the test files.
    ...(process.env.VERIFY_RUNNING ? { maxWorkers: "50%" } : {}),
    include: ["tests/**/*.test.ts"],
    environment: "node",
    reporters: process.env.CI ? ["default", ["junit", { outputFile: "junit.xml" }]] : ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      // Regression floors below the measured baseline; raise as coverage grows.
      thresholds: { statements: 89, branches: 77, functions: 90, lines: 90 },
    },
  },
});
