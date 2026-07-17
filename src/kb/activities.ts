// Sate core — activity knowledge base: the exercise counterpart to kb/foods. Retrieval, prompt
// reference formatting, usage tracking, self-growth, plus the MET→kcal burn math and the compose-tab
// prefix search. Ported from PocketBase pb_hooks/activities.js. Operates over the DataStore instance()
// scope collection "activities".

import type { DataStore } from "../ports";
import type { Activity } from "../schema";
import { norm, num, searchByText as kbSearchByText, bumpUsage as kbBumpUsage, type KbRecord } from "./index";

const COLL = "activities";

// ~70 kg reference: kcal/min = MET * 3.5 * kg / 200 ≈ MET * 1.23. No per-user weight yet.
export const KCAL_PER_MIN_PER_MET = (3.5 * 70) / 200;

const STOP = [
  "and", "the", "with", "for", "min", "mins", "minute", "minutes", "hour", "hours", "hr", "hrs",
  "sec", "secs", "of", "at", "a", "an", "did", "was", "were", "some", "about", "around", "light",
  "easy", "hard", "intense", "moderate", "session", "workout", "exercise", "today", "morning",
  "evening", "mile", "miles", "mi", "km", "pace", "reps", "sets",
];

export function normKey(name: string): string {
  return norm(name) + "|";
}

// A parsed AI activity line the KB can absorb (an ActivityItem-shaped object).
export interface ActivityUpsertItem {
  name?: string;
  duration_min?: number;
  intensity?: string;
  kcal_burned?: number;
}

// kcal burned for a given activity record over `minutes`. Faithful to v1 activities.burnFor.
export function burnFor(rec: Activity, minutes: number): number {
  const met = num(rec.met) || 4;
  return Math.round(met * KCAL_PER_MIN_PER_MET * num(minutes));
}

// Find activities whose name/alias appears (as a whole phrase) in the description, verified-first.
export async function searchByText(store: DataStore, text: string): Promise<Activity[]> {
  return (await kbSearchByText(store, COLL, text, STOP)) as unknown as Activity[];
}

// Free-text prefix/substring search for the autocomplete dropdown. v1 used PocketBase `search ~`;
// over the DataStore we scan a bounded page and match in memory, ranked verified-first then most-used.
export async function searchByPrefix(store: DataStore, q: string, limit?: number): Promise<Activity[]> {
  const term = norm(q);
  const cap = limit || 12;
  let rows: Activity[] = [];
  try {
    const { items } = await store.list<Activity>(COLL, { limit: 2000 });
    rows = items;
  } catch {
    return [];
  }
  const matched = term ? rows.filter((r) => (r.search || norm(r.name)).indexOf(term) !== -1) : rows;
  matched.sort(
    (a, b) =>
      (b.verified ? 1 : 0) - (a.verified ? 1 : 0) ||
      num(b.usage_count) - num(a.usage_count) ||
      String(a.name).localeCompare(String(b.name)),
  );
  return matched.slice(0, cap);
}

// The grounding block handed to the activity AI so it reuses stored burn rates.
export function referenceBlock(records: Activity[]): string {
  if (!records || !records.length) return "";
  const lines = records.map((f) => {
    const kpm = (num(f.met) * KCAL_PER_MIN_PER_MET).toFixed(1);
    return `- ${f.name}: about ${kpm} kcal/min (MET ${num(f.met)})`;
  });
  return (
    "Known activities and their approximate burn rate (use these rates when the description matches, " +
    "scaled by the actual duration):\n" + lines.join("\n")
  );
}

// Bump usage_count on matched activity records (best-effort).
export async function bumpUsage(store: DataStore, records: Activity[]): Promise<void> {
  await kbBumpUsage(store, COLL, records as unknown as KbRecord[]);
}

// Auto-save newly seen activities the AI names, as unverified (self-growth). Stores an approximate
// MET derived from the AI's kcal_burned/duration so the preset path can reuse it next time. Faithful
// to v1 activities.upsertItems. Best-effort; never throws.
export async function upsertItems(store: DataStore, items: ActivityUpsertItem[] | undefined): Promise<void> {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const name = String((item && item.name) || "").trim();
    if (!name || name.length < 2) continue;
    const key = normKey(name);
    let rec: Activity | null = null;
    try {
      const { items: found } = await store.list<Activity>(COLL, {
        where: [{ field: "norm_key", op: "==", value: key }],
        limit: 1,
      });
      rec = found[0] ?? null;
    } catch {
      rec = null;
    }
    if (rec) {
      try {
        await store.update<Activity>(COLL, rec.id, { usage_count: num(rec.usage_count) + 1 });
      } catch {
        /* best-effort */
      }
      continue;
    }
    const mins = num(item.duration_min);
    const kcal = num(item.kcal_burned);
    const met = mins > 0 && kcal > 0 ? +(kcal / (KCAL_PER_MIN_PER_MET * mins)).toFixed(1) : 0;
    try {
      await store.create<Activity>(COLL, {
        name,
        category: "",
        met,
        aliases: [],
        source: "ai",
        verified: false,
        usage_count: 1,
        search: name.toLowerCase(),
        norm_key: key,
      });
    } catch {
      /* best-effort */
    }
  }
}

export { norm, num };
