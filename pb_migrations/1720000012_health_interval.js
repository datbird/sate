/// <reference path="../pb_data/types.d.ts" />

// Sate — throttled Apple Health auto-sync-on-open.
//
// The iOS app already pulls workouts once per launch when Health is connected. This adds a
// per-user throttle so it only re-pulls if enough time has passed since the last sync:
//   - `profiles.health_sync_interval` — minutes between auto-syncs on app open. "0" = every
//     launch (old behaviour); unset reads back as the daily default (see healthSyncIntervalOf).
//   - `profiles.health_synced_at` — ISO timestamp of the last completed sync; the client
//     compares it against the interval at launch to decide whether to pull.
// Both are additive text fields; existing profiles read back empty and behave as the default.
// Nothing here runs in the background — the decision is made client-side only when the app opens.

migrate(
  (app) => {
    const profiles = app.findCollectionByNameOrId("profiles");
    if (!profiles.fields.getByName("health_sync_interval")) profiles.fields.add(new Field({ type: "text", name: "health_sync_interval" }));
    if (!profiles.fields.getByName("health_synced_at")) profiles.fields.add(new Field({ type: "text", name: "health_synced_at" }));
    app.save(profiles);
  },
  (app) => {
    try {
      const profiles = app.findCollectionByNameOrId("profiles");
      profiles.fields.removeByName("health_sync_interval");
      profiles.fields.removeByName("health_synced_at");
      app.save(profiles);
    } catch (_) {}
  }
);
