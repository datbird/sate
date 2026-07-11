/// <reference path="../pb_data/types.d.ts" />

// Shared knowledge-base retrieval primitives for the foods and activities modules. Both are
// structurally identical (a name/alias/usage table with whole-phrase text matching); this holds the
// bits that were byte-for-byte duplicated between foods.js and activities.js so a fix to the
// tokenizer/matcher lands in one place.

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

// Read a record's `aliases` json field as a string array. PocketBase json fields come back from
// .get() as an opaque JsonRaw (a Go []byte that goja exposes as a byte-array — .map over it yields
// garbage AND re-saving the record then persists those bytes), so read the JSON *text* via
// getString() and parse it, matching the fn_overrides convention in api.js. Anything that isn't a
// JSON array → []. Also transparently decodes rows corrupted by the old .get()-then-save bug, where
// aliases were persisted as the byte array of the original JSON text (see migration 1720000020).
function readAliases(rec) {
  let s = "";
  try { s = rec.getString("aliases"); } catch (_) { return []; }
  if (!s) return [];
  let v;
  try { v = JSON.parse(s); } catch (_) { return []; }
  if (!Array.isArray(v)) return [];
  if (v.length === 0 || typeof v[0] === "string") return v;
  if (typeof v[0] === "number") return decodeByteAliases(v);
  return [];
}

// Legacy repair: `bytes` is the byte array of the original JSON text (["egg",…]). Turn it back into
// the string array. Returns [] if it doesn't decode cleanly.
function decodeByteAliases(bytes) {
  try {
    let t = "";
    for (let i = 0; i < bytes.length; i++) t += String.fromCharCode(bytes[i]);
    const a = JSON.parse(t);
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch (_) { return []; }
}

// Whole-phrase name/alias search within `coll`: find rows whose name or an alias appears as a phrase
// in the (normalized) text, ranked verified-first then longest-match then most-used. `stop` is the
// caller's domain stop-word list.
function searchByText(app, coll, text, stop) {
  const nt = norm(text);
  if (!nt) return [];
  const words = nt.split(" ").filter((w) => w.length >= 3 && stop.indexOf(w) === -1);
  if (!words.length) return [];
  const uniq = [];
  for (const w of words) if (uniq.indexOf(w) === -1 && uniq.length < 10) uniq.push(w);

  const conds = uniq.map((_, i) => `search ~ {:w${i}}`).join(" || ");
  const params = {};
  uniq.forEach((w, i) => (params["w" + i] = w));
  let cands = [];
  try {
    cands = app.findRecordsByFilter(coll, conds, "-verified", 200, 0, params);
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

// Bump usage_count on a set of matched records (best-effort).
function bumpUsage(app, records) {
  for (const f of records) {
    try {
      f.set("usage_count", (f.getFloat("usage_count") || 0) + 1);
      app.save(f);
    } catch (_) {}
  }
}

module.exports = { norm, num, readAliases, decodeByteAliases, searchByText, bumpUsage };
