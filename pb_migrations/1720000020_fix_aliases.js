/// <reference path="../pb_data/types.d.ts" />

// Sate — repair aliases corrupted by the old readAliases() bug.
//
// The old readAliases() read the `aliases` json field with rec.get(), which in PocketBase's JSVM
// exposes the field as a byte array (JsonRaw) AND replaces the record's in-memory field value with
// it. searchByText() read candidates that way and bumpUsage() then re-saved those same records, so
// every food/activity that ever matched a text-log search had its aliases persisted as the byte
// array of the original JSON text (e.g. ["egg"] stored as [91,34,101,103,103,34,93]). Over time
// that hit effectively every seeded row. The reader is fixed (getString + parse), so this one-time
// migration decodes the corrupted rows back to a proper string array and rebuilds their `search`
// field. Idempotent: only rows whose aliases are a non-empty array of numbers are touched.

migrate(
  (app) => {
    const decode = (nums) => {
      let t = "";
      for (let i = 0; i < nums.length; i++) t += String.fromCharCode(nums[i]);
      const a = JSON.parse(t);
      if (!Array.isArray(a)) throw new Error("not an array");
      return a.filter((x) => typeof x === "string");
    };

    for (const coll of ["foods", "activities"]) {
      let recs = [];
      try { recs = app.findAllRecords(coll); } catch (_) { continue; }
      let fixed = 0;
      for (const rec of recs) {
        let s = "";
        try { s = rec.getString("aliases"); } catch (_) { continue; }
        if (!s) continue;
        let v;
        try { v = JSON.parse(s); } catch (_) { continue; }
        if (!Array.isArray(v) || v.length === 0 || typeof v[0] !== "number") continue; // not corrupted

        let arr;
        try { arr = decode(v); } catch (_) { continue; }
        rec.set("aliases", arr);
        // Rebuild the lowercased search index from the repaired aliases (foods include brand).
        const name = rec.getString("name");
        const brand = coll === "foods" ? rec.getString("brand") : "";
        rec.set("search", (name + " " + brand + " " + arr.join(" ")).replace(/\s+/g, " ").trim().toLowerCase());
        try { app.save(rec); fixed++; } catch (_) {}
      }
      console.log("fix_aliases: repaired " + fixed + " " + coll + " rows");
    }
  },
  (app) => {
    // No safe down migration — the corrupted form was never intentional.
  }
);
