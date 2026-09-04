// tsc always emits `.js`; with "type": "module" the CJS output must be `.cjs`
// (and declarations `.d.cts`) or Node loads it as ESM and explodes.
// Internal relative imports are rewritten to match.
const { readdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const dir = join(__dirname, "..", "dist", "cjs");
for (const file of readdirSync(dir)) {
  const isJs = file.endsWith(".js");
  const isDts = file.endsWith(".d.ts");
  if (!isJs && !isDts) continue;

  let content = readFileSync(join(dir, file), "utf8");
  // Rewrite relative imports: ./x.js -> ./x.cjs (or .d.cts in declarations)
  content = content.replace(
    /(\.\.?\/[A-Za-z0-9_-]+)\.js(?![\w.])/g,
    isDts ? "$1.d.cts" : "$1.cjs",
  );
  // Keep source maps pointing at the renamed files
  content = content.replace(/"(source|file)":\s*"([^"]+)\.js"/g, (m, key, name) =>
    `"${key}": "${name}${isDts ? ".d.cts" : ".cjs"}"`,
  );
  writeFileSync(join(dir, file), content);

  const target = isDts
    ? file.replace(/\.d\.ts$/, ".d.cts")
    : file.replace(/\.js$/, ".cjs");
  if (target !== file) renameSync(join(dir, file), join(dir, target));
}
console.log("dist/cjs: rewritten imports and renamed to .cjs / .d.cts");
