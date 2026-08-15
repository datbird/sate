import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { MODE_PRIMARY } from "../src/schema/index.ts";

// The SPA's MODES table (web/lib.js) is the user-visible authority for which metric a tracking
// mode rings on. MODE_PRIMARY is the server's copy. Read the browser table as TEXT and assert
// they agree.
//
// Importing web/lib.js directly (the pattern recurrence-anchors.test.ts uses for planner.js) was
// tried first and ruled out: lib.js runs an IIFE at module scope (`keyboardAwareSheets`, :555) that
// touches `window.visualViewport` on load, so a bare import throws `ReferenceError: window is not
// defined` under node:test before any assertion runs. Falling back to reading it as text, an import
// would drag in that DOM-dependent module scope.
//
// esbuild bundles this file to CJS before node:test runs it (see test/run.sh), which rules out both
// `import.meta.url` (esbuild replaces it with `{}` in CJS output, so `.url` is undefined and
// `new URL(path, undefined)` throws) and `__dirname`/`__filename` (they resolve to the bundle's
// tmpdir output location, not this source file, since bundling collapses everything into one file).
// Self-locate instead: walk up from cwd for @sate/core's package.json, so this works from any cwd
// inside the package — not only the exact `core/` dir test/run.sh happens to `cd` into.
function findCorePackageDir(from: string): string {
  let dir = resolve(from);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === "@sate/core") return dir;
    } catch {
      /* no package.json here, or unreadable — keep climbing */
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("could not locate the @sate/core package directory by walking up from " + from);
    }
    dir = parent;
  }
}

test("MODE_PRIMARY matches the SPA's MODES table", () => {
  const coreDir = findCorePackageDir(process.cwd());
  const src = readFileSync(join(coreDir, "src/web/lib.js"), "utf8");
  const table = src.slice(src.indexOf("export const MODES = {"));
  const body = table.slice(0, table.indexOf("};") + 1);
  const found: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(\w+):\s*\{[^}]*primary:\s*"(\w+)"/gm)) {
    found[m[1]] = m[2];
  }
  assert.ok(Object.keys(found).length >= 6, `parsed too few modes: ${JSON.stringify(found)}`);
  assert.deepEqual(found, MODE_PRIMARY);
});
