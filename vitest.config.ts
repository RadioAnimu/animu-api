import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
