/// <reference path="../pb_data/types.d.ts" />

// Sate — "add activity from heart rate".
//
// Lets the user retroactively log unlogged exertion from the heart-rate their watch captured:
// pick a window on the last-24h HR graph, Sate estimates the burn and saves it as a named
// activity that feeds the net-exercise budget like a workout.
//   - entries.source gains "heart_rate" (alongside preset|activity_ai|health|barcode).
//   - profiles gains the body stats the HR→kcal formula (Keytel) needs — read from Apple Health
//     when available, otherwise entered by the user — plus which estimation method to use.
//       body_weight_kg / body_age (number), body_sex (text: "male"|"female"|"" )
//       hr_estimate_method (text: ""/"formula" = default deterministic formula, "ai" = AI)
// All additive + reversible; existing rows/profiles read back empty and behave as the defaults.

migrate(
  (app) => {
    const entries = app.findCollectionByNameOrId("entries");
    const src = entries.fields.getByName("source");
    if (src && src.values.indexOf("heart_rate") === -1) { src.values.push("heart_rate"); app.save(entries); }

    const profiles = app.findCollectionByNameOrId("profiles");
    if (!profiles.fields.getByName("body_weight_kg")) profiles.fields.add(new Field({ type: "number", name: "body_weight_kg" }));
    if (!profiles.fields.getByName("body_age")) profiles.fields.add(new Field({ type: "number", name: "body_age" }));
    if (!profiles.fields.getByName("body_sex")) profiles.fields.add(new Field({ type: "text", name: "body_sex" }));
    if (!profiles.fields.getByName("hr_estimate_method")) profiles.fields.add(new Field({ type: "text", name: "hr_estimate_method" }));
    app.save(profiles);
  },
  (app) => {
    try {
      const entries = app.findCollectionByNameOrId("entries");
      const src = entries.fields.getByName("source");
      if (src) { src.values = src.values.filter((v) => v !== "heart_rate"); app.save(entries); }
    } catch (_) {}
    try {
      const profiles = app.findCollectionByNameOrId("profiles");
      profiles.fields.removeByName("body_weight_kg");
      profiles.fields.removeByName("body_age");
      profiles.fields.removeByName("body_sex");
      profiles.fields.removeByName("hr_estimate_method");
      app.save(profiles);
    } catch (_) {}
  }
);
