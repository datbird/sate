# Planner Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a planning state to diary entries (`status: "logged" | "planned"`), guarantee planned entries never count toward any total, and add the manual-accept flow that turns a planned entry into a logged one — the correctness spine the rest of the Planner builds on.

**Architecture:** All changes land in `@sate/core` (`~/gitrepos/sate/core`), deployed to Cloud (sate.health) via sate-cloud. Entries gain three additive, optional Zod fields. A single `isLogged()` predicate is applied at every place that sums intake/burn so "planned" is invisible to totals. A new `core/src/api/plan.ts` route module adds `POST /api/plan/entry` (create a one-off planned entry) and `POST /api/plan/accept` (flip planned → logged). A first-class test harness is established (none exists today): an in-memory `Platform` fake driven through Hono's `app.request`, bundled with esbuild and run under `node --test`.

**Tech Stack:** TypeScript (Node 24, run via esbuild bundle + native `node:test`), Hono, Zod, the ports/adapters `DataStore` abstraction. No new runtime dependencies.

## Global Constraints

Copied verbatim from the spec (`docs/superpowers/specs/2026-07-23-planner-recipes-coach-plan-design.md`) — every task inherits these:

- **Cloud edition only, core-first.** All schema/logic lands in `@sate/core`. The Hosted (`pb_hooks`/`pb_public`) port is explicitly OUT OF SCOPE.
- **No Cloud migration.** Firestore is schemaless; new fields default in. All new `entries` fields MUST be optional/defaulted so existing documents (which lack them) still parse and read as `logged`.
- **The honesty rule (non-negotiable):** `dayTotals`, `/api/stats` aggregation, `/api/me` totals, and the coach day totals MUST filter to `status == "logged"`. A planned entry or projected occurrence counts ZERO toward intake/burn/remaining until accepted. This is the single most important regression to test.
- **The existing rule "activity is excluded from intake" is unchanged** — planned-exclusion is layered on top of it, never replacing it.
- **Accept = manual confirm.** Nothing auto-accepts. `status` flips `planned → logged` only through `POST /api/plan/accept`.
- **Backward-compat:** an entry with no `status` field (every entry that exists today) is treated as `logged`. `isLogged(e)` returns `e.status !== "planned"`, never `e.status === "logged"`.

---

## File Structure

- **Create `core/test/mem.ts`** — in-memory `Platform` fake (DataStore over `Map`s) + `client()` helper that builds the API with `trustEmailHeader` and returns a request function. Test-only; never imported by production code.
- **Create `core/test/run.sh`** — bundles every `core/test/*.test.ts` with esbuild to a temp dir and runs `node --test`. Wired as `npm test`.
- **Create `core/test/harness.test.ts`** — one smoke test proving the harness loads the real API and reads totals.
- **Create `core/test/honesty.test.ts`** — the honesty-rule regression tests (Task 3).
- **Create `core/test/plan.test.ts`** — planned-entry create + accept tests (Tasks 4–5).
- **Create `core/src/api/plan.ts`** — `registerPlan(app, deps)`: `POST /api/plan/entry`, `POST /api/plan/accept`.
- **Modify `core/src/schema/index.ts`** — add `status`, `plan_schedule_id`, `scheduled_date` to `Entry`.
- **Modify `core/src/api/helpers.ts`** — export `isLogged()`.
- **Modify `core/src/api/entries.ts`** — `dayTotals()` skips non-logged.
- **Modify `core/src/api/profile.ts`** — `/api/me` totals and `/api/stats` exclude non-logged.
- **Modify `core/src/api/coach.ts`** — the two entry-list reads exclude non-logged.
- **Modify `core/src/api/index.ts`** — mount `registerPlan`.
- **Modify `core/package.json`** — add `"test"` script.

Note: `core/package.json` currently has **no** `scripts` block. `tsc` is exercised from **sate-cloud** (`cd ~/gitrepos/sate-cloud && npx tsc --noEmit`), which vendors `core/` as a subtree — that is the canonical typecheck for core changes and MUST stay green.

---

### Task 1: Test harness (in-memory Platform fake + runner)

No test infrastructure exists in this repo. This task builds it: a `Platform` fake backed by `Map`s, an esbuild-bundle runner (core uses extensionless relative imports that Node's native ESM loader rejects, so tests must be bundled first), and one smoke test that loads the real `buildApi` and reads totals through `app.request`. Verified working before this plan was written.

**Files:**
- Create: `core/test/mem.ts`
- Create: `core/test/run.sh`
- Create: `core/test/harness.test.ts`
- Modify: `core/package.json` (add `scripts.test` + `esbuild` devDependency)

**Interfaces:**
- Produces: `memPlatform(): { platform: Platform; users: Map<string, MemStore>; inst: MemStore }` and `client(): { req, users, platform }` where `req(path, init?) => Promise<Response>` sends the `x-user-email` trusted header. Later tasks' tests import `client` from `./mem.ts`.

- [ ] **Step 1: Write `core/test/mem.ts`**

```typescript
// In-memory Platform fake for core route tests. Test-only — never imported by production code.
// Backs the DataStore ports with plain Maps; auth is bypassed via buildApi's trustEmailHeader.
import type { Platform } from "../src/ports";
import { buildApi } from "../src/api/index";

type Doc = Record<string, any>;

function match(doc: Doc, w: { field: string; op: string; value: any }): boolean {
  const v = doc[w.field];
  const t = w.value;
  switch (w.op) {
    case "==": return v === t;
    case "!=": return v !== t;
    case "<": return v < t;
    case "<=": return v <= t;
    case ">": return v > t;
    case ">=": return v >= t;
    case "in": return Array.isArray(t) && t.includes(v);
    case "array-contains": return Array.isArray(v) && v.includes(t);
    default: return true;
  }
}

export class MemStore {
  colls = new Map<string, Map<string, Doc>>();
  seq = 0;
  private c(n: string) {
    if (!this.colls.has(n)) this.colls.set(n, new Map());
    return this.colls.get(n)!;
  }
  async get(coll: string, id: string) { return this.c(coll).get(id) ?? null; }
  async list(coll: string, spec: any = {}) {
    let items = [...this.c(coll).values()].map((d) => ({ ...d }));
    for (const w of spec.where ?? []) items = items.filter((d) => match(d, w));
    for (const o of (spec.orderBy ?? []).slice().reverse()) {
      const dir = o.dir === "desc" ? -1 : 1;
      items.sort((a, b) => (a[o.field] < b[o.field] ? -dir : a[o.field] > b[o.field] ? dir : 0));
    }
    if (spec.limit) items = items.slice(0, spec.limit);
    return { items };
  }
  async create(coll: string, data: Doc, id?: string) {
    const _id = id ?? `id${++this.seq}`;
    const doc = { ...data, id: _id };
    this.c(coll).set(_id, doc);
    return { ...doc };
  }
  async update(coll: string, id: string, patch: Doc) {
    const cur = this.c(coll).get(id) ?? { id };
    const doc = { ...cur, ...patch, id };
    this.c(coll).set(id, doc);
    return { ...doc };
  }
  async delete(coll: string, id: string) { this.c(coll).delete(id); }
  async batch() { throw new Error("batch not implemented in fake"); }
  watch() { return () => {}; }
}

export function memPlatform() {
  const users = new Map<string, MemStore>();
  const inst = new MemStore();
  const provider = {
    forUser(uid: string) {
      if (!users.has(uid)) users.set(uid, new MemStore());
      return users.get(uid) as any;
    },
    instance() { return inst as any; },
  };
  const platform = {
    data: provider,
    auth: { async verify() { throw new Error("no bearer in tests"); } },
    files: { async put() { return { key: "", url: "" }; }, async get() { return null; }, async url() { return ""; }, async delete() {} },
    secrets: { async get() { return undefined; } },
  } as unknown as Platform;
  return { platform, users, inst };
}

export const TEST_EMAIL = "tester@example.com";

// Build the API with header-trust auth and return a request helper that sends the trusted email.
export function client(email: string = TEST_EMAIL) {
  const { platform, users, inst } = memPlatform();
  const app = buildApi(platform, { trustEmailHeader: "x-user-email" });
  const req = (path: string, init: any = {}) =>
    app.request(path, {
      ...init,
      headers: { "x-user-email": email, "content-type": "application/json", ...(init.headers || {}) },
    });
  return { req, users, inst, platform, email };
}
```

- [ ] **Step 2: Write `core/test/run.sh`**

```bash
#!/usr/bin/env bash
# Run core unit tests. Core uses extensionless relative imports that Node's native ESM loader
# rejects, so each test file is bundled with esbuild (which resolves them + strips types) before
# running under node:test. Run with bash (not sh): set -o pipefail is a bashism.
set -euo pipefail
cd "$(dirname "$0")/.."   # -> core/
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
shopt -s nullglob
files=(test/*.test.ts)
if [ ${#files[@]} -eq 0 ]; then echo "no test files"; exit 0; fi
for f in "${files[@]}"; do
  npx esbuild "$f" --bundle --platform=node --format=cjs --outfile="$out/$(basename "$f" .ts).cjs" >/dev/null
done
node --test "$out"/*.cjs
```

- [ ] **Step 3: Add the `test` script + `esbuild` devDep to `core/package.json`, then install**

`core/package.json` has no `scripts` key today. The runner needs esbuild in `core/node_modules` (it is NOT a current core dep — earlier runs resolved an ambient/cached copy, which is not reproducible). Add a `scripts` block and add `esbuild` to `devDependencies` (match sate-cloud's `^0.24.0` so the vendored subtree stays consistent), leaving `dependencies` untouched:

```json
  "scripts": {
    "test": "bash test/run.sh"
  },
```

Add to `devDependencies` (alongside the existing `typescript` entry):

```json
    "esbuild": "^0.24.0"
```

Then install so `core/node_modules/.bin/esbuild` exists:

Run: `cd ~/gitrepos/sate/core && npm install`
Expected: completes; `ls node_modules/.bin/esbuild` succeeds.

- [ ] **Step 4: Write the smoke test `core/test/harness.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

test("harness: GET /api/entries reads a seeded logged entry's totals through app.request", async () => {
  const { req, platform } = client();
  const store = platform.data.forUser(TEST_EMAIL);
  await store.create("entries", {
    user: TEST_EMAIL, kind: "food", description: "eggs", kcal: 200,
    macros: { protein: 12, carbs: 1, fat: 15 },
    logged_at: "2026-07-23T12:00:00.000Z", day: "2026-07-23",
  });
  const res = await req("/api/entries?day=2026-07-23&tz=0");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.totals.kcal, 200);
  assert.equal(body.entries.length, 1);
});
```

- [ ] **Step 5: Make `run.sh` executable and run the harness**

Run: `cd ~/gitrepos/sate/core && chmod +x test/run.sh && npm test`
Expected: PASS — `✔ harness: GET /api/entries ...`, `ℹ pass 1`, `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/test/mem.ts core/test/run.sh core/test/harness.test.ts core/package.json
git commit -m "test(core): in-memory Platform harness + esbuild+node:test runner"
```

---

### Task 2: Add the planning fields to the Entry schema

**Files:**
- Modify: `core/src/schema/index.ts` (the `Entry` object, after `ext_id` at line ~87)
- Test: `core/test/harness.test.ts` (append one schema assertion) — or a new `core/test/schema.test.ts`

**Interfaces:**
- Produces: `Entry.status: "logged" | "planned"` (default `"logged"`), `Entry.plan_schedule_id?: string`, `Entry.scheduled_date?: string`. Consumed by every later task and by the honesty helper.

- [ ] **Step 1: Write the failing test `core/test/schema.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { Entry } from "../src/schema/index.ts";

test("Entry.status defaults to 'logged' when absent (backward-compat)", () => {
  const e = Entry.parse({ id: "x", user: "u", description: "d", logged_at: "2026-07-23T00:00:00.000Z" });
  assert.equal(e.status, "logged");
});

test("Entry accepts status:'planned' + plan_schedule_id + scheduled_date", () => {
  const e = Entry.parse({
    id: "x", user: "u", description: "d", logged_at: "2026-07-23T00:00:00.000Z",
    status: "planned", plan_schedule_id: "sch1", scheduled_date: "2026-07-24",
  });
  assert.equal(e.status, "planned");
  assert.equal(e.plan_schedule_id, "sch1");
  assert.equal(e.scheduled_date, "2026-07-24");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — the first test fails (`e.status` is `undefined`, not `"logged"`) and/or the second (unknown keys stripped so `e.status` is undefined).

- [ ] **Step 3: Add the fields to `Entry` in `core/src/schema/index.ts`**

Insert immediately after the `ext_id` line (`ext_id: z.string().optional(), // external-source dedup key ...`) and before the closing `});` of the `Entry` object:

```typescript
  // ---- planning (Planner phase 1) ----
  // status="planned" = a future meal/activity that has NOT happened; it carries the *intended*
  // content but is EXCLUDED from every total until accepted (status→"logged") via POST /api/plan/accept.
  // Absent on all pre-Planner entries → treated as "logged" (see isLogged in api/helpers).
  status: z.enum(["logged", "planned"]).default("logged"),
  // Set on an entry materialized from a recurring schedule occurrence (phase 2). (schedule id, date)
  // is the occurrence identity, mirroring BalanceEngine's {scheduleId}:{date}.
  plan_schedule_id: z.string().optional(),
  scheduled_date: z.string().optional(), // YYYY-MM-DD occurrence date this entry materialized from
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — both schema tests green; harness test still green.

- [ ] **Step 5: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/schema/index.ts core/test/schema.test.ts
git commit -m "feat(core): add entries.status + plan_schedule_id + scheduled_date (planned entries)"
```

---

### Task 3: The honesty rule — exclude planned entries from every total

**Files:**
- Modify: `core/src/api/helpers.ts` (export `isLogged` + `dayIntakeTotals`)
- Modify: `core/src/api/entries.ts` (delegate `dayTotals` to the shared helper)
- Modify: `core/src/api/profile.ts` (`/api/me` totals line ~217; `/api/stats` after `fetchDayRange` line ~310)
- Modify: `core/src/api/coach.ts` (two entry-list reads, lines ~177 and ~456)
- Test: `core/test/honesty.test.ts`

**Interfaces:**
- Consumes: `Entry.status` (Task 2).
- Produces: `isLogged(e: { status?: string }): boolean` (returns `e.status !== "planned"`) and `dayIntakeTotals(store: DataStore, day: string): Promise<{kcal, protein, carbs, fat, fiber, sugar, sodium, sat_fat, count: number}>` — the ONE canonical by-day intake total (planned excluded, activity excluded), exported from `api/helpers`. `entries.ts` delegates its `dayTotals` to it and `plan.ts` (Task 5) reuses it — no duplicated summation logic anywhere.

- [ ] **Step 1: Write the failing test `core/test/honesty.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, TEST_EMAIL } from "./mem.ts";

// Seed one logged + one planned food entry on the same day, then assert planned is invisible to totals.
async function seedDay(platform: any, day: string) {
  const store = platform.data.forUser(TEST_EMAIL);
  await store.create("entries", {
    user: TEST_EMAIL, kind: "food", description: "logged lunch", kcal: 500,
    macros: { protein: 30, carbs: 40, fat: 20 }, status: "logged",
    logged_at: `${day}T12:00:00.000Z`, day,
  });
  await store.create("entries", {
    user: TEST_EMAIL, kind: "food", description: "planned dinner", kcal: 800,
    macros: { protein: 50, carbs: 60, fat: 30 }, status: "planned",
    logged_at: `${day}T19:00:00.000Z`, day,
  });
}

test("GET /api/entries totals exclude the planned entry", async () => {
  const { req, platform } = client();
  await seedDay(platform, "2026-07-23");
  const res = await req("/api/entries?day=2026-07-23&tz=0");
  const body = await res.json();
  assert.equal(body.totals.kcal, 500, "planned 800 must not be counted");
  assert.equal(body.totals.protein, 30);
});

test("GET /api/me today totals exclude the planned entry", async () => {
  const { req, platform } = client();
  const today = new Date().toISOString().slice(0, 10);
  await seedDay(platform, today);
  const res = await req("/api/me?tz=0");
  const body = await res.json();
  assert.equal(body.totals.kcal, 500);
});

test("GET /api/stats window totals + series exclude the planned entry", async () => {
  const { req, platform } = client();
  const today = new Date().toISOString().slice(0, 10);
  await seedDay(platform, today);
  const res = await req("/api/stats?range=day&tz=0");
  const body = await res.json();
  assert.equal(body.in.kcal, 500, "stats intake must exclude planned");
  const todaysBucket = (body.series as any[]).find((s) => s.bucket === today);
  assert.ok(todaysBucket, "series has today's bucket");
  assert.equal(todaysBucket.in_kcal, 500, "series must exclude planned");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — totals read 1300 (500+800) instead of 500; stats `in.kcal` and `series` include the planned 800.

- [ ] **Step 3: Export `isLogged` + `dayIntakeTotals` from `core/src/api/helpers.ts`**

`helpers.ts` already imports `Food, Profile` from `../schema`; add `Entry, Macros` to that type import, and add `DataStore` to a `../ports` type import (add the import line if absent):

```typescript
import type { Entry, Food, Macros, Profile } from "../schema";
import type { DataStore } from "../ports";
```

Add after the `dayKey` function (line ~43), before `instanceSettings`:

```typescript
// ---- planning honesty rule -------------------------------------------------
// A planned entry (status:"planned") carries INTENDED content but counts toward NO total until it is
// accepted (status→"logged"). Entries created before the Planner have no status field → treated as
// logged. Every intake/burn aggregation filters on this. (Activity-vs-intake exclusion is separate.)
export const isLogged = (e: { status?: string }): boolean => e.status !== "planned";

// The ONE canonical server-authoritative day-intake total. Sums a local day's LOGGED food entries;
// planned entries (honesty rule) and activity entries (burn, never intake) are excluded. Every route
// that reports a single day's totals (log routes, /api/entries, accept) uses this — no re-implementation.
export async function dayIntakeTotals(
  store: DataStore,
  day: string,
): Promise<{ kcal: number; protein: number; carbs: number; fat: number; fiber: number; sugar: number; sodium: number; sat_fat: number; count: number }> {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0, sat_fat: 0, count: 0 };
  if (!day) return t;
  let items: Entry[] = [];
  try {
    ({ items } = await store.list<Entry>("entries", { where: [{ field: "day", op: "==", value: day }], limit: 500 }));
  } catch {
    return t;
  }
  const num = (v: unknown): number => { const n = Number(v); return isFinite(n) ? n : 0; };
  for (const e of items) {
    if (!isLogged(e)) continue; // planned entries never count toward intake
    if (e.kind === "activity") continue; // burn is not intake
    const m = (e.macros || {}) as Macros;
    t.count += 1;
    t.kcal += num(e.kcal);
    t.protein += num(m.protein); t.carbs += num(m.carbs); t.fat += num(m.fat);
    t.fiber += num(m.fiber); t.sugar += num(m.sugar); t.sodium += num(m.sodium); t.sat_fat += num(m.sat_fat);
  }
  return t;
}
```

- [ ] **Step 4: Delegate `core/src/api/entries.ts` `dayTotals` to the shared helper**

Add `isLogged` and `dayIntakeTotals` to the existing helpers import (top of file, the `from "./helpers"` block):

```typescript
import {
  getUid, getEmail, ok, err, dayKey, ensureProfile, foodGrounding, isLogged, dayIntakeTotals,
  type App, type AppVars, type RouteDeps,
} from "./helpers";
```

Then REPLACE the entire local `dayTotals` function (the block from `// ---- server-authoritative day intake totals (v1 sumTotals) --------------` through the function's closing `}` at line ~97) with a one-line delegation to the shared helper — the summation now lives once, in `helpers.ts`:

```typescript
// ---- server-authoritative day intake totals (v1 sumTotals) --------------
// Delegates to the shared dayIntakeTotals in helpers (planned-excluded, activity-excluded) so the
// honesty rule and the summation are defined exactly once. Call sites are unchanged.
const dayTotals = dayIntakeTotals;
```

(`FlatTotal`, `macrosOf`, and the rest of `entries.ts` are untouched; every existing `dayTotals(store, day)` call site keeps working — the signature and return shape are identical.)

- [ ] **Step 5: Apply the filter in `core/src/api/profile.ts` (`/api/me` + `/api/stats`)**

Import `isLogged`. `profile.ts` imports helpers; add `isLogged` to that import list (the `from "./helpers"` line).

In `/api/me` (line ~217) change:

```typescript
      totals: sumIntake(items),
```

to:

```typescript
      totals: sumIntake(items.filter(isLogged)),
```

In `/api/stats` (line ~310) change:

```typescript
    const recs = await fetchDayRange(platform, uid, w.startDay, w.endDay);
```

to:

```typescript
    const recs = (await fetchDayRange(platform, uid, w.startDay, w.endDay)).filter(isLogged);
```

(Filtering `recs` once excludes planned from intake, burn, averages, AND the trend series — they all derive from `recs`.)

- [ ] **Step 6: Apply the filter in `core/src/api/coach.ts` (both entry reads)**

Import `isLogged` (add to the `from "./helpers"` import). At the nutritionist-context read (line ~186) change:

```typescript
    items = res.items;
```

to:

```typescript
    items = res.items.filter(isLogged);
```

At the day-summary read (line ~462) change the analogous:

```typescript
      items = res.items;
```

to:

```typescript
      items = res.items.filter(isLogged);
```

(There are two `items = res.items;` assignments in this file — apply the filter to **both**.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — all honesty tests green (totals 500, stats 500, series 500); harness + schema tests still green.

- [ ] **Step 8: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/api/helpers.ts core/src/api/entries.ts core/src/api/profile.ts core/src/api/coach.ts core/test/honesty.test.ts
git commit -m "feat(core): honesty rule — exclude planned entries from all totals (isLogged)"
```

---

### Task 4: `POST /api/plan/entry` — create a one-off planned entry

The primitive that gives the accept flow something to accept and makes Phase 1 a real vertical slice (create planned → totals unchanged → accept → totals change). Minimal by design: it stores explicit content the caller supplies; the plan-an-event UI (Phase 3/4) and recipe suggester (Phase 5) call it. No AI.

**Files:**
- Create: `core/src/api/plan.ts`
- Modify: `core/src/api/index.ts` (import + mount `registerPlan`)
- Test: `core/test/plan.test.ts`

**Interfaces:**
- Consumes: `RouteDeps`, `dayKey`, `ok`, `err`, `getUid`, `getEmail`, `ensureProfile` from `./helpers`; `Entry`, `Macros` from `../schema`.
- Produces: `registerPlan(app: App, deps: RouteDeps): Promise<void>`. Route `POST /api/plan/entry` body `{ kind?: "food"|"activity", description, kcal?, macros?, items?, duration_min?, distance?, intensity?, note?, logged_at?, tz_offset_min? }` → creates `entry{status:"planned"}`, returns `{ entry }`.

- [ ] **Step 1: Write the failing test `core/test/plan.test.ts`**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { client } from "./mem.ts";

test("POST /api/plan/entry creates a planned entry that is excluded from totals", async () => {
  const { req } = client();
  const create = await req("/api/plan/entry", {
    method: "POST",
    body: JSON.stringify({
      kind: "food", description: "planned dinner", kcal: 800,
      macros: { protein: 50, carbs: 60, fat: 30 },
      logged_at: "2026-07-24T19:00:00.000Z", tz_offset_min: 0,
    }),
  });
  assert.equal(create.status, 200);
  const { entry } = await create.json();
  assert.equal(entry.status, "planned");
  assert.equal(entry.day, "2026-07-24");
  assert.equal(entry.kcal, 800);

  // It's stored but invisible to that day's totals.
  const day = await req("/api/entries?day=2026-07-24&tz=0");
  const body = await day.json();
  assert.equal(body.entries.length, 1, "planned entry is listed");
  assert.equal(body.totals.kcal, 0, "planned entry contributes nothing");
});

test("POST /api/plan/entry requires a description", async () => {
  const { req } = client();
  const res = await req("/api/plan/entry", { method: "POST", body: JSON.stringify({ kcal: 100 }) });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `POST /api/plan/entry` 404 (route not mounted).

- [ ] **Step 3: Create `core/src/api/plan.ts` with the create route**

```typescript
// Sate core — Planner routes. Phase 1: create a one-off PLANNED entry and ACCEPT it (planned→logged).
// A planned entry carries its *intended* content but is excluded from every total (see isLogged in
// helpers) until accepted here. Recurring schedules, projection, and the occurrence-accept branch are
// phase 2. All routes are non-AI. Ported onto the shared ports; identity is the Firebase uid.

import {
  getUid, getEmail, ok, err, dayKey, ensureProfile,
  type App, type RouteDeps,
} from "./helpers";
import type { Entry, Macros } from "../schema";

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function macrosOf(m: any): Macros {
  return {
    protein: num(m?.protein), carbs: num(m?.carbs), fat: num(m?.fat),
    fiber: num(m?.fiber), sugar: num(m?.sugar), sodium: num(m?.sodium), sat_fat: num(m?.sat_fat),
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function registerPlan(app: App, deps: RouteDeps): Promise<void> {
  const { platform } = deps;

  // ---- POST /api/plan/entry — create a one-off PLANNED entry (no AI, no schedule).
  app.post("/api/plan/entry", async (c) => {
    const uid = getUid(c);
    await ensureProfile(platform, uid, getEmail(c));
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const description = String(b.description || "").trim();
    if (!description) return err(c, "description is required", 400);
    const kind: Entry["kind"] = b.kind === "activity" ? "activity" : "food";
    const store = platform.data.forUser(uid);
    const logged_at = b.logged_at ? new Date(b.logged_at).toISOString() : new Date().toISOString();
    const tz = num(b.tz_offset_min);
    const day = dayKey(logged_at, tz);
    const draft: Record<string, any> = {
      user: uid,
      kind,
      status: "planned",
      description: description.slice(0, 2000),
      note: b.note !== undefined ? String(b.note).slice(0, 2000) : undefined,
      source: "plan",
      kcal: num(b.kcal),
      items: Array.isArray(b.items) ? b.items : undefined,
      logged_at,
      tz_offset_min: tz,
      day,
    };
    if (kind === "food") {
      draft.macros = macrosOf(b.macros);
    } else {
      draft.duration_min = num(b.duration_min);
      if (b.distance !== undefined) draft.distance = num(b.distance);
      if (b.intensity !== undefined) draft.intensity = String(b.intensity);
    }
    try {
      const entry = await store.create<Entry>("entries", draft as Omit<Entry, "id">);
      return ok(c, { entry });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });
}
```

- [ ] **Step 4: Mount `registerPlan` in `core/src/api/index.ts`**

Add the import beside the other domain imports (after `import { registerAdmin } from "./admin";`):

```typescript
import { registerPlan } from "./plan";
```

Add the mount inside `buildApi`, after the `registerAccount` / `registerAdmin` lines (order doesn't matter — paths are disjoint):

```typescript
  void registerPlan(app, deps); // /api/plan/entry (create planned), /api/plan/accept (planned→logged)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — both plan-entry tests green; all prior tests green.

- [ ] **Step 6: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/api/plan.ts core/src/api/index.ts core/test/plan.test.ts
git commit -m "feat(core): POST /api/plan/entry — create a one-off planned entry"
```

---

### Task 5: `POST /api/plan/accept` — flip a planned entry to logged

**Files:**
- Modify: `core/src/api/plan.ts` (add the accept route + a shared `dayTotals` helper)
- Test: `core/test/plan.test.ts` (append accept tests)

**Interfaces:**
- Consumes: `Entry`, the `isLogged` import already in `plan.ts`.
- Produces: route `POST /api/plan/accept` body `{ entry_id, edits? }` → flips `status→"logged"`, applies optional edits (`kcal`, macro keys, `duration_min`, `distance`, `description`, `note`, `logged_at`/`tz_offset_min`), recomputes `day`, returns `{ entry, totals }`. Body `{ schedule_id, scheduled_date }` returns 400 (occurrence accept is phase 2). Reuses the shared `dayIntakeTotals` from `./helpers` (added in Task 3) for the returned totals — no local totals function.

- [ ] **Step 1: Write the failing accept tests (append to `core/test/plan.test.ts`)**

```typescript
test("POST /api/plan/accept flips a planned entry to logged and counts it", async () => {
  const { req } = client();
  const create = await req("/api/plan/entry", {
    method: "POST",
    body: JSON.stringify({ kind: "food", description: "planned lunch", kcal: 600,
      macros: { protein: 40, carbs: 50, fat: 20 }, logged_at: "2026-07-24T12:00:00.000Z", tz_offset_min: 0 }),
  });
  const { entry } = await create.json();

  const acc = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ entry_id: entry.id }) });
  assert.equal(acc.status, 200);
  const body = await acc.json();
  assert.equal(body.entry.status, "logged");
  assert.equal(body.totals.kcal, 600, "accepted entry now counts");

  // A second read of the day confirms it's counted.
  const day = await req("/api/entries?day=2026-07-24&tz=0");
  assert.equal((await day.json()).totals.kcal, 600);
});

test("POST /api/plan/accept applies edits while accepting", async () => {
  const { req } = client();
  const { entry } = await (await req("/api/plan/entry", {
    method: "POST",
    body: JSON.stringify({ kind: "food", description: "big meal", kcal: 900,
      macros: { protein: 20, carbs: 20, fat: 20 }, logged_at: "2026-07-24T12:00:00.000Z", tz_offset_min: 0 }),
  })).json();
  const acc = await req("/api/plan/accept", {
    method: "POST",
    body: JSON.stringify({ entry_id: entry.id, edits: { kcal: 450, protein: 10 } }),
  });
  const body = await acc.json();
  assert.equal(body.entry.kcal, 450);
  assert.equal(body.totals.kcal, 450);
});

test("POST /api/plan/accept is idempotent (accepting a logged entry is a no-op)", async () => {
  const { req } = client();
  const { entry } = await (await req("/api/plan/entry", {
    method: "POST",
    body: JSON.stringify({ kind: "food", description: "snack", kcal: 100, logged_at: "2026-07-24T12:00:00.000Z", tz_offset_min: 0 }),
  })).json();
  await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ entry_id: entry.id }) });
  const again = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ entry_id: entry.id }) });
  assert.equal(again.status, 200);
  const body = await again.json();
  assert.equal(body.entry.status, "logged");
  assert.equal(body.totals.kcal, 100, "no double-count on re-accept");
});

test("POST /api/plan/accept 404s an unknown entry", async () => {
  const { req } = client();
  const res = await req("/api/plan/accept", { method: "POST", body: JSON.stringify({ entry_id: "nope" }) });
  assert.equal(res.status, 404);
});

test("POST /api/plan/accept 400s the occurrence branch (phase 2)", async () => {
  const { req } = client();
  const res = await req("/api/plan/accept", {
    method: "POST",
    body: JSON.stringify({ schedule_id: "s1", scheduled_date: "2026-07-24" }),
  });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: FAIL — `POST /api/plan/accept` 404 (route not mounted).

- [ ] **Step 3: Add the accept route to `core/src/api/plan.ts` (reusing the shared totals helper)**

Add `dayIntakeTotals` to the existing `./helpers` import at the top of `plan.ts` (created in Task 4):

```typescript
import {
  getUid, getEmail, ok, err, dayKey, ensureProfile, dayIntakeTotals,
  type App, type RouteDeps,
} from "./helpers";
```

(No local totals function — the accept route calls the shared `dayIntakeTotals`, which enforces the honesty rule internally.)

Add the accept route inside `registerPlan`, after the `/api/plan/entry` handler:

```typescript
  // ---- POST /api/plan/accept — manual confirm: flip a planned entry to logged (+ optional edits).
  // Body: { entry_id, edits? }. The occurrence branch ({ schedule_id, scheduled_date }) is phase 2.
  app.post("/api/plan/accept", async (c) => {
    const uid = getUid(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const store = platform.data.forUser(uid);

    if (!b.entry_id && b.schedule_id) {
      return err(c, "accepting a recurring occurrence is not supported yet (phase 2)", 400);
    }
    const id = String(b.entry_id || "");
    if (!id) return err(c, "entry_id is required", 400);
    const rec = await store.get<Entry>("entries", id);
    if (!rec) return err(c, "not found", 404);
    if (rec.user !== uid) return err(c, "forbidden", 403);

    const edits = (b.edits && typeof b.edits === "object" ? b.edits : {}) as Record<string, any>;
    const activity = rec.kind === "activity";
    const patch: Record<string, any> = { status: "logged" };

    // Optional edits applied at accept time (portion tweaks, corrected numbers, moved time).
    if (edits.kcal !== undefined) patch.kcal = num(edits.kcal);
    if (!activity) {
      const macros: Macros = { protein: 0, carbs: 0, fat: 0, ...(rec.macros || {}) };
      let touched = false;
      for (const k of ["protein", "carbs", "fat", "fiber", "sugar", "sodium", "sat_fat"] as const) {
        if (edits[k] !== undefined) { (macros as any)[k] = num(edits[k]); touched = true; }
      }
      if (touched) patch.macros = macros;
    } else {
      if (edits.duration_min !== undefined) patch.duration_min = num(edits.duration_min);
      if (edits.distance !== undefined) patch.distance = num(edits.distance);
    }
    if (edits.description !== undefined) patch.description = String(edits.description).slice(0, 2000);
    if (edits.note !== undefined) patch.note = String(edits.note).slice(0, 2000);

    // Accepting defaults logged_at to the planned time (already on the record); an edit can move it,
    // which re-buckets the day (same tz-aware rule as logging).
    if (edits.logged_at !== undefined) {
      const ts = new Date(String(edits.logged_at));
      if (!isNaN(ts.getTime())) {
        const tz = edits.tz_offset_min !== undefined ? num(edits.tz_offset_min) : num(rec.tz_offset_min);
        patch.logged_at = ts.toISOString();
        patch.tz_offset_min = tz;
        patch.day = dayKey(patch.logged_at, tz);
      }
    }

    try {
      const entry = await store.update<Entry>("entries", id, patch as Partial<Entry>);
      const day = entry.day || dayKey(entry.logged_at, num(entry.tz_offset_min));
      return ok(c, { entry, totals: await dayIntakeTotals(store, day) });
    } catch (e) {
      return err(c, msgOf(e), 502);
    }
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — all accept tests green (flip counts, edits apply, idempotent no double-count, 404, 400); all prior tests green.

- [ ] **Step 5: Typecheck**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/gitrepos/sate
git add core/src/api/plan.ts core/test/plan.test.ts
git commit -m "feat(core): POST /api/plan/accept — manual confirm planned→logged (+edits, idempotent)"
```

---

### Task 6: Full-suite green + typecheck gate + sync to sate-cloud

The final gate: whole test suite green, core typecheck clean, and the `core/` change reflected into the sate-cloud subtree (Cloud is where this deploys). No new behavior — this task verifies and syncs.

**Files:**
- None new. Verification + subtree sync.

- [ ] **Step 1: Run the whole suite**

Run: `cd ~/gitrepos/sate/core && npm test`
Expected: PASS — harness + schema + honesty + plan (entry + accept) all green; `ℹ fail 0`.

- [ ] **Step 2: Typecheck core via sate-cloud**

Run: `cd ~/gitrepos/sate-cloud && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Confirm the git state is clean and the phase-1 commits are present**

Run: `cd ~/gitrepos/sate && git log --oneline -6 && git status --porcelain`
Expected: the six task commits present; no uncommitted changes.

- [ ] **Step 4: Sync `core/` into sate-cloud (subtree)**

Per `sate-core-unification` memory, sate-cloud vendors `core/` as a subtree and MUST stay byte-identical. The repo's `scripts/dist-core.sh` is the sync tool — **run it with `bash`, not `sh`** (it uses `set -o pipefail`), and be ready for benign `git subtree pull` add/add conflicts (resolve with `git checkout --theirs` only after confirming the two sides are identical). Coordinate the exact sync/verify step with the user before pushing sate-cloud — this plan's scope is core-side; the sate-cloud PR/deploy is a follow-up.

Run (verify byte-identical after sync): `diff -rq ~/gitrepos/sate/core/src ~/gitrepos/sate-cloud/core/src`
Expected: no differences once synced.

- [ ] **Step 5: Live smoke test on sate.health (after sate-cloud deploy)**

Using the established Firebase-custom-token harness (as used for the edit-entry work), against the `god` account, on the deployed Cloud revision: `POST /api/plan/entry` a planned meal → `GET /api/me` totals unchanged → `POST /api/plan/accept` → totals reflect it → delete the entry to clean up. Document the result. (This step runs only after the sate-cloud deploy in the follow-up; note it here so Phase 1 isn't marked "done" until verified live.)

---

## Self-Review

**Spec coverage (Phase 1 scope = spec §13.1: `entries.status`, accept endpoint, totals/stats exclusion — §2.1, §3, §5):**
- §2.1 `entries.status` + `plan_schedule_id` + `scheduled_date` → Task 2. ✓
- §3 honesty rule (`dayTotals`, `statsRange`, day/feed, me totals) → Task 3 (entries `dayTotals`, profile `/api/me` + `/api/stats`, coach reads). ✓ Note: `/api/feed` read-filtering is deferred to Phase 3 (the timeline replaces `/api/feed`); Phase 1 covers every **totaling** surface, which is the honesty spine. Called out, not silently dropped.
- §5 accept flow — one-off `{entry_id}` branch (flip, edits, recompute day, return totals, idempotent) → Task 5. ✓ The `{schedule_id, scheduled_date}` occurrence branch is explicitly deferred to Phase 2 (needs schedules) and returns 400 in the meantime. ✓
- Create-planned primitive (`POST /api/plan/entry`) → Task 4. Not a numbered spec section, but §2.1 defines a one-off planned meal as `entry{status:"planned"}` and §5 requires one to accept; a minimal create endpoint makes Phase 1 an independently verifiable vertical slice (spec §13: "each phase ships working and is independently verifiable"). Flagged as an author decision.
- §12 testing (honesty regression, accept idempotency) → Tasks 3 & 5 tests. Projector/override/this-vs-all/recipe/coach tests belong to Phases 2/5/6. ✓

**Placeholder scan:** No TBD/TODO-in-code/"add error handling"/"similar to Task N". Every code step shows complete code; every test step shows the assertions; every run step gives the exact command + expected result. ✓

**DRY:** The by-day intake summation exists in exactly ONE place — `dayIntakeTotals` in `helpers.ts` — reused by `entries.ts` (via `const dayTotals = dayIntakeTotals`) and `plan.ts`. No copied summation loop. `profile.ts`/`coach.ts` sum lists they already hold in memory (a different access pattern, `.filter(isLogged)` on an in-hand array), so they are not duplication.

**Type consistency:** `isLogged` and `dayIntakeTotals` signatures identical everywhere imported (Tasks 3, 4, 5). `registerPlan(app, deps)` matches the `register<Name>` convention and the `void registerPlan(app, deps)` mount. `dayIntakeTotals` return shape (`{kcal…count}`) matches the old `dayTotals` return so `entries.ts` call sites are unchanged. Entry field names (`status`, `plan_schedule_id`, `scheduled_date`, `macros`, `kcal`, `day`, `logged_at`, `tz_offset_min`) match the schema in Task 2 and the existing `Entry` type. Edit keys in accept (`kcal`, macro keys, `duration_min`, `distance`, `description`, `note`, `logged_at`, `tz_offset_min`) match the `PATCH /api/entries/:id` vocabulary. ✓
