/// <reference path="../pb_data/types.d.ts" />

// Sate — tracking modes + extended nutrients.
//
// Adds a per-user `track_mode` (calories | carb | protein | fat | balanced | heart) and a
// sodium goal to profiles, and four extra nutrients (fiber, sugar, sodium, sat_fat) to both
// `entries` (what was logged) and `foods` (so barcode-cached products keep them on re-scan).
// All numeric, all optional — existing rows read back as 0, so old data and the default
// Calories mode are unaffected.

const EXTRA = ["fiber", "sugar", "sodium", "sat_fat"];

migrate(
  (app) => {
    const profiles = app.findCollectionByNameOrId("profiles");
    if (!profiles.fields.getByName("track_mode")) profiles.fields.add(new Field({ type: "text", name: "track_mode" }));
    if (!profiles.fields.getByName("goal_sodium")) profiles.fields.add(new Field({ type: "number", name: "goal_sodium" }));
    app.save(profiles);

    for (const cn of ["entries", "foods"]) {
      const col = app.findCollectionByNameOrId(cn);
      for (const n of EXTRA) if (!col.fields.getByName(n)) col.fields.add(new Field({ type: "number", name: n }));
      app.save(col);
    }
  },
  (app) => {
    try {
      const profiles = app.findCollectionByNameOrId("profiles");
      profiles.fields.removeByName("track_mode");
      profiles.fields.removeByName("goal_sodium");
      app.save(profiles);
    } catch (_) {}
    for (const cn of ["entries", "foods"]) {
      try {
        const col = app.findCollectionByNameOrId(cn);
        for (const n of EXTRA) col.fields.removeByName(n);
        app.save(col);
      } catch (_) {}
    }
  }
);
