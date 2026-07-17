// Sate core — food knowledge base: retrieval, prompt-reference formatting, usage tracking, and
// self-growth (auto-saving newly seen foods as unverified). Ported from PocketBase pb_hooks/foods.js;
// the generic primitives (norm/num/readAliases/searchByText/bumpUsage) come from kb/index. Operates
// over the DataStore instance() scope collection "foods".

import type { DataStore } from "../ports";
import type { Food } from "../schema";
import { norm, num, readAliases, searchByText as kbSearchByText, type KbRecord } from "./index";

const COLL = "foods";

const STOP = [
  "and", "the", "with", "some", "cup", "cups", "large", "small", "medium", "one", "two", "half",
  "slice", "slices", "bowl", "plate", "piece", "pieces", "serving", "servings", "oz", "ounce",
  "gram", "grams", "tbsp", "tsp", "plain", "fresh",
];

export function normKey(name: string, brand: string): string {
  return norm(name) + "|" + norm(brand);
}

// A parsed AI/import nutrition line the KB can absorb (a NutritionItem-shaped object).
export interface FoodUpsertItem {
  name?: string;
  qty?: string;
  kcal?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sugar?: number;
  sodium?: number;
  sat_fat?: number;
}

// Find foods whose name/alias appears (as a whole phrase) in the meal text, verified-first.
export async function searchByText(store: DataStore, text: string): Promise<Food[]> {
  return (await kbSearchByText(store, COLL, text, STOP)) as unknown as Food[];
}

// Are the meaningful words of the meal actually covered by the matched foods? A lone generic
// ingredient hit ("beef" in "beef rendang") shouldn't count the dish as known — that's exactly when
// a web search is worth offering. Substring matching both ways absorbs plurals/variants. Faithful to v1.
export function coverageOk(text: string, records: Food[]): boolean {
  if (!records || !records.length) return false;
  const words = norm(text).split(" ").filter((w) => w.length >= 4 && STOP.indexOf(w) === -1);
  if (!words.length) return true; // nothing distinctive to cover — a match is enough
  const covered: string[] = [];
  for (const f of records) {
    const names = [norm(f.name)].concat(readAliases(f as unknown as KbRecord).map(norm));
    for (const nm of names) for (const w of nm.split(" ")) if (w.length >= 3) covered.push(w);
  }
  for (const w of words) {
    let okw = false;
    for (const c of covered) {
      if (w === c || w.indexOf(c) !== -1 || c.indexOf(w) !== -1) {
        okw = true;
        break;
      }
    }
    if (!okw) return false;
  }
  return true;
}

// The grounding block handed to the nutrition AI so it prefers stored per-serving values.
export function referenceBlock(records: Food[]): string {
  if (!records || !records.length) return "";
  const lines = records.map((f) => {
    const brand = f.brand ? ` (${f.brand})` : "";
    const serv = f.serving_desc || "1 serving";
    return (
      `- ${f.name}${brand} — ${serv}: ${Math.round(num(f.kcal))} kcal, ` +
      `${Math.round(num(f.protein))}g protein, ${Math.round(num(f.carbs))}g carbs, ${Math.round(num(f.fat))}g fat`
    );
  });
  return (
    "Known foods from the database (prefer these per-serving values when the meal includes them; " +
    "scale to the actual amount eaten):\n" + lines.join("\n")
  );
}

// Auto-save newly seen foods as unverified (self-growth). Existing rows: bump usage, and for an
// authoritative web lookup, upgrade a stale unverified guess in place — but never overwrite seed data
// or an admin-verified record. Faithful to v1 foods.upsertItems. Best-effort; never throws.
export async function upsertItems(
  store: DataStore,
  items: FoodUpsertItem[] | undefined,
  source?: string,
): Promise<void> {
  if (!Array.isArray(items)) return;
  const src = source || "ai";
  for (const item of items) {
    const name = String((item && item.name) || "").trim();
    if (!name || name.length < 2) continue;
    const key = normKey(name, "");
    let rec: Food | null = null;
    try {
      const { items: found } = await store.list<Food>(COLL, {
        where: [{ field: "norm_key", op: "==", value: key }],
        limit: 1,
      });
      rec = found[0] ?? null;
    } catch {
      rec = null;
    }
    if (rec) {
      try {
        const patch: Partial<Food> = { usage_count: num(rec.usage_count) + 1 };
        if (src === "web" && !rec.verified && rec.source !== "seed") {
          patch.kcal = num(item.kcal);
          patch.protein = num(item.protein);
          patch.carbs = num(item.carbs);
          patch.fat = num(item.fat);
          patch.fiber = num(item.fiber);
          patch.sugar = num(item.sugar);
          patch.sodium = num(item.sodium);
          patch.sat_fat = num(item.sat_fat);
          if (item.qty) patch.serving_desc = String(item.qty);
          patch.source = "web";
        }
        await store.update<Food>(COLL, rec.id, patch);
      } catch {
        /* best-effort */
      }
      continue;
    }
    try {
      await store.create<Food>(COLL, {
        name,
        brand: "",
        serving_desc: String((item && item.qty) || "1 serving"),
        kcal: num(item.kcal),
        protein: num(item.protein),
        carbs: num(item.carbs),
        fat: num(item.fat),
        fiber: num(item.fiber),
        sugar: num(item.sugar),
        sodium: num(item.sodium),
        sat_fat: num(item.sat_fat),
        category: "",
        aliases: [],
        source: src,
        verified: false,
        usage_count: 1,
        search: name.toLowerCase(),
        norm_key: key,
      });
    } catch {
      // unique-race or validation — ignore
    }
  }
}

// Brand-aware single-record upsert (v1 upsertFoodRecord). Unlike upsertItems (which keys on
// normKey(name, "") and always saves brand=""), this keys on normKey(name, brand) and stores the
// brand, so a branded item ("Greek Yogurt" by "Chobani") gets its OWN row instead of colliding with —
// and overwriting — a generic same-name row. Used by the food-accept flow, where USDA/OFF candidates
// carry a real brand. On an existing row: bump usage, and unless it's verified/seed, refresh serving +
// nutrition + source (v1 semantics — the accepted candidate is authoritative for a non-protected row).
export interface FoodTotal {
  kcal?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sugar?: number;
  sodium?: number;
  sat_fat?: number;
}
export async function upsertFoodRecord(
  store: DataStore,
  name: string,
  brand: string,
  serving: string,
  total: FoodTotal,
  source: string,
): Promise<void> {
  const nm = String(name || "").trim();
  if (!nm) return;
  const br = String(brand || "").trim();
  const key = normKey(nm, br);
  let rec: Food | null = null;
  try {
    const { items } = await store.list<Food>(COLL, {
      where: [{ field: "norm_key", op: "==", value: key }],
      limit: 1,
    });
    rec = items[0] ?? null;
  } catch {
    rec = null;
  }
  if (rec) {
    const patch: Partial<Food> = { usage_count: num(rec.usage_count) + 1 };
    const protect = !!rec.verified || rec.source === "seed";
    if (!protect) {
      patch.serving_desc = serving;
      patch.kcal = num(total.kcal);
      patch.protein = num(total.protein);
      patch.carbs = num(total.carbs);
      patch.fat = num(total.fat);
      patch.fiber = num(total.fiber);
      patch.sugar = num(total.sugar);
      patch.sodium = num(total.sodium);
      patch.sat_fat = num(total.sat_fat);
      patch.source = source;
    }
    try {
      await store.update<Food>(COLL, rec.id, patch);
    } catch {
      /* best-effort */
    }
    return;
  }
  try {
    await store.create<Food>(COLL, {
      name: nm,
      brand: br,
      serving_desc: serving,
      kcal: num(total.kcal),
      protein: num(total.protein),
      carbs: num(total.carbs),
      fat: num(total.fat),
      fiber: num(total.fiber),
      sugar: num(total.sugar),
      sodium: num(total.sodium),
      sat_fat: num(total.sat_fat),
      category: "",
      aliases: [],
      source,
      verified: false,
      usage_count: 1,
      search: (nm + " " + br).toLowerCase(),
      norm_key: key,
    });
  } catch {
    // unique-race or validation — ignore
  }
}

export { norm, num, readAliases };
