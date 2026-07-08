/// <reference path="../pb_data/types.d.ts" />

// Sate — per-user AI model overrides.
//
// Each user may override the global per-function AI defaults in two categories:
//   ov_ai_*     → "normal AI" (text_parse, chat, daily_summary, web_lookup)
//   ov_vision_* → "image interpretation" (vision_estimate)
// Empty = fall back to the global default. Admin-managed from the Users & Admins section.

const OV = ["ov_ai_provider", "ov_ai_model", "ov_vision_provider", "ov_vision_model"];

migrate(
  (app) => {
    const profiles = app.findCollectionByNameOrId("profiles");
    for (const n of OV) if (!profiles.fields.getByName(n)) profiles.fields.add(new Field({ type: "text", name: n }));
    app.save(profiles);
  },
  (app) => {
    try {
      const profiles = app.findCollectionByNameOrId("profiles");
      for (const n of OV) profiles.fields.removeByName(n);
      app.save(profiles);
    } catch (_) {}
  }
);
