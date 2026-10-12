// Load both public entry points, including nested auth adapters, before publishing.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as esm from "../dist/esm/index.js";

const cjs = createRequire(import.meta.url)("../dist/cjs/index.cjs");
assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
for (const api of [esm, cjs]) {
  assert.equal(typeof api.AnimuApi, "function");
  assert.equal(typeof api.GoogleAdapter, "function");
}
console.log("ESM and CommonJS package entry points load with matching exports");
