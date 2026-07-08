#!/usr/bin/env python3
"""Build a curated ~2k-row public-domain food seed from USDA FoodData Central.
Emits a PocketBase migration with inline rows in Sate's terse seed format:
  [name, brand, serving_desc, serving_g, kcal, protein, carbs, fat, category, aliases(pipe)]
All USDA FDC data is public domain (usa.gov/publicdomain/label/1.0).
"""
import csv, os, re, sys, json
csv.field_size_limit(1 << 24)

# Directory holding the unzipped USDA FoodData Central CSV bundles (one subfolder per dataset).
# Override with: SATE_USDA_DIR=/path/to/usda python3 build_seed.py  (or pass it as argv[1]).
SP = os.environ.get("SATE_USDA_DIR") or (sys.argv[1] if len(sys.argv) > 1 else "./usda")
def d(sub): return os.path.join(SP, sub, sub)
SR = d("FoodData_Central_sr_legacy_food_csv_2018-04")
FO = d("FoodData_Central_foundation_food_csv_2025-12-18")
SV = d("FoodData_Central_survey_food_csv_2024-10-31")
BR = d("FoodData_Central_branded_food_csv_2025-12-18")

def clean_name(desc):
    s = re.sub(r"\s+", " ", desc).strip()
    s = re.sub(r",?\s*NFS$", "", s, flags=re.I)  # drop trailing "not further specified"
    # title-case if it's mostly uppercase (branded shout)
    letters = [c for c in s if c.isalpha()]
    if letters and sum(c.isupper() for c in letters) / len(letters) > 0.7:
        s = s.title()
    if len(s) > 58:  # cut at a word boundary, no mid-word truncation
        s = s[:58].rsplit(" ", 1)[0]
    return s

def clean_brand(s):
    s = re.sub(r"^[^\w]+", "", (s or "")).strip()  # strip leading ":" etc.
    return s[:30]

def fnum(v):
    try: return float(v)
    except: return None

def macro_keys(path):
    """Map our 4 macros to the set of nutrient-id values used in THIS dataset's
    food_nutrient.csv — FDC uses id (1008), FNDDS uses nutrient_nbr (208). Match by name."""
    energy, prot, fat, carb = set(), set(), set(), set()
    with open(os.path.join(path, "nutrient.csv"), newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            name, unit = r["name"].strip(), r["unit_name"].strip().upper()
            keys = {r["id"], r["nutrient_nbr"]}
            if name == "Energy" and unit == "KCAL": energy |= keys
            elif name.startswith("Energy (Atwater"): energy |= keys  # fallback energies
            elif name == "Protein": prot |= keys
            elif name == "Total lipid (fat)": fat |= keys
            elif name == "Carbohydrate, by difference": carb |= keys
    return energy, prot, fat, carb

def load_nutrients(path, keep_ids=None):
    """fdc_id -> {kcal,protein,carbs,fat} per 100g. keep_ids limits the scan."""
    energy, prot, fat, carb = macro_keys(path)
    want = energy | prot | fat | carb
    out = {}
    with open(os.path.join(path, "food_nutrient.csv"), newline="", encoding="utf-8") as f:
        for row in csv.reader(f):
            if row[0] == "id":  # header
                continue
            fid, nid, amount = row[1], row[2], row[3]
            if nid not in want: continue
            if keep_ids is not None and fid not in keep_ids: continue
            a = fnum(amount)
            if a is None: continue
            m = out.setdefault(fid, {})
            if nid in energy: m.setdefault("kcal", a)  # first energy wins (kcal before Atwater)
            elif nid in prot: m["protein"] = a
            elif nid in fat: m["fat"] = a
            elif nid in carb: m["carbs"] = a
    return {fid: {"kcal": m["kcal"], "protein": m.get("protein",0.0),
                  "carbs": m.get("carbs",0.0), "fat": m.get("fat",0.0)}
            for fid, m in out.items() if "kcal" in m}

_GOOD_MEASURE = re.compile(r"cup|oz|tbsp|tablespoon|teaspoon|piece|slice|medium|large|small|"
                           r"each|link|patty|fillet|breast|egg|bar|can|bottle|packet|scoop|stick|"
                           r"container|serving|roll|muffin|cookie", re.I)

def load_portions(path):
    """fdc_id -> (serving_g, serving_desc). Picks the most household-friendly portion."""
    raw = {}
    p = os.path.join(path, "food_portion.csv")
    if not os.path.exists(p): return {}
    with open(p, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            g = fnum(row.get("gram_weight"))
            if not g or g <= 0: continue
            amt = re.sub(r"\.0$", "", (row.get("amount") or "").strip())
            pd = (row.get("portion_description") or "").strip()
            mod = (row.get("modifier") or "").strip()
            texty = lambda x: bool(re.search(r"[a-zA-Z]", x))
            if pd and texty(pd) and pd.lower() != "quantity not specified":
                desc = pd                                   # FNDDS: already "1 cup"
            elif mod and texty(mod):
                desc = f"{amt} {mod}".strip()               # SR/Foundation: amount + modifier
            else:
                desc = "serving"
            try: seq = int(row.get("seq_num") or 999)
            except: seq = 999
            raw.setdefault(row["fdc_id"], []).append((seq, g, re.sub(r"\s+", " ", desc)[:40]))
    out = {}
    for fid, lst in raw.items():
        lst.sort(key=lambda t: (0 if _GOOD_MEASURE.search(t[2]) else 1,
                                0 if 15 <= t[1] <= 400 else 1, t[0]))
        out[fid] = (round(lst[0][1]), lst[0][2])
    return out

def load_categories(path):
    out = {}
    p = os.path.join(path, "food_category.csv")
    if not os.path.exists(p): return out
    with open(p, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            out[row["id"]] = row["description"]
    return out

def cat_bucket(desc):
    d = (desc or "").lower()
    for key, b in [("dairy","dairy"),("egg","dairy"),("fruit","fruit"),("vegetable","vegetable"),
                   ("beef","meat"),("pork","meat"),("poultry","meat"),("lamb","meat"),("sausage","meat"),
                   ("finfish","seafood"),("shellfish","seafood"),("legume","legume"),("nut","nuts"),
                   ("cereal","grain"),("grain","grain"),("pasta","grain"),("baked","bakery"),
                   ("sweet","sweets"),("fat","condiment"),("beverage","beverage"),("soup","prepared"),
                   ("sauce","condiment"),("spice","condiment"),("fast food","fast food"),
                   ("meal","prepared"),("snack","snack"),("restaurant","restaurant")]:
        if key in d: return b
    return "general"

# --------------------------------------------------------- whole/prepared foods
def read_foods(path, data_types):
    rows = []
    with open(os.path.join(path, "food.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["data_type"] in data_types:
                rows.append((row["fdc_id"], row["description"], row.get("food_category_id","")))
    return rows

def build_whole(path, data_types, cats, target, per_group, drop_kw):
    nutr = load_nutrients(path)
    ports = load_portions(path)
    foods = read_foods(path, data_types)
    groups = {}
    for fid, desc, catid in foods:
        if fid not in nutr: continue
        dl = desc.lower()
        if any(k in dl for k in drop_kw): continue
        key = re.split(r"[,(]", desc)[0].strip().lower()  # base-food group
        groups.setdefault(key, []).append((fid, desc, catid))
    out = []
    for key, items in groups.items():
        items.sort(key=lambda x: len(x[1]))  # plainest (shortest) first
        for fid, desc, catid in items[:per_group]:
            n = nutr[fid]
            g, sdesc = ports.get(fid, (100, "100 g"))
            if g <= 0: g, sdesc = 100, "100 g"
            f = g / 100.0
            cat = cat_bucket(cats.get(catid, ""))
            out.append([clean_name(desc), "", sdesc, g,
                        round(n["kcal"]*f), round(n["protein"]*f,1),
                        round(n["carbs"]*f,1), round(n["fat"]*f,1), cat, "", ""])
    # keep the ones with real serving sizes and plausible kcal
    out = [r for r in out if 0 < r[4] < 2000]
    out.sort(key=lambda r: r[0].lower())
    return out[:target]

# --------------------------------------------------------------- branded foods
BRAND_KW = ["kraft","heinz","general mills","kellogg","pepsi","frito","quaker","nestle","nestlé",
            "campbell","conagra","hershey","mars ","coca-cola","coca cola","nabisco","chobani",
            "danone","tyson","hormel","oscar mayer","nature valley","planters","gatorade",
            "tropicana","betty crocker","pillsbury","post ","del monte","progresso","hunt",
            "jif","smucker","kellanova","mondelez","unilever","clif","kind","annie","goldfish",
            "cheerios","doritos","lay","ruffles","pringles","oreo","ritz","triscuit","haagen",
            "ben & jerry","starbucks","folgers","maxwell house","v8","ocean spray","welch",
            "sargento","land o'lakes","yoplait","dannon","philadelphia","velveeta","stouffer"]
# match a keyword only on letter boundaries so "lay" doesn't hit "Clayton"
BRAND_PATS = [re.compile(r"(?<![a-z])" + re.escape(k) + r"(?![a-z])") for k in BRAND_KW]

def build_branded(target):
    # product names live in food.csv (data_type=branded_food)
    names = {}
    with open(os.path.join(BR, "food.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            names[row["fdc_id"]] = row["description"]
    # pass 1: pick candidate rows by brand keyword, capture serving grams
    cands = {}  # fid -> dict
    with open(os.path.join(BR, "branded_food.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if (row.get("market_country") or "United States") != "United States":
                continue
            owner = (row.get("brand_owner") or "").lower()
            bname = (row.get("brand_name") or "").lower()
            if not any(p.search(owner) or p.search(bname) for p in BRAND_PATS): continue
            unit = (row.get("serving_size_unit") or "").lower()
            ss = fnum(row.get("serving_size"))
            if not ss or unit not in ("g","ml","grm","mlt"): continue
            g = round(ss)
            if not (1 < g < 1000): continue
            fid = row["fdc_id"]
            desc = names.get(fid, "")
            if not desc: continue
            hh = (row.get("household_serving_fulltext") or "").strip()
            cands[fid] = {
                "name": clean_name(desc),
                "brand": clean_brand(row.get("brand_name") or row.get("brand_owner") or ""),
                "serving_desc": (hh or f"{g} {unit}")[:40],
                "g": g,
                "gtin": (row.get("gtin_upc") or "").strip(),
                "cat": cat_bucket(row.get("branded_food_category") or ""),
            }
    keep = set(cands)
    nutr = load_nutrients(BR, keep_ids=keep)
    bybrand, seen = {}, set()
    for fid, c in cands.items():
        if fid not in nutr: continue
        nm = c["name"].lower()
        if not nm or nm in seen: continue      # one representative per product name
        n = nutr[fid]
        f = c["g"]/100.0
        kcal = round(n["kcal"]*f)
        if not (0 < kcal < 2000): continue
        seen.add(nm)
        row = [c["name"], c["brand"], c["serving_desc"], c["g"], kcal,
               round(n["protein"]*f,1), round(n["carbs"]*f,1), round(n["fat"]*f,1),
               c["cat"], "", c["gtin"]]        # 11th field = barcode/UPC
        bybrand.setdefault(c["brand"].lower(), []).append(row)
    # prefer shorter/cleaner names within each brand; order brands by SKU count desc so the
    # recognizable mega-brands (Coca-Cola, Kraft, … have the most products) surface first
    for b in bybrand:
        bybrand[b].sort(key=lambda r: len(r[0]))
    brands = sorted(bybrand, key=lambda b: (-len(bybrand[b]), b))
    out = []
    for rnd in range(6):                        # up to 6 products per brand
        for b in brands:
            if len(bybrand[b]) > rnd:
                out.append(bybrand[b][rnd])
                if len(out) >= target: return out
    return out

def main():
    sr_cats = load_categories(SR)
    fo_cats = load_categories(FO)
    drop = ["baby","infant","formula, ","alaska native","restaurant,","usda commodity",
            "leavening","gelatin","puddings, ","school lunch"]
    print("Foundation…", file=sys.stderr)
    foundation = build_whole(FO, {"foundation_food"}, fo_cats, 400, 2, drop)
    print(f"  {len(foundation)}", file=sys.stderr)
    print("SR Legacy…", file=sys.stderr)
    srleg = build_whole(SR, {"sr_legacy_food"}, sr_cats, 1000, 1, drop + ["fast foods,","mcdonald","burger king","kentucky fried","taco bell","pizza hut","wendy","denny","subway","domino","papa john","applebee"])
    print(f"  {len(srleg)}", file=sys.stderr)
    print("FNDDS/Survey…", file=sys.stderr)
    fndds = build_whole(SV, {"survey_fndds_food"}, {}, 450, 1, ["baby","infant"])
    print(f"  {len(fndds)}", file=sys.stderr)
    print("Branded…", file=sys.stderr)
    branded = build_branded(400)
    print(f"  {len(branded)}", file=sys.stderr)

    # merge, dedupe by (name.lower, brand.lower)
    allrows, seen = [], set()
    for grp in (foundation, srleg, fndds, branded):
        for r in grp:
            k = (r[0].lower(), r[1].lower())
            if k in seen: continue
            seen.add(k)
            allrows.append(r)
    print(f"TOTAL merged: {len(allrows)}", file=sys.stderr)
    out = os.environ.get("SATE_OUT") or "1720000004_foods_bulk.js"
    body = ",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in allrows)
    with open(out, "w", encoding="utf-8") as f:
        f.write(MIGRATION_TEMPLATE % body)
    print(f"wrote {out} ({len(allrows)} rows)", file=sys.stderr)

MIGRATION_TEMPLATE = r'''/// <reference path="../pb_data/types.d.ts" />

// Bulk public-domain food seed curated from USDA FoodData Central (SR Legacy + Foundation +
// FNDDS/Survey + filtered Branded). All USDA FDC data is public domain
// (usa.gov/publicdomain/label/1.0) — safe to redistribute in this MIT image. Nutrient values
// were converted from USDA per-100g to per-serving. GENERATED by scripts/build-seed/build_seed.py
// — do not hand-edit. Row = [name, brand, serving_desc, serving_g, kcal, protein, carbs, fat,
// category, aliases(pipe-joined), barcode]. Idempotent: skips any norm_key that already exists.

function normKey(name, brand) {
  const n = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return n(name) + "|" + n(brand);
}

const R = [
%s
];

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("foods");
    let added = 0;
    for (const r of R) {
      const key = normKey(r[0], r[1]);
      let exists = false;
      try { app.findFirstRecordByFilter("foods", "norm_key = {:k}", { k: key }); exists = true; } catch (_) {}
      if (exists) continue;
      const aliases = r[9] ? r[9].split("|") : [];
      const rec = new Record(col);
      rec.set("name", r[0]);
      rec.set("brand", r[1]);
      rec.set("serving_desc", r[2]);
      rec.set("serving_g", r[3]);
      rec.set("kcal", r[4]);
      rec.set("protein", r[5]);
      rec.set("carbs", r[6]);
      rec.set("fat", r[7]);
      rec.set("category", r[8]);
      rec.set("aliases", aliases);
      rec.set("barcode", r[10] || "");
      rec.set("source", "seed");
      rec.set("verified", true);
      rec.set("usage_count", 0);
      rec.set("search", (r[0] + " " + r[1] + " " + aliases.join(" ") + " " + (r[10] || "")).toLowerCase());
      rec.set("norm_key", key);
      try { app.save(rec); added++; } catch (_) {}
    }
    console.log("[sate] bulk food seed: added " + added + " foods (of " + R.length + ")");
  },
  (app) => {
    // no-op on rollback: leave seeded foods in place (can't safely distinguish from 1720000002)
  }
);
'''

if __name__ == "__main__":
    main()
