/// <reference path="../pb_data/types.d.ts" />

// Sate — activity / exercise logging.
//
// Turns the food log into a unified log: an `entries.kind` distinguishes food from activity
// (existing rows have no kind and are treated as food everywhere). Activity entries reuse `kcal`
// as the *burn* magnitude and add duration/distance/intensity. A seeded `activities` table mirrors
// `foods` (autocomplete + AI grounding), and a sixth AI function `activity_estimate` estimates burn
// from a free-text description. Additive + reversible.

function normKey(name) {
  const n = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return n(name) + "|";
}

// [name, category, met, aliasesCSV] — MET (metabolic equivalent); kcal/min is derived in the hook
// from MET and a default body mass, so no per-user weight is needed for a first estimate.
const ACT = [
  ["Walking", "cardio", 3.0, "walk,stroll"],
  ["Walking (brisk)", "cardio", 4.3, "brisk walk,power walk,fast walk"],
  ["Running", "cardio", 9.0, "run,jog,jogging"],
  ["Running (10 min/mi)", "cardio", 9.8, "run 6mph,6 mph run"],
  ["Running (8 min/mi)", "cardio", 11.8, "run 7.5mph,fast run"],
  ["Treadmill", "cardio", 8.0, "treadmill run"],
  ["Cycling (leisure)", "cardio", 4.0, "bike,biking,cycling easy"],
  ["Cycling (moderate)", "cardio", 8.0, "bike ride,road cycling"],
  ["Cycling (vigorous)", "cardio", 10.0, "fast cycling,hard bike"],
  ["Stationary bike", "cardio", 7.0, "spin,exercise bike"],
  ["Spin class", "cardio", 8.5, "spinning,indoor cycling"],
  ["Elliptical", "cardio", 5.0, "elliptical trainer,cross trainer"],
  ["Rowing machine", "cardio", 7.0, "rowing,erg,row"],
  ["Stair climber", "cardio", 9.0, "stairmaster,stairs,stair machine"],
  ["Jump rope", "cardio", 12.3, "skipping,jumprope"],
  ["Swimming", "water", 6.0, "swim,laps,pool"],
  ["Swimming (vigorous)", "water", 9.8, "fast swim,swim laps hard"],
  ["Paddleboarding", "water", 6.0, "sup,paddle board"],
  ["Surfing", "water", 3.0, "surf"],
  ["Weightlifting", "strength", 3.5, "weights,lifting,lift,resistance training"],
  ["Weightlifting (vigorous)", "strength", 6.0, "heavy lifting,powerlifting"],
  ["Bodyweight workout", "strength", 8.0, "calisthenics,pushups,pullups"],
  ["CrossFit", "strength", 8.0, "wod,cross fit"],
  ["HIIT", "cardio", 8.0, "high intensity,interval training,tabata"],
  ["Yoga", "flexibility", 2.5, "vinyasa,hatha"],
  ["Pilates", "flexibility", 3.0, "reformer"],
  ["Stretching", "flexibility", 2.3, "mobility,stretch"],
  ["Hiking", "cardio", 6.0, "hike,trail,trekking"],
  ["Rock climbing", "strength", 8.0, "climbing,bouldering"],
  ["Basketball", "sport", 6.5, "hoops,shooting hoops"],
  ["Soccer", "sport", 7.0, "football,futbol"],
  ["Tennis", "sport", 7.3, "singles tennis"],
  ["Pickleball", "sport", 4.5, "pickle ball"],
  ["Golf (walking)", "sport", 4.8, "golf"],
  ["Boxing", "cardio", 6.0, "heavy bag,boxing bag"],
  ["Kickboxing", "cardio", 7.5, "muay thai,martial arts"],
  ["Dancing", "cardio", 5.0, "dance,zumba"],
  ["Skiing (downhill)", "winter", 6.0, "ski,downhill skiing"],
  ["Snowboarding", "winter", 5.3, "snowboard"],
  ["Gardening", "daily", 3.8, "yard work,mowing,weeding"],
  ["House cleaning", "daily", 3.3, "cleaning,chores,vacuuming"],
];

migrate(
  (app) => {
    // --- extend entries: a unified food/activity log ---
    const entries = app.findCollectionByNameOrId("entries");
    if (!entries.fields.getByName("kind")) entries.fields.add(new Field({ type: "text", name: "kind" }));           // "" / "food" | "activity"
    if (!entries.fields.getByName("duration_min")) entries.fields.add(new Field({ type: "number", name: "duration_min" }));
    if (!entries.fields.getByName("distance")) entries.fields.add(new Field({ type: "number", name: "distance" }));  // miles, optional
    if (!entries.fields.getByName("intensity")) entries.fields.add(new Field({ type: "text", name: "intensity" }));
    const src = entries.fields.getByName("source");
    if (src) {
      for (const v of ["preset", "activity_ai", "health"]) if (src.values.indexOf(v) === -1) src.values.push(v);
    }
    app.save(entries);

    // --- activities seed table (mirrors foods) ---
    const activities = new Collection({
      type: "base",
      name: "activities",
      fields: [
        { type: "text", name: "name", required: true, max: 120 },
        { type: "text", name: "category", max: 40 },
        { type: "number", name: "met" },                 // metabolic equivalent; kcal/min derived in hook
        { type: "json", name: "aliases", maxSize: 2000 },
        { type: "text", name: "source" },                // seed | ai
        { type: "bool", name: "verified" },
        { type: "number", name: "usage_count" },
        { type: "text", name: "search", max: 400 },      // lowercased name+aliases
        { type: "text", name: "norm_key", required: true, max: 200 },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_activities_norm ON activities (norm_key)",
        "CREATE INDEX idx_activities_search ON activities (search)",
      ],
    });
    app.save(activities);

    for (const [name, category, met, aliasesCsv] of ACT) {
      const aliases = String(aliasesCsv || "").split(",").map((s) => s.trim()).filter((s) => s.length);
      const r = new Record(activities);
      r.set("name", name);
      r.set("category", category);
      r.set("met", met);
      r.set("aliases", aliases);
      r.set("source", "seed");
      r.set("verified", true);
      r.set("usage_count", 0);
      r.set("search", (name + " " + aliases.join(" ")).toLowerCase());
      r.set("norm_key", normKey(name));
      app.save(r);
    }

    // --- sixth AI function: activity_estimate (routed to the funded Gemini key like the rest) ---
    const fnConfig = app.findCollectionByNameOrId("function_config");
    let exists = null;
    try { exists = app.findFirstRecordByFilter("function_config", "fn = 'activity_estimate'"); } catch (_) {}
    if (!exists) {
      const r = new Record(fnConfig);
      r.set("fn", "activity_estimate");
      r.set("provider", "google");
      r.set("model", "gemini-2.5-flash");
      r.set("enabled", true);
      app.save(r);
    }
  },
  (app) => {
    try {
      const entries = app.findCollectionByNameOrId("entries");
      for (const n of ["kind", "duration_min", "distance", "intensity"]) entries.fields.removeByName(n);
      const src = entries.fields.getByName("source");
      if (src) src.values = src.values.filter((v) => ["preset", "activity_ai", "health"].indexOf(v) === -1);
      app.save(entries);
    } catch (_) {}
    try { app.delete(app.findFirstRecordByFilter("function_config", "fn = 'activity_estimate'")); } catch (_) {}
    try { app.delete(app.findCollectionByNameOrId("activities")); } catch (_) {}
  }
);
