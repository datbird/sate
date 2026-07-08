/// <reference path="../pb_data/types.d.ts" />

// Food knowledge base helpers: lookup (retrieval), reference formatting for prompts,
// usage tracking, and self-growth (auto-saving newly seen foods as unverified).

const STOP = [
  "and","the","with","some","cup","cups","large","small","medium","one","two","half","slice","slices",
  "bowl","plate","piece","pieces","serving","servings","oz","ounce","gram","grams","tbsp","tsp","plain","fresh",
];

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function normKey(name, brand) {
  return norm(name) + "|" + norm(brand);
}
function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
function readAliases(rec) {
  let v = rec.get("aliases");
  if (v == null) return [];
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch (_) { return []; }
  }
  return v;
}

// Find foods whose name/alias appears (as a whole phrase) in the meal text.
function searchByText(app, text) {
  const nt = norm(text);
  if (!nt) return [];
  const words = nt.split(" ").filter((w) => w.length >= 3 && STOP.indexOf(w) === -1);
  if (!words.length) return [];
  const uniq = [];
  for (const w of words) if (uniq.indexOf(w) === -1 && uniq.length < 10) uniq.push(w);

  const conds = uniq.map((_, i) => `search ~ {:w${i}}`).join(" || ");
  const params = {};
  uniq.forEach((w, i) => (params["w" + i] = w));
  let cands = [];
  try {
    cands = app.findRecordsByFilter("foods", conds, "-verified", 200, 0, params);
  } catch (_) {
    cands = [];
  }

  const padded = " " + nt + " ";
  const matches = [];
  for (const f of cands) {
    const names = [norm(f.getString("name"))].concat(readAliases(f).map(norm)).filter(Boolean);
    let best = "";
    for (const nm of names) {
      if (!nm) continue;
      if (padded.indexOf(" " + nm + " ") !== -1 || (nm.length >= 5 && nt.indexOf(nm) !== -1)) {
        if (nm.length > best.length) best = nm;
      }
    }
    if (best) matches.push({ f: f, len: best.length, v: f.getBool("verified") ? 1 : 0, u: f.getFloat("usage_count") });
  }
  matches.sort((a, b) => b.v - a.v || b.len - a.len || b.u - a.u);
  return matches.slice(0, 12).map((m) => m.f);
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

function bumpUsage(app, records) {
  for (const f of records) {
    try {
      f.set("usage_count", (f.getFloat("usage_count") || 0) + 1);
      app.save(f);
    } catch (_) {}
  }
}

// Auto-save newly seen foods as unverified (self-growth). Existing entries: bump usage,
// never overwrite verified/seed values.
function upsertItems(app, items) {
  if (!Array.isArray(items)) return;
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
      r.set("category", "");
      r.set("aliases", []);
      r.set("source", "ai");
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

module.exports = { norm, normKey, num, readAliases, searchByText, referenceBlock, bumpUsage, upsertItems };
