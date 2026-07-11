/// <reference path="../pb_data/types.d.ts" />

// Sate — initial schema.
//
// Everything is accessed through the custom /api/sate/* routes in pb_hooks, which run
// with privileged (DAO-level) access and enforce identity from the auth proxy header.
// So every collection's API rules are left null = superusers only. This keeps the raw
// PocketBase REST API from leaking data even though the app already sits behind an auth
// proxy (defense in depth).

migrate(
  (app) => {
    // --- profiles: one row per authenticated user (keyed by email) ---
    const profiles = new Collection({
      type: "base",
      name: "profiles",
      fields: [
        { type: "text", name: "email", required: true, max: 320 },
        { type: "text", name: "name" },
        { type: "text", name: "role" }, // "admin" | "user"
        { type: "number", name: "goal_kcal" },
        { type: "number", name: "goal_protein" },
        { type: "number", name: "goal_carbs" },
        { type: "number", name: "goal_fat" },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_profiles_email ON profiles (email)"],
    });
    app.save(profiles);

    // --- entries: each logged food item/meal ---
    const entries = new Collection({
      type: "base",
      name: "entries",
      fields: [
        { type: "text", name: "user_email", required: true, max: 320 },
        { type: "date", name: "logged_at" },
        { type: "select", name: "source", maxSelect: 1, values: ["photo", "text", "manual"] },
        { type: "text", name: "description", max: 2000 },
        { type: "json", name: "items", maxSize: 200000 },
        { type: "number", name: "kcal" },
        { type: "number", name: "protein" },
        { type: "number", name: "carbs" },
        { type: "number", name: "fat" },
        { type: "text", name: "provider" },
        { type: "text", name: "model" },
        { type: "file", name: "photo", maxSelect: 1, maxSize: 15000000 },
        { type: "autodate", name: "created", onCreate: true },
      ],
      indexes: [
        "CREATE INDEX idx_entries_email_logged ON entries (user_email, logged_at)",
      ],
    });
    app.save(entries);

    // --- providers: BYO API keys (encrypted at rest) ---
    const providers = new Collection({
      type: "base",
      name: "providers",
      fields: [
        { type: "text", name: "name", required: true }, // anthropic | openai | google
        { type: "text", name: "api_key_enc", max: 5000 },
        { type: "text", name: "base_url" },
        { type: "bool", name: "enabled" },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_providers_name ON providers (name)"],
    });
    app.save(providers);

    // --- function_config: which provider+model handles each AI function ---
    const fnConfig = new Collection({
      type: "base",
      name: "function_config",
      fields: [
        { type: "text", name: "fn", required: true },
        { type: "text", name: "provider" },
        { type: "text", name: "model" },
        { type: "bool", name: "enabled" },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_function_config_fn ON function_config (fn)"],
    });
    app.save(fnConfig);

    // --- seed provider rows (empty keys, disabled until admin adds them) ---
    for (const name of ["anthropic", "openai", "google"]) {
      const r = new Record(providers);
      r.set("name", name);
      r.set("api_key_enc", "");
      r.set("enabled", false);
      app.save(r);
    }

    // --- seed the base AI functions with sensible Claude defaults ---
    // (later migrations add the rest of the registry; the routing hierarchy lets any of them fall
    // back to the global default, so only the originals need an explicit seed here.)
    const defaults = [
      { fn: "vision_estimate", model: "claude-sonnet-5" },
      { fn: "text_parse", model: "claude-haiku-4-5-20251001" },
      { fn: "daily_summary", model: "claude-haiku-4-5-20251001" },
    ];
    for (const d of defaults) {
      const r = new Record(fnConfig);
      r.set("fn", d.fn);
      r.set("provider", "anthropic");
      r.set("model", d.model);
      r.set("enabled", true);
      app.save(r);
    }
  },
  (app) => {
    for (const name of ["function_config", "providers", "entries", "profiles"]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (_) {
        // already gone
      }
    }
  }
);
