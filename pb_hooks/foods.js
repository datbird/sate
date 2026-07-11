/// <reference path="../pb_data/types.d.ts" />

// Food knowledge base helpers: lookup (retrieval), reference formatting for prompts,
// usage tracking, and self-growth (auto-saving newly seen foods as unverified). The generic
// retrieval primitives (norm/num/readAliases/searchByText/bumpUsage) are shared with activities.js
// via kb.js.

const KB = require(`${__hooks}/kb.js`);
const { norm, num, readAliases, bumpUsage } = KB;

const STOP = [
  "and","the","with","some","cup","cups","large","small","medium","one","two","half","slice","slices",
  "bowl","plate","piece","pieces","serving","servings","oz","ounce","gram","grams","tbsp","tsp","plain","fresh",
];

function normKey(name, brand) {
  return norm(name) + "|" + norm(brand);
}

// Find foods whose name/alias appears (as a whole phrase) in the meal text.
function searchByText(app, text) {
  return KB.searchByText(app, "foods", text, STOP);
}

// Are the meaningful words of the meal actually covered by the matched foods? A lone generic
// ingredient hit ("beef" in "beef rendang") shouldn't count the dish as known — that's exactly
// when a web search is worth offering. Substring matching both ways absorbs plurals/variants
// (egg/eggs, toast/toasted).
function coverageOk(text, records) {
  if (!records || !records.length) return false;
  const words = norm(text).split(" ").filter((w) => w.length >= 4 && STOP.indexOf(w) === -1);
  if (!words.length) return true; // nothing distinctive to cover — a match is enough
  const covered = [];
  for (const f of records) {
    const names = [norm(f.getString("name"))].concat(readAliases(f).map(norm));
    for (const nm of names) for (const w of nm.split(" ")) if (w.length >= 3) covered.push(w);
  }
  for (const w of words) {
    let ok = false;
    for (const c of covered) {
      if (w === c || w.indexOf(c) !== -1 || c.indexOf(w) !== -1) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

function referenceBlock(records) {
  if (!records || !records.length) return "";
  const lines = records.map((f) => {
    const b = f.getString("brand");
    const brand = b ? ` (${b})` : "";
    const serv = f.getString("serving_desc") || "1 serving";
    return `- ${f.getString("name")}${brand} — ${serv}: ${Math.round(f.getFloat("kcal"))} kcal, ` +
      `${Math.round(f.getFloat("protein"))}g protein, ${Math.round(f.getFloat("carbs"))}g carbs, ${Math.round(f.getFloat("fat"))}g fat`;
  });
  return (
    "Known foods from the database (prefer these per-serving values when the meal includes them; " +
    "scale to the actual amount eaten):\n" + lines.join("\n")
  );
}

// Auto-save newly seen foods as unverified (self-growth). Existing entries: bump usage,
// never overwrite verified/seed values.
function upsertItems(app, items, source) {
  if (!Array.isArray(items)) return;
  const src = source || "ai";
  for (const item of items) {
    const name = String((item && item.name) || "").trim();
    if (!name || name.length < 2) continue;
    const key = normKey(name, "");
    let rec = null;
    try {
      rec = app.findFirstRecordByFilter("foods", "norm_key = {:k}", { k: key });
    } catch (_) {
      rec = null;
    }
    if (rec) {
      try {
        // A web lookup is authoritative — upgrade a stale, unverified guess in place
        // (but never overwrite seed data or an admin-verified record).
        if (src === "web" && !rec.getBool("verified") && rec.getString("source") !== "seed") {
          rec.set("kcal", num(item.kcal));
          rec.set("protein", num(item.protein));
          rec.set("carbs", num(item.carbs));
          rec.set("fat", num(item.fat));
          rec.set("fiber", num(item.fiber));
          rec.set("sugar", num(item.sugar));
          rec.set("sodium", num(item.sodium));
          rec.set("sat_fat", num(item.sat_fat));
          if (item.qty) rec.set("serving_desc", String(item.qty));
          rec.set("source", "web");
        }
        rec.set("usage_count", (rec.getFloat("usage_count") || 0) + 1);
        app.save(rec);
      } catch (_) {}
      continue;
    }
    try {
      const r = new Record(app.findCollectionByNameOrId("foods"));
      r.set("name", name);
      r.set("brand", "");
      r.set("serving_desc", String((item && item.qty) || "1 serving"));
      r.set("kcal", num(item.kcal));
      r.set("protein", num(item.protein));
      r.set("carbs", num(item.carbs));
      r.set("fat", num(item.fat));
      r.set("fiber", num(item.fiber));
      r.set("sugar", num(item.sugar));
      r.set("sodium", num(item.sodium));
      r.set("sat_fat", num(item.sat_fat));
      r.set("category", "");
      r.set("aliases", []);
      r.set("source", src);
      r.set("verified", false);
      r.set("usage_count", 1);
      r.set("search", name.toLowerCase());
      r.set("norm_key", key);
      app.save(r);
    } catch (_) {
      // unique-race or validation — ignore
    }
  }
}

module.exports = { norm, normKey, num, readAliases, searchByText, coverageOk, referenceBlock, bumpUsage, upsertItems };
