# @sate/core

The **platform-agnostic heart of Sate**, shared byte-for-byte between the two deployments:

- **`sate`** (public / open-source) — **canonical home of `core/`**. Also ships the **Hosted**
  (self-hosted) PocketBase edition, which consumes only `src/shared/` (copied to `pb_hooks/shared/` at build).
- **`sate-cloud`** (private) — the **Cloud** edition: Firestore + Firebase-Auth adapters, Cloud Run.
  Runs the full core.

**Edit core here, in the public repo.** Then re-split and push it, and pull it there:

```bash
bash scripts/dist-core.sh                                   # in sate: split core/ → core-dist, push
git subtree pull --prefix=core core-src core-dist --squash  # in sate-cloud
diff -rq core/src ../sate/core/src                          # MUST be empty before deploying
```

`diff` being empty is the gate — a stale vendored subtree has silently masked a real bug before,
by typechecking old code while new code shipped.

## The rule
**Core depends only on interfaces (`ports/`), never on a platform SDK.** No `firebase-admin`, no
Firestore client, no SQLite, no PocketBase — ever. Each platform supplies concrete **adapters** that
implement the ports; core is handed a `Platform` bundle at startup and runs anywhere.

```
src/
  domain/       pure business logic — nutrition engine, recurrence projector (no I/O)
  ai/           provider adapters (Claude/OpenAI/Gemini/OpenRouter REST), routing, usage limits
  schema/       zod schemas + inferred types — Entry, Food, Measurement, WeightGoal, Profile, plans
  ports/        the interfaces: DataStore, Auth, FileStorage, Secrets  (+ the Platform bundle)
  api/          Hono route handlers — entries, foods, weight, coach, plan, recipes, admin, account
  web/          the SPA — app shell, lib.js kit, views/*  (framework-free ES modules),
                privacy.html, and vendor/ (self-hosted third-party libs — html5-qrcode; served
                from our own origin rather than a CDN, so no third party can inject script into
                a page holding the user's session)
  kb/           food + activity knowledge-base retrieval
  entitlements/ feature gating against the shared entitlements plane
  shared/       ⚠ plain CommonJS, consumed by BOTH editions — nutrition math, the AI prompt
                registry, barcode normalization. PocketBase's goja runtime requires these
                directly, so they must stay dependency-free CJS.
test/           node:test suites, bundled through esbuild by `npm test`
```

**⚠ `src/shared/` has its own `package.json` pinning `{"type":"commonjs"}`.** `core/package.json`
declares `"type": "module"`, so without that scoping file Node and esbuild read these as ESM and
`module.exports` breaks. PocketBase's goja ignores package.json entirely and was never affected —
so the failure appears only on the Cloud side. Any new shared CJS belongs under that directory.

## Ports (the contract)
| Port | Cloud adapter (`sate-cloud`) |
|------|------------------------------|
| `DataStore` (get/list/**watch**/create/update/delete/batch, `forUser` + `instance`) | Firestore |
| `Auth` (verify token → user) | Firebase `verifyIdToken` (modular `firebase-admin/auth`) |
| `FileStorage` | GCS — **wired but currently unused**: nothing calls `platform.files` |
| `Secrets` | Secret Manager |

### ⚠ `list()` pagination is part of the contract, not an optimisation

`QuerySpec.cursor` and `Page.nextCursor` are **load-bearing**. Callers page like this, and an adapter
that ignores them does not fail — it silently returns a truncated answer:

```ts
let cursor; const out = [];
for (;;) {
  const page = await store.list("entries", { where, orderBy, limit: 500, cursor });
  out.push(...page.items);
  if (!page.nextCursor || !page.items.length) break;
  cursor = page.nextCursor;
}
```

An adapter **must** return `nextCursor` whenever a page comes back full, and honour an incoming
`cursor`. The Firestore adapter did neither until 2026-08-01, so `GET /api/stats` quietly aggregated
at most the oldest 500 rows of any month/year window — no error, just wrong totals. The in-memory
test fake had the *same* gap, which is exactly why no test caught it: **a fake more permissive than
the port it stands in for cannot catch a port violation.** `core/test/pagination.test.ts` now pins
both halves of the contract.

> **There is no second full adapter set today.** A SQLite/local-auth adapter (`sate/server/`) was
> built and proven in July 2026, then **deleted** — the Hosted edition deliberately keeps its
> PocketBase implementation rather than re-platforming onto core. Recover it from history if that
> direction ever revives. The two editions therefore share `src/shared/`, not the whole core.

## Status
Live. Core carries the full API surface (diary, foods, weight, coach, admin, account +
export/deletion, entitlements), the AI layer, the SPA, and the Planner (planned-vs-logged entries,
recurrence schedules, timeline, recipes, coach-driven plan edits). Test suite runs with `npm test`.

**Cloud-only surfaces.** The Planner and account export/deletion are registered in core but are
reached only by the Cloud edition — Hosted serves its own `pb_public` SPA and its own `pb_hooks`
routes. Additions to `src/shared/` must stay goja-safe so the PocketBase build keeps compiling.

`domain/nutrition.ts` is still the original PocketBase engine, now re-exported from
`shared/nutrition.js` so both editions compute byte-identical numbers.
