/// <reference path="../pb_data/types.d.ts" />

// Sate — per-provider AI usage limits (token count OR $ budget), usage tracking, and prices.
// Ported design from ludodex's ai-usage.sqlite (usage/limits/prices). Also seeds OpenRouter as
// a provider (OpenAI-compatible gateway). All additive.
//
//   ai_usage   — per provider+model+day token counters (aggregated for the month at read time)
//   ai_limits  — one row per provider: monthly token cap and/or monthly USD budget (+ optional
//                separate input/output token caps). Enforced before each AI call.
//   ai_prices  — USD per 1,000,000 tokens per (provider, model); editable in admin; used to turn
//                token usage into dollars for the budget cap. Unpriced model ⇒ $ cap not enforced.

const DEFAULT_PRICES = [
  // provider, model, in_usd_per_1m, out_usd_per_1m  (approximate; editable in Admin)
  ["google", "gemini-2.5-flash", 0.3, 2.5],
  ["google", "gemini-2.5-flash-lite", 0.1, 0.4],
  ["google", "gemini-2.0-flash", 0.1, 0.4],
  ["google", "gemini-1.5-flash", 0.075, 0.3],
  ["anthropic", "claude-haiku-4-5-20251001", 1.0, 5.0],
  ["anthropic", "claude-3-5-haiku-latest", 0.8, 4.0],
  ["anthropic", "claude-sonnet-4-5", 3.0, 15.0],
  ["openai", "gpt-5-mini", 0.25, 2.0],
  ["openai", "gpt-4o-mini", 0.15, 0.6],
  ["openai", "gpt-4o", 2.5, 10.0],
];

migrate(
  (app) => {
    if (!collExists(app, "ai_usage")) {
      const c = new Collection({
        type: "base",
        name: "ai_usage",
        fields: [
          { type: "text", name: "provider", required: true, max: 40 },
          { type: "text", name: "model", max: 200 },
          { type: "text", name: "day", required: true, max: 10 }, // YYYY-MM-DD
          { type: "number", name: "calls" },
          { type: "number", name: "input_tokens" },
          { type: "number", name: "output_tokens" },
          { type: "autodate", name: "created", onCreate: true },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_aiusage_pmd ON ai_usage (provider, model, day)",
          "CREATE INDEX idx_aiusage_pd ON ai_usage (provider, day)",
        ],
      });
      app.save(c);
    }

    if (!collExists(app, "ai_limits")) {
      const c = new Collection({
        type: "base",
        name: "ai_limits",
        fields: [
          { type: "text", name: "provider", required: true, max: 40 },
          { type: "number", name: "monthly_tokens" }, // 0/blank = unlimited
          { type: "number", name: "usd_budget" },     // 0/blank = unlimited
          { type: "number", name: "in_cap" },
          { type: "number", name: "out_cap" },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
        indexes: ["CREATE UNIQUE INDEX idx_ailimits_provider ON ai_limits (provider)"],
      });
      app.save(c);
    }

    if (!collExists(app, "ai_prices")) {
      const c = new Collection({
        type: "base",
        name: "ai_prices",
        fields: [
          { type: "text", name: "provider", required: true, max: 40 },
          { type: "text", name: "model", required: true, max: 200 },
          { type: "number", name: "in_usd" },  // USD per 1M input tokens
          { type: "number", name: "out_usd" }, // USD per 1M output tokens
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
        indexes: ["CREATE UNIQUE INDEX idx_aiprices_pm ON ai_prices (provider, model)"],
      });
      app.save(c);
      const prices = app.findCollectionByNameOrId("ai_prices");
      for (const [prov, model, inUsd, outUsd] of DEFAULT_PRICES) {
        const r = new Record(prices);
        r.set("provider", prov); r.set("model", model);
        r.set("in_usd", inUsd); r.set("out_usd", outUsd);
        app.save(r);
      }
    }

    // Seed OpenRouter as a provider so it shows in the admin providers list (key added by user).
    try {
      const existing = app.findFirstRecordByFilter("providers", "name = 'openrouter'");
      if (!existing) throw new Error("seed");
    } catch (_) {
      try {
        const r = new Record(app.findCollectionByNameOrId("providers"));
        r.set("name", "openrouter");
        r.set("enabled", true);
        app.save(r);
      } catch (_) {}
    }
  },
  (app) => {
    for (const name of ["ai_usage", "ai_limits", "ai_prices"]) {
      try { app.delete(app.findCollectionByNameOrId(name)); } catch (_) {}
    }
    try { app.delete(app.findFirstRecordByFilter("providers", "name = 'openrouter'")); } catch (_) {}
  }
);

function collExists(app, name) {
  try { app.findCollectionByNameOrId(name); return true; } catch (_) { return false; }
}
