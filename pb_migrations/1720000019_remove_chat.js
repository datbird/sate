/// <reference path="../pb_data/types.d.ts" />

// Sate — remove the dead `chat` AI function. Its route was never wired to the UI (the Coach tab uses
// `nutritionist`), so drop its function_config row (and any prompt override) from existing instances
// so it stops appearing in the admin AI Functions / Prompts / routing lists.

migrate(
  (app) => {
    try { app.delete(app.findFirstRecordByFilter("function_config", "fn = 'chat'")); } catch (_) {}
    try { app.delete(app.findFirstRecordByFilter("settings", "key = 'prompt_chat'")); } catch (_) {}
  },
  (app) => {
    // Down: recreate a basic chat function_config row so the migration is reversible.
    try {
      let exists = null;
      try { exists = app.findFirstRecordByFilter("function_config", "fn = 'chat'"); } catch (_) {}
      if (!exists) {
        const r = new Record(app.findCollectionByNameOrId("function_config"));
        r.set("fn", "chat"); r.set("provider", ""); r.set("model", ""); r.set("enabled", true);
        app.save(r);
      }
    } catch (_) {}
  }
);
