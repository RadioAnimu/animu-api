#!/usr/bin/env node
/**
 * Every check CI runs, in its order, with one summary at the end: each step
 * runs even after a failure, so one pass shows all that is broken.
 *
 * `check:ci` (GitHub CI and Jenkins) and `check:quality` (the app's submodule
 * check, run in a copy without Git history) are this script, so CI and a
 * local run cannot drift apart.
 *
 * usage: pnpm verify               every step (as check:ci)
 *        pnpm verify --fast        skips the slow ones (secrets, audit)
 *        pnpm verify --no-secrets  every step but the history scan (as check:quality)
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** A package script; `slow` steps are skipped by `--fast`, `history` ones by `--no-secrets`. */
export const STEPS = [
  { label: "secrets", script: "check:secrets", slow: true, history: true },
  { label: "tooling tests", script: "test:tooling" },
  { label: "dependency audit", script: "check:audit", slow: true },
  { label: "eslint", script: "lint:eslint" },
  { label: "oxlint (type-aware)", script: "lint:types" },
  { label: "knip", script: "lint:deps" },
  { label: "typecheck", script: "typecheck" },
  { label: "unit tests + coverage", script: "test:coverage" },
  { label: "build", script: "build" },
];

const FLAGS = new Set(["--fast", "--no-secrets"]);

/** The steps `args` select, or `null` for an unknown argument. */
export function plan(args) {
  if (args.some((arg) => !FLAGS.has(arg))) return null;
  return STEPS.filter(
    (step) => !(args.includes("--fast") && step.slow) && !(args.includes("--no-secrets") && step.history),
  );
}

/** The package manager this script runs under (its own binary, as `pnpm run` set it), or pnpm. */
function runner() {
  const execPath = process.env.npm_execpath;
  return execPath ? [process.execPath, execPath] : ["pnpm"];
}

function main(args) {
  const steps = plan(args);
  if (!steps) {
    console.error("usage: pnpm verify [--fast] [--no-secrets]");
    return 2;
  }
  const [command, ...prefix] = runner();
  const results = [];
  for (const { label, script } of steps) {
    console.log(`\n▶ ${label} (${script})`);
    const started = Date.now();
    const { status, error } = spawnSync(command, [...prefix, "run", script], { stdio: "inherit" });
    // A command that could not start prints nothing itself.
    if (error) console.error(`  ${command}: ${error.message}`);
    results.push({ label, ok: status === 0, seconds: Math.round((Date.now() - started) / 1000) });
  }

  console.log("\nverify summary");
  for (const { label, ok, seconds } of results) {
    console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(24)} ${String(seconds).padStart(4)} s`);
  }
  const failed = results.filter((result) => !result.ok);
  console.log(failed.length ? `\n${failed.length} step(s) failed.` : "\nAll steps passed.");
  return failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
