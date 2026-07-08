/// <reference path="../pb_data/types.d.ts" />

// Sate — web-lookup feature: a curated suite of trusted nutrition source URLs, a fifth
// AI function ("web_lookup") that searches the web grounded on those sources, and a "web"
// value for the entry source select (entries corrected via a web search).

migrate(
  (app) => {
    // --- sources: curated suite of trusted nutrition reference sites ---
    const sources = new Collection({
      type: "base",
      name: "sources",
      fields: [
        { type: "text", name: "title", required: true, max: 200 },
        { type: "text", name: "url", required: true, max: 500 },
        { type: "text", name: "domain", max: 200 },
        { type: "text", name: "notes", max: 500 },
        { type: "bool", name: "enabled" },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_sources_url ON sources (url)"],
    });
    app.save(sources);

    // A solid default suite of reputable, data-backed nutrition references.
    const seed = [
      ["USDA FoodData Central", "https://fdc.nal.usda.gov", "Official US government food composition database"],
      ["Nutritionix", "https://www.nutritionix.com", "Large branded + restaurant food database"],
      ["MyFoodData", "https://www.myfooddata.com", "USDA-derived, easy per-serving breakdowns"],
      ["NutritionValue.org", "https://www.nutritionvalue.org", "USDA-based nutrition facts"],
      ["Open Food Facts", "https://world.openfoodfacts.org", "Open, crowd-sourced packaged-food database with barcodes"],
      ["Self NutritionData", "https://nutritiondata.self.com", "Detailed nutrient profiles"],
      ["FatSecret", "https://www.fatsecret.com", "Branded + generic foods and restaurants"],
      ["CalorieKing", "https://www.calorieking.com", "US restaurant and packaged foods"],
      ["Eat This Much", "https://www.eatthismuch.com", "Recipe and meal nutrition"],
      ["Verywell Fit", "https://www.verywellfit.com", "Dietitian-reviewed nutrition articles"],
    ];
    for (const [title, url, notes] of seed) {
      const r = new Record(sources);
      r.set("title", title);
      r.set("url", url);
      r.set("domain", url.replace(/^https?:\/\//, "").split("/")[0]);
      r.set("notes", notes);
      r.set("enabled", true);
      app.save(r);
    }

    // --- fifth AI function: web_lookup (defaults to the app's Claude baseline) ---
    const fnConfig = app.findCollectionByNameOrId("function_config");
    let exists = null;
    try { exists = app.findFirstRecordByFilter("function_config", "fn = 'web_lookup'"); } catch (_) {}
    if (!exists) {
      const r = new Record(fnConfig);
      r.set("fn", "web_lookup");
      r.set("provider", "anthropic");
      r.set("model", "claude-sonnet-5");
      r.set("enabled", true);
      app.save(r);
    }

    // --- allow "web" as an entry source (entries refined via web search) ---
    const entries = app.findCollectionByNameOrId("entries");
    const field = entries.fields.getByName("source");
    if (field && field.values.indexOf("web") === -1) {
      field.values = ["photo", "text", "manual", "web"];
      app.save(entries);
    }
  },
  (app) => {
    try {
      const entries = app.findCollectionByNameOrId("entries");
      const field = entries.fields.getByName("source");
      if (field) { field.values = ["photo", "text", "manual"]; app.save(entries); }
    } catch (_) {}
    try {
      const r = app.findFirstRecordByFilter("function_config", "fn = 'web_lookup'");
      if (r) app.delete(r);
    } catch (_) {}
    try {
      app.delete(app.findCollectionByNameOrId("sources"));
    } catch (_) {}
  }
);
