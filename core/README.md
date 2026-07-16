# @sate/core

The **platform-agnostic heart of Sate**, shared byte-for-byte between the two deployments:

- **`sate`** (public / open-source) — self-hostable, SQLite + local-auth adapters, Docker.
- **`sate-cloud`** (private) — the hosted product, Firestore + Firebase-Auth adapters, Cloud Run.

`core/` is vendored into each repo via **git subtree** and kept in exact sync. Do core work in one
place, `git subtree push` it, `git subtree pull` in the other — identical on both sides.

## The rule
**Core depends only on interfaces (`ports/`), never on a platform SDK.** No `firebase-admin`, no
Firestore client, no SQLite, no PocketBase — ever. Each platform supplies concrete **adapters** that
implement the ports; core is handed a `Platform` bundle at startup and runs anywhere.

```
src/
  domain/     pure business logic — nutrition engine, food/activity/goal math (no I/O)
  ai/         prompts, provider adapters (Claude/OpenAI/Gemini REST), routing, usage limits
  schema/     zod schemas + inferred types — Entry, Food, Measurement, WeightGoal, Profile
  ports/      the interfaces: DataStore, Auth, FileStorage, Secrets  (+ the Platform bundle)
  api/        Hono route handlers — call ports, return data (added in a later phase)
  web/        the SPA — views/components/styles; talk to the DataStore port (added later)
  seed/       USDA food seed + activities (added later)
```

## Ports (the contract)
| Port | Cloud adapter | Self-host adapter |
|------|---------------|-------------------|
| `DataStore` (get/list/**watch**/create/update/delete/batch) | Firestore (offline cache + `onSnapshot`) | SQLite (+ poll/SSE for `watch`) |
| `Auth` (verify token → user) | Firebase `verifyIdToken` | local email / header |
| `FileStorage` | GCS | local disk |
| `Secrets` | Secret Manager | env vars |

## Status
Scaffolded 2026-07-15 (Phase 1). Ported so far: the deterministic **nutrition engine**
(`domain/nutrition.ts`) verbatim from the original PocketBase `pb_hooks/nutrition.js`.
