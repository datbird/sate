/// <reference path="../pb_data/types.d.ts" />

// Activity knowledge base — the exercise counterpart to foods.js: lookup (retrieval), reference
// formatting for the AI prompt, usage tracking, and self-growth (auto-saving newly seen activities).
// Activities store a MET value; kcal/min is derived from MET and a default body mass.

// ~70 kg reference: kcal/min = MET * 3.5 * kg / 200 ≈ MET * 1.23. No per-user weight yet.
const KCAL_PER_MIN_PER_MET = 3.5 * 70 / 200;

// Generic retrieval primitives (norm/num/readAliases/searchByText/bumpUsage) are shared with foods.js
// via kb.js.
const KB = require(`${__hooks}/kb.js`);
const { norm, num, readAliases, bumpUsage } = KB;

const STOP = [
  "and","the","with","for","min","mins","minute","minutes","hour","hours","hr","hrs","sec","secs",
  "of","at","a","an","did","was","were","some","about","around","light","easy","hard","intense","moderate",
  "session","workout","exercise","today","morning","evening","mile","miles","mi","km","pace","reps","sets",
];

function normKey(name) {
  return norm(name) + "|";
}

// kcal burned for a given activity record over `minutes`.
function burnFor(rec, minutes) {
  const met = num(rec.getFloat("met")) || 4;
  return Math.round(met * KCAL_PER_MIN_PER_MET * num(minutes));
}

// Find activities whose name/alias appears (as a whole phrase) in the description.
function searchByText(app, text) {
  return KB.searchByText(app, "activities", text, STOP);
}

// Free-text prefix/substring search for the autocomplete dropdown.
function searchByPrefix(app, q, limit) {
  const term = norm(q);
  try {
    if (term) return app.findRecordsByFilter("activities", "search ~ {:t}", "-verified,-usage_count,name", limit || 12, 0, { t: term });
    return app.findRecordsByFilter("activities", "id != ''", "-usage_count,name", limit || 12, 0, {});
  } catch (_) {
    return [];
  }
}

function referenceBlock(records) {
  if (!records || !records.length) return "";
  const lines = records.map((f) => {
    const kpm = (num(f.getFloat("met")) * KCAL_PER_MIN_PER_MET).toFixed(1);
    return `- ${f.getString("name")}: about ${kpm} kcal/min (MET ${f.getFloat("met")})`;
  });
  return (
    "Known activities and their approximate burn rate (use these rates when the description matches, " +
    "scaled by the actual duration):\n" + lines.join("\n")
  );
}

// Auto-save newly seen activities the AI names, as unverified (self-growth). Stores an approximate
// MET derived from the AI's kcal_burned/duration so the preset path can reuse it next time.
function upsertItems(app, items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const name = String((item && item.name) || "").trim();
    if (!name || name.length < 2) continue;
    const key = normKey(name);
    let rec = null;
    try { rec = app.findFirstRecordByFilter("activities", "norm_key = {:k}", { k: key }); } catch (_) { rec = null; }
    if (rec) {
      try { rec.set("usage_count", (rec.getFloat("usage_count") || 0) + 1); app.save(rec); } catch (_) {}
      continue;
    }
    const mins = num(item.duration_min);
    const kcal = num(item.kcal_burned);
    const met = mins > 0 && kcal > 0 ? +(kcal / (KCAL_PER_MIN_PER_MET * mins)).toFixed(1) : 0;
    try {
      const r = new Record(app.findCollectionByNameOrId("activities"));
      r.set("name", name);
      r.set("category", "");
      r.set("met", met);
      r.set("aliases", []);
      r.set("source", "ai");
      r.set("verified", false);
      r.set("usage_count", 1);
      r.set("search", name.toLowerCase());
      r.set("norm_key", key);
      app.save(r);
    } catch (_) {}
  }
}

module.exports = {
  norm, normKey, num, readAliases, KCAL_PER_MIN_PER_MET,
  burnFor, searchByText, searchByPrefix, referenceBlock, bumpUsage, upsertItems,
};
