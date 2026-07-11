/// <reference path="../pb_data/types.d.ts" />

// Sate — proactive coach check-ins. A daily cron analyzes each opted-in user's recent logs with AI
// and, when worthwhile, stores a short check-in message; the app surfaces it (in-app + a local
// notification) and tapping it opens the Coach chat seeded with the message.
//
//   profiles += checkin_enabled (bool), checkin_time ("HH:MM" preferred delivery), checkin_last_at
//               (ISO of the last check-in, for cooldown).
//   checkins   — one row per generated check-in: user_email, topic, message, status
//               (pending | seen | dismissed), notified (bool = a local notification was scheduled).
//   function_config += `checkin` (blank provider/model → inherits the global default, per routing).

migrate(
  (app) => {
    const profiles = app.findCollectionByNameOrId("profiles");
    if (!profiles.fields.getByName("checkin_enabled")) profiles.fields.add(new Field({ type: "bool", name: "checkin_enabled" }));
    if (!profiles.fields.getByName("checkin_time")) profiles.fields.add(new Field({ type: "text", name: "checkin_time" }));
    if (!profiles.fields.getByName("checkin_freq")) profiles.fields.add(new Field({ type: "text", name: "checkin_freq" })); // often | daily | sparse
    if (!profiles.fields.getByName("checkin_last_at")) profiles.fields.add(new Field({ type: "text", name: "checkin_last_at" }));
    app.save(profiles);

    if (!collExists(app, "checkins")) {
      const c = new Collection({
        type: "base",
        name: "checkins",
        fields: [
          { type: "text", name: "user_email", required: true, max: 200 },
          { type: "text", name: "topic", max: 120 },
          { type: "text", name: "message", max: 2000 },
          { type: "text", name: "status", max: 20 }, // pending | seen | dismissed
          { type: "bool", name: "notified" },
          { type: "autodate", name: "created", onCreate: true },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
        indexes: [
          "CREATE INDEX idx_checkins_user ON checkins (user_email, status)",
          "CREATE INDEX idx_checkins_created ON checkins (created)",
        ],
      });
      app.save(c);
    }

    // Route the check-in generator like every other AI function: blank = global default.
    try {
      let exists = null;
      try { exists = app.findFirstRecordByFilter("function_config", "fn = 'checkin'"); } catch (_) {}
      if (!exists) {
        const r = new Record(app.findCollectionByNameOrId("function_config"));
        r.set("fn", "checkin");
        r.set("provider", "");
        r.set("model", "");
        r.set("enabled", true);
        app.save(r);
      }
    } catch (_) {}
  },
  (app) => {
    try {
      const profiles = app.findCollectionByNameOrId("profiles");
      ["checkin_enabled", "checkin_time", "checkin_freq", "checkin_last_at"].forEach((n) => profiles.fields.removeByName(n));
      app.save(profiles);
    } catch (_) {}
    try { app.delete(app.findCollectionByNameOrId("checkins")); } catch (_) {}
    try { app.delete(app.findFirstRecordByFilter("function_config", "fn = 'checkin'")); } catch (_) {}
  }
);

function collExists(app, name) {
  try { app.findCollectionByNameOrId(name); return true; } catch (_) { return false; }
}
