/// <reference path="../pb_data/types.d.ts" />

// Sate — AI routing overhaul: global defaults + a parallel "second opinion" layer + per-user
// per-function overrides. Adds the storage; the resolution hierarchy lives in api.js resolveFor.
//
//   settings (key/value): global defaults per category+role —
//     default_ai_*/default_vision_* (primary), second_ai_*/second_vision_* (second opinion).
//   function_config += second_provider/second_model. Its primary provider/model may now be
//     BLANK (= inherit the category global default) — this migration blanks the existing rows so
//     every task runs the global default, per the user's request ("set default to 2.5-flash, all
//     tasks run the global default").
//   profiles += ov_*_second_* (per-user global second-opinion overrides) + fn_overrides (json:
//     { "<fn>": { p, m, sp, sm } } per-user per-function primary/second overrides).

migrate(
  (app) => {
    const fc = app.findCollectionByNameOrId("function_config");
    if (!fc.fields.getByName("second_provider")) fc.fields.add(new Field({ type: "text", name: "second_provider" }));
    if (!fc.fields.getByName("second_model")) fc.fields.add(new Field({ type: "text", name: "second_model" }));
    app.save(fc);

    const pr = app.findCollectionByNameOrId("profiles");
    for (const n of ["ov_ai_second_provider", "ov_ai_second_model", "ov_vision_second_provider", "ov_vision_second_model"]) {
      if (!pr.fields.getByName(n)) pr.fields.add(new Field({ type: "text", name: n }));
    }
    if (!pr.fields.getByName("fn_overrides")) pr.fields.add(new Field({ type: "json", name: "fn_overrides", maxSize: 20000 }));
    app.save(pr);

    // Seed the global defaults (idempotent — never clobber an admin's existing value).
    const settings = app.findCollectionByNameOrId("settings");
    const seed = {
      default_ai_provider: "google", default_ai_model: "gemini-2.5-flash",
      default_vision_provider: "google", default_vision_model: "gemini-2.5-flash",
      second_ai_provider: "google", second_ai_model: "gemini-2.5-pro",
      second_vision_provider: "google", second_vision_model: "gemini-2.5-pro",
    };
    for (const k in seed) {
      let exists = null;
      try { exists = app.findFirstRecordByFilter("settings", "key = {:k}", { k: k }); } catch (_) {}
      if (!exists) { const r = new Record(settings); r.set("key", k); r.set("value", seed[k]); app.save(r); }
    }

    // Blank per-function provider/model so every task inherits the global default.
    try {
      for (const r of app.findAllRecords("function_config")) { r.set("provider", ""); r.set("model", ""); app.save(r); }
    } catch (_) {}
  },
  (app) => {
    try {
      const fc = app.findCollectionByNameOrId("function_config");
      fc.fields.removeByName("second_provider"); fc.fields.removeByName("second_model");
      app.save(fc);
    } catch (_) {}
    try {
      const pr = app.findCollectionByNameOrId("profiles");
      ["ov_ai_second_provider", "ov_ai_second_model", "ov_vision_second_provider", "ov_vision_second_model", "fn_overrides"].forEach((n) => pr.fields.removeByName(n));
      app.save(pr);
    } catch (_) {}
  }
);
