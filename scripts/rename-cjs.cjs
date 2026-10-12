// tsc always emits `.js`; with "type": "module" the CJS output must be `.cjs`
// (and declarations `.d.cts`) or Node loads it as ESM and explodes.
// Internal relative imports are rewritten to match.
const { readdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const dir = join(__dirname, "..", "dist", "cjs");
function rewrite(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = entry.name;
    if (entry.isDirectory()) {
      rewrite(join(directory, file));
      continue;
    }
    const isJs = file.endsWith(".js");
    const isDts = file.endsWith(".d.ts");
    if (!isJs && !isDts) continue;

    let content = readFileSync(join(directory, file), "utf8");
    // .cjs specifiers resolve to .d.cts for TypeScript consumers too.
    content = content.replace(
      /(\.\.?\/[A-Za-z0-9_./-]+)\.js(?![\w.])/g,
      "$1.cjs",
    );
    // Keep source maps pointing at the renamed files
    content = content.replace(/"(source|file)":\s*"([^"]+)\.js"/g, (m, key, name) =>
      `"${key}": "${name}${isDts ? ".d.cts" : ".cjs"}"`,
    );
    writeFileSync(join(directory, file), content);

    const target = isDts
      ? file.replace(/\.d\.ts$/, ".d.cts")
      : file.replace(/\.js$/, ".cjs");
    if (target !== file) renameSync(join(directory, file), join(directory, target));
  }
}
rewrite(dir);
console.log("dist/cjs: rewritten imports and renamed to .cjs / .d.cts");
