/// <reference path="../pb_data/types.d.ts" />

// Sate — AI usage tracking + per-provider limit enforcement + token→dollar pricing.
// Ported design from ludodex (server/ai.py record_usage / check_limit / cost_usd). Backed by the
// ai_usage / ai_limits / ai_prices collections (migration 1720000014). Period = calendar month.
//
// The whole thing is best-effort: usage recording never throws (accounting must not break a
// working AI call), but checkLimit() DOES throw when a cap is exceeded (that's the enforcement).

function pad2(n) { return n < 10 ? "0" + n : "" + n; }
function todayStr() { return new Date().toISOString().slice(0, 10); }

// [start, end) YYYY-MM-DD bounds of the current UTC calendar month.
function monthBounds() {
  const d = new Date();
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const start = y + "-" + pad2(m + 1) + "-01";
  const ny = m === 11 ? y + 1 : y, nm = m === 11 ? 0 : m + 1;
  return { start: start, end: ny + "-" + pad2(nm + 1) + "-01" };
}

// Add a call's token counts to today's per provider+model row. Never throws.
function recordUsage(app, provider, model, input, output) {
  try {
    if (!provider) return;
    model = model || "";
    const day = todayStr();
    let rec = null;
    try {
      rec = app.findFirstRecordByFilter("ai_usage",
        "provider = {:p} && model = {:m} && day = {:d}", { p: provider, m: model, d: day });
    } catch (_) { rec = null; }
    if (!rec) {
      rec = new Record(app.findCollectionByNameOrId("ai_usage"));
      rec.set("provider", provider); rec.set("model", model); rec.set("day", day);
      rec.set("calls", 0); rec.set("input_tokens", 0); rec.set("output_tokens", 0);
    }
    rec.set("calls", rec.getInt("calls") + 1);
    rec.set("input_tokens", rec.getInt("input_tokens") + (input || 0));
    rec.set("output_tokens", rec.getInt("output_tokens") + (output || 0));
    app.save(rec);
  } catch (_) { /* accounting is best-effort — never break the AI call */ }
}

// This month's ai_usage rows for a provider.
function monthRows(app, provider) {
  const b = monthBounds();
  try {
    return app.findRecordsByFilter("ai_usage",
      "provider = {:p} && day >= {:s} && day < {:e}", "-day", 2000, 0,
      { p: provider, s: b.start, e: b.end });
  } catch (_) { return []; }
}

function monthIO(app, provider) {
  let inp = 0, out = 0, calls = 0;
  for (const r of monthRows(app, provider)) {
    inp += r.getInt("input_tokens"); out += r.getInt("output_tokens"); calls += r.getInt("calls");
  }
  return { input: inp, output: out, tokens: inp + out, calls: calls };
}

// Per-model price row, or null. Returns { in_usd, out_usd } per 1M tokens.
function priceFor(app, provider, model) {
  try {
    const r = app.findFirstRecordByFilter("ai_prices",
      "provider = {:p} && model = {:m}", { p: provider, m: model || "" });
    return { in_usd: r.getFloat("in_usd"), out_usd: r.getFloat("out_usd") };
  } catch (_) { return null; }
}

// Dollar cost of input/output tokens for a (provider, model); null if the model isn't priced.
function costUsd(app, provider, model, input, output) {
  const p = priceFor(app, provider, model);
  if (!p) return null;
  return (input / 1e6) * p.in_usd + (output / 1e6) * p.out_usd;
}

// This month's total spend for a provider (sums only priced models).
function monthCostUsd(app, provider) {
  let usd = 0;
  for (const r of monthRows(app, provider)) {
    const c = costUsd(app, provider, r.getString("model"), r.getInt("input_tokens"), r.getInt("output_tokens"));
    if (c != null) usd += c;
  }
  return usd;
}

// The ai_limits row for a provider as a plain object, or null.
function limitFor(app, provider) {
  try {
    const r = app.findFirstRecordByFilter("ai_limits", "provider = {:p}", { p: provider });
    return {
      monthly_tokens: r.getFloat("monthly_tokens") || 0,
      usd_budget: r.getFloat("usd_budget") || 0,
      in_cap: r.getFloat("in_cap") || 0,
      out_cap: r.getFloat("out_cap") || 0,
    };
  } catch (_) { return null; }
}

// Enforce this provider's caps BEFORE a call. Throws a clear Error when a cap is already met.
function checkLimit(app, provider, model) {
  const lim = limitFor(app, provider);
  if (!lim) return;
  const io = monthIO(app, provider);
  if (lim.monthly_tokens > 0 && io.tokens >= lim.monthly_tokens)
    throw new Error(provider + " monthly token limit reached (" + io.tokens + "/" + lim.monthly_tokens + ") — raise it in Admin › AI › Limits.");
  if (lim.in_cap > 0 && io.input >= lim.in_cap)
    throw new Error(provider + " monthly input-token limit reached — raise it in Admin › AI › Limits.");
  if (lim.out_cap > 0 && io.output >= lim.out_cap)
    throw new Error(provider + " monthly output-token limit reached — raise it in Admin › AI › Limits.");
  if (lim.usd_budget > 0) {
    const spent = monthCostUsd(app, provider);
    if (spent >= lim.usd_budget)
      throw new Error(provider + " monthly budget reached ($" + spent.toFixed(2) + "/$" + lim.usd_budget.toFixed(2) + ") — raise it in Admin › AI › Limits.");
  }
}

// Upsert a provider's limits. caps = { monthly_tokens, usd_budget, in_cap, out_cap } (0 clears).
function setLimit(app, provider, caps) {
  let rec = null;
  try { rec = app.findFirstRecordByFilter("ai_limits", "provider = {:p}", { p: provider }); } catch (_) { rec = null; }
  if (!rec) {
    rec = new Record(app.findCollectionByNameOrId("ai_limits"));
    rec.set("provider", provider);
  }
  for (const k of ["monthly_tokens", "usd_budget", "in_cap", "out_cap"]) {
    if (caps[k] !== undefined) rec.set(k, Number(caps[k]) || 0);
  }
  app.save(rec);
}

// Per-provider month summary for the admin Usage panel.
function usageSummary(app, providers) {
  return (providers || []).map((provider) => {
    const io = monthIO(app, provider);
    const lim = limitFor(app, provider) || { monthly_tokens: 0, usd_budget: 0, in_cap: 0, out_cap: 0 };
    return {
      provider: provider,
      input: io.input, output: io.output, tokens: io.tokens, calls: io.calls,
      cost_usd: +monthCostUsd(app, provider).toFixed(4),
      limit: lim,
    };
  });
}

function pricesList(app) {
  let recs = [];
  try { recs = app.findAllRecords("ai_prices"); } catch (_) { recs = []; }
  return recs.map((r) => ({
    provider: r.getString("provider"), model: r.getString("model"),
    in_usd: r.getFloat("in_usd"), out_usd: r.getFloat("out_usd"),
  }));
}

// Upsert a per-model price (USD per 1M tokens). in_usd/out_usd < 0 or blank ⇒ delete the row.
function setPrice(app, provider, model, inUsd, outUsd) {
  let rec = null;
  try { rec = app.findFirstRecordByFilter("ai_prices", "provider = {:p} && model = {:m}", { p: provider, m: model }); } catch (_) { rec = null; }
  const clear = (inUsd === "" || inUsd == null) && (outUsd === "" || outUsd == null);
  if (clear) { if (rec) app.delete(rec); return; }
  if (!rec) {
    rec = new Record(app.findCollectionByNameOrId("ai_prices"));
    rec.set("provider", provider); rec.set("model", model);
  }
  rec.set("in_usd", Number(inUsd) || 0);
  rec.set("out_usd", Number(outUsd) || 0);
  app.save(rec);
}

module.exports = {
  recordUsage, checkLimit, setLimit, usageSummary, pricesList, setPrice,
  monthIO, monthCostUsd, limitFor, costUsd,
};
