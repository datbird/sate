/// <reference path="../pb_data/types.d.ts" />

// Sate — Apple Health sync plumbing (Pass 2).
//
// `entries.ext_id` holds the HealthKit workout UUID for imported workouts, so a re-sync
// dedupes instead of duplicating (unique per user). `profiles.health_sync` is the per-user
// opt-in ("on" once the user connects Apple Health; unset/"off" = not connected). Health
// workouts reuse the existing `source:"health"` select value (added in 1720000009) and
// carry Apple's Active Energy as the burn — trustworthy, unlike an AI text estimate.
// All additive; existing rows read back with an empty ext_id and are untouched.

migrate(
  (app) => {
    const entries = app.findCollectionByNameOrId("entries");
    if (!entries.fields.getByName("ext_id")) entries.fields.add(new Field({ type: "text", name: "ext_id" }));
    const idx = "CREATE UNIQUE INDEX idx_entries_extid ON entries (user_email, ext_id) WHERE ext_id != ''";
    if (entries.indexes.indexOf(idx) === -1) entries.indexes.push(idx);
    app.save(entries);

    const profiles = app.findCollectionByNameOrId("profiles");
    if (!profiles.fields.getByName("health_sync")) profiles.fields.add(new Field({ type: "text", name: "health_sync" }));
    app.save(profiles);
  },
  (app) => {
    try {
      const entries = app.findCollectionByNameOrId("entries");
      entries.indexes = entries.indexes.filter((s) => s.indexOf("idx_entries_extid") === -1);
      entries.fields.removeByName("ext_id");
      app.save(entries);
    } catch (_) {}
    try {
      const profiles = app.findCollectionByNameOrId("profiles");
      profiles.fields.removeByName("health_sync");
      app.save(profiles);
    } catch (_) {}
  }
);
