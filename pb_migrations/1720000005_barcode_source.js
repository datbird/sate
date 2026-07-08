/// <reference path="../pb_data/types.d.ts" />

// Allow "barcode" as an entry source (entries logged by scanning a product barcode).

migrate(
  (app) => {
    const entries = app.findCollectionByNameOrId("entries");
    const field = entries.fields.getByName("source");
    if (field && field.values.indexOf("barcode") === -1) {
      field.values = ["photo", "text", "manual", "web", "barcode"];
      app.save(entries);
    }
  },
  (app) => {
    try {
      const entries = app.findCollectionByNameOrId("entries");
      const field = entries.fields.getByName("source");
      if (field) { field.values = ["photo", "text", "manual", "web"]; app.save(entries); }
    } catch (_) {}
  }
);
