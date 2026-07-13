/// <reference path="../pb_data/types.d.ts" />

// Manual entry editing: let a user override an entry's nutrition facts / burn, rename it,
// and attach an optional free-text note — after it's already been logged.
//   - entries gains a "note" text field (optional description shown under the entry).
//   - entries.source gains "manual" (kept from init, re-ensured here) so a hand-edited
//     entry is honestly tagged as user-provided rather than an AI/preset estimate.
migrate(
  (app) => {
    const entries = app.findCollectionByNameOrId("entries");
    if (!entries.fields.getByName("note")) {
      entries.fields.add(new Field({ type: "text", name: "note", max: 2000 }));
    }
    // Sources for hand-edited (manual), database-picked (db), and web-search-accepted (web) entries.
    const src = entries.fields.getByName("source");
    if (src && src.values) {
      for (const v of ["manual", "db", "web"]) if (src.values.indexOf(v) === -1) src.values.push(v);
    }
    app.save(entries);
  },
  (app) => {
    try {
      const entries = app.findCollectionByNameOrId("entries");
      entries.fields.removeByName("note");
      app.save(entries);
    } catch (_) {}
  }
);
