import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { plan, STEPS } from "../verify.mjs";

const scripts = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts;
const labels = (steps) => steps.map((step) => step.label);

test("every step is a package script", () => {
  for (const { script } of STEPS) assert.ok(scripts[script], `no "${script}" script`);
});

test("CI runs every step, and the app's submodule check all but the history scan", () => {
  assert.equal(scripts["check:ci"], "node scripts/verify.mjs");
  assert.equal(scripts["check:quality"], "node scripts/verify.mjs --no-secrets");
  assert.deepEqual(labels(plan([])), labels(STEPS));
  assert.deepEqual(
    labels(plan(["--no-secrets"])),
    labels(STEPS.filter((step) => step.script !== "check:secrets")),
  );
});

test("`pnpm run lint` runs the same linters as verify", () => {
  const linters = STEPS.filter((step) => step.script.startsWith("lint:")).map((step) => `pnpm run ${step.script}`);
  assert.deepEqual(scripts.lint.split(" && "), linters);
});

test("--fast skips the slow steps; an unknown flag is refused", () => {
  assert.ok(plan(["--fast"]).every((step) => !step.slow));
  assert.ok(plan(["--fast"]).some((step) => step.script === "test:coverage"));
  assert.equal(plan(["--fats"]), null);
});
