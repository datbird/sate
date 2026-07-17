// Sate core — shared knowledge-base retrieval primitives for the foods and activities modules.
// Ported from PocketBase pb_hooks/kb.js. The one structural change: these run over the DataStore
// port (instance() scope), not PocketBase. PocketBase's server-side `search ~ {:w}` OR-prefilter has
// no DataStore equivalent, so we fetch a bounded, verified-first candidate page and apply the exact
// same whole-phrase name/alias matcher + ranking in memory. For a personal-scale KB this is faithful
// and fast enough. TODO(phase2): let adapters push the token prefilter down (Firestore array-contains
// on a token field, SQLite LIKE) when a KB ever grows large.

import type { DataStore } from "../ports";

// A knowledge-base row (foods or activities) as the matcher needs to see it. Both collections carry
// name/aliases/verified/usage_count/search; each domain adds its own columns (kcal…, or met).
export interface KbRecord {
  id: string;
  name?: string;
  aliases?: unknown; // string[] in practice; read defensively
  verified?: boolean;
  usage_count?: number;
  search?: string;
  [k: string]: unknown;
}

// How many candidates to pull before in-memory matching. Personal KBs are far smaller than this.
const CANDIDATE_SCAN = 2000;

export function norm(s: unknown): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

// Read a row's `aliases` as a string[]. Over the DataStore it is already a JS array (none of the
// PocketBase JsonRaw byte-decoding the v1 kb.js needed), but stay defensive.
export function readAliases(rec: KbRecord): string[] {
  const v = rec.aliases;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

interface Ranked {
  rec: KbRecord;
  len: number;
  v: number;
  u: number;
}

// Whole-phrase name/alias search within `coll`: find rows whose name or an alias appears as a phrase
// in the (normalized) text, ranked verified-first, then longest-match, then most-used. `stop` is the
// caller's domain stop-word list. Faithful to v1 kb.searchByText's post-filter + sort.
export async function searchByText(
  store: DataStore,
  coll: string,
  text: string,
  stop: string[],
): Promise<KbRecord[]> {
  const nt = norm(text);
  if (!nt) return [];
  const words = nt.split(" ").filter((w) => w.length >= 3 && stop.indexOf(w) === -1);
  if (!words.length) return [];

  let cands: KbRecord[] = [];
  try {
    const page = await store.list<KbRecord>(coll, {
      orderBy: [{ field: "verified", dir: "desc" }],
      limit: CANDIDATE_SCAN,
    });
    cands = page.items;
  } catch {
    cands = [];
  }

  const padded = " " + nt + " ";
  const matches: Ranked[] = [];
  for (const f of cands) {
    const names = [norm(f.name)].concat(readAliases(f).map(norm)).filter(Boolean);
    let best = "";
    for (const nm of names) {
      if (!nm) continue;
      if (padded.indexOf(" " + nm + " ") !== -1 || (nm.length >= 5 && nt.indexOf(nm) !== -1)) {
        if (nm.length > best.length) best = nm;
      }
    }
    if (best) matches.push({ rec: f, len: best.length, v: f.verified ? 1 : 0, u: num(f.usage_count) });
  }
  matches.sort((a, b) => b.v - a.v || b.len - a.len || b.u - a.u);
  return matches.slice(0, 12).map((m) => m.rec);
}

// Bump usage_count on a set of matched records (best-effort — never throws).
export async function bumpUsage(store: DataStore, coll: string, records: KbRecord[]): Promise<void> {
  for (const f of records) {
    try {
      await store.update<KbRecord>(coll, f.id, { usage_count: num(f.usage_count) + 1 });
    } catch {
      /* best-effort */
    }
  }
}
