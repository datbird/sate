/// <reference path="../pb_data/types.d.ts" />

// Sate — weight/height tracking over time + date-based weight goals.
//
//   measurements  — a dated weight (and optional height) series per user. source manual|health;
//                   ext_id = HealthKit sample UUID so a re-sync dedupes (mirrors entries.ext_id).
//   weight_goals  — "be X kg by this date" targets (backend caps 3 active/user); start_kg/date
//                   snapshot the starting point so pace can be computed.
//   profiles.weight_source     — ""=ask on first run | "health" | "manual"
//   profiles.height_cm         — current height (BMI/convenience)
//   profiles.weight_synced_at  — last Health weight sync (launch-throttle stamp)
// All additive. body_weight_kg (from the HR feature) stays the "current weight" scalar and is
// updated whenever a newer measurement lands.

migrate(
  (app) => {
    if (!collExists(app, "measurements")) {
      const c = new Collection({
        type: "base",
        name: "measurements",
        fields: [
          { type: "text", name: "user_email", required: true, max: 255 },
          { type: "text", name: "measured_at", required: true, max: 40 }, // ISO
          { type: "number", name: "weight_kg" },
          { type: "number", name: "height_cm" },
          { type: "text", name: "source", max: 20 }, // manual | health
          { type: "text", name: "ext_id", max: 100 },
          { type: "autodate", name: "created", onCreate: true },
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_meas_extid ON measurements (user_email, ext_id) WHERE ext_id != ''",
          "CREATE INDEX idx_meas_user_at ON measurements (user_email, measured_at)",
        ],
      });
      app.save(c);
    }

    if (!collExists(app, "weight_goals")) {
      const c = new Collection({
        type: "base",
        name: "weight_goals",
        fields: [
          { type: "text", name: "user_email", required: true, max: 255 },
          { type: "number", name: "target_kg", required: true },
          { type: "text", name: "target_date", required: true, max: 10 }, // YYYY-MM-DD
          { type: "number", name: "start_kg" },
          { type: "text", name: "start_date", max: 10 },
          { type: "text", name: "achieved_at", max: 40 },
          { type: "autodate", name: "created", onCreate: true },
        ],
        indexes: ["CREATE INDEX idx_wgoal_user ON weight_goals (user_email)"],
      });
      app.save(c);
    }

    const profiles = app.findCollectionByNameOrId("profiles");
    if (!profiles.fields.getByName("weight_source")) profiles.fields.add(new Field({ type: "text", name: "weight_source" }));
    if (!profiles.fields.getByName("height_cm")) profiles.fields.add(new Field({ type: "number", name: "height_cm" }));
    if (!profiles.fields.getByName("weight_synced_at")) profiles.fields.add(new Field({ type: "text", name: "weight_synced_at" }));
    if (!profiles.fields.getByName("activity_level")) profiles.fields.add(new Field({ type: "text", name: "activity_level" }));
    if (!profiles.fields.getByName("onboarded")) profiles.fields.add(new Field({ type: "text", name: "onboarded" }));
    app.save(profiles);

    // The nutritionist coach is a 7th routable AI function — route it to the funded Google key
    // like the rest so it works out of the box; admins can re-point it in Admin › AI › Functions.
    try {
      const fnConfig = app.findCollectionByNameOrId("function_config");
      let exists = null;
      try { exists = app.findFirstRecordByFilter("function_config", "fn = 'nutritionist'"); } catch (_) {}
      if (!exists) {
        const r = new Record(fnConfig);
        r.set("fn", "nutritionist");
        r.set("provider", "google");
        r.set("model", "gemini-2.5-flash");
        r.set("enabled", true);
        app.save(r);
      }
    } catch (_) {}
  },
  (app) => {
    for (const name of ["measurements", "weight_goals"]) {
      try { app.delete(app.findCollectionByNameOrId(name)); } catch (_) {}
    }
    try {
      const profiles = app.findCollectionByNameOrId("profiles");
      profiles.fields.removeByName("weight_source");
      profiles.fields.removeByName("height_cm");
      profiles.fields.removeByName("weight_synced_at");
      profiles.fields.removeByName("activity_level");
      profiles.fields.removeByName("onboarded");
      app.save(profiles);
    } catch (_) {}
    try { app.delete(app.findFirstRecordByFilter("function_config", "fn = 'nutritionist'")); } catch (_) {}
  }
);

function collExists(app, name) {
  try { app.findCollectionByNameOrId(name); return true; } catch (_) { return false; }
}
