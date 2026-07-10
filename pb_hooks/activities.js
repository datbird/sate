/// <reference path="../pb_data/types.d.ts" />

// Activity knowledge base — the exercise counterpart to foods.js: lookup (retrieval), reference
// formatting for the AI prompt, usage tracking, and self-growth (auto-saving newly seen activities).
// Activities store a MET value; kcal/min is derived from MET and a default body mass.

// ~70 kg reference: kcal/min = MET * 3.5 * kg / 200 ≈ MET * 1.23. No per-user weight yet.
const KCAL_PER_MIN_PER_MET = 3.5 * 70 / 200;

const STOP = [
  "and","the","with","for","min","mins","minute","minutes","hour","hours","hr","hrs","sec","secs",
  "of","at","a","an","did","was","were","some","about","around","light","easy","hard","intense","moderate",
  "session","workout","exercise","today","morning","evening","mile","miles","mi","km","pace","reps","sets",
];

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function normKey(name) {
  return norm(name) + "|";
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

// kcal burned for a given activity record over `minutes`.
function burnFor(rec, minutes) {
  const met = num(rec.getFloat("met")) || 4;
  return Math.round(met * KCAL_PER_MIN_PER_MET * num(minutes));
}

// Find activities whose name/alias appears (as a whole phrase) in the description.
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
    cands = app.findRecordsByFilter("activities", conds, "-verified", 200, 0, params);
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

function bumpUsage(app, records) {
  for (const f of records) {
    try {
      f.set("usage_count", (f.getFloat("usage_count") || 0) + 1);
      app.save(f);
    } catch (_) {}
  }
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
