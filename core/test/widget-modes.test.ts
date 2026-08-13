import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MODE_PRIMARY } from "../src/schema/index.ts";

// The SPA's MODES table (web/lib.js) is the user-visible authority for which metric a tracking
// mode rings on. MODE_PRIMARY is the server's copy. Read the browser table as TEXT and assert
// they agree — an import would drag in DOM-dependent module scope.
test("MODE_PRIMARY matches the SPA's MODES table", () => {
  // esbuild bundles this file to CJS for node:test, which strips import.meta.url (it becomes
  // undefined, and `new URL(..., undefined)` throws). test/run.sh guarantees cwd is core/.
  const src = readFileSync("src/web/lib.js", "utf8");
  const table = src.slice(src.indexOf("export const MODES = {"));
  const body = table.slice(0, table.indexOf("};") + 1);
  const found: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(\w+):\s*\{[^}]*primary:\s*"(\w+)"/gm)) {
    found[m[1]] = m[2];
  }
  assert.ok(Object.keys(found).length >= 6, `parsed too few modes: ${JSON.stringify(found)}`);
  assert.deepEqual(found, MODE_PRIMARY);
});
