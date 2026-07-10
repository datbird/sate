/// <reference path="../pb_data/types.d.ts" />

// Sate — "add exercise calories to my budget" per-user setting.
//
// When on (the default), a workout's burn raises that day's calorie budget, the way most
// trackers do it. Stored as text on profiles: "off" = strict (burn is context only); anything
// else, including unset on existing profiles, is treated as on. Additive + reversible.

migrate(
  (app) => {
    const profiles = app.findCollectionByNameOrId("profiles");
    if (!profiles.fields.getByName("net_exercise")) profiles.fields.add(new Field({ type: "text", name: "net_exercise" }));
    app.save(profiles);
  },
  (app) => {
    try {
      const profiles = app.findCollectionByNameOrId("profiles");
      profiles.fields.removeByName("net_exercise");
      app.save(profiles);
    } catch (_) {}
  }
);
