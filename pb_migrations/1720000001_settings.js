/// <reference path="../pb_data/types.d.ts" />

// Instance-level settings (key/value): app name + default goals for new users.
// Additive migration — applies on top of the initial schema, preserving existing data.

migrate(
  (app) => {
    const settings = new Collection({
      type: "base",
      name: "settings",
      fields: [
        { type: "text", name: "key", required: true },
        { type: "text", name: "value", max: 5000 },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_settings_key ON settings (key)"],
    });
    app.save(settings);

    const seed = [
      ["app_name", "Sate"],
      ["default_goal_kcal", "2000"],
      ["default_goal_protein", "150"],
      ["default_goal_carbs", "200"],
      ["default_goal_fat", "65"],
    ];
    for (const [k, v] of seed) {
      const r = new Record(settings);
      r.set("key", k);
      r.set("value", v);
      app.save(r);
    }
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("settings"));
    } catch (_) {}
  }
);
