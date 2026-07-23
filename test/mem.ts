// In-memory Platform fake for core route tests. Test-only — never imported by production code.
// Backs the DataStore ports with plain Maps; auth is bypassed via buildApi's trustEmailHeader.
import type { Platform } from "../src/ports";
import { buildApi } from "../src/api/index";

type Doc = Record<string, any>;

function match(doc: Doc, w: { field: string; op: string; value: any }): boolean {
  const v = doc[w.field];
  const t = w.value;
  switch (w.op) {
    case "==": return v === t;
    case "!=": return v !== t;
    case "<": return v < t;
    case "<=": return v <= t;
    case ">": return v > t;
    case ">=": return v >= t;
    case "in": return Array.isArray(t) && t.includes(v);
    case "array-contains": return Array.isArray(v) && v.includes(t);
    default: return true;
  }
}

export class MemStore {
  colls = new Map<string, Map<string, Doc>>();
  seq = 0;
  private c(n: string) {
    if (!this.colls.has(n)) this.colls.set(n, new Map());
    return this.colls.get(n)!;
  }
  async get(coll: string, id: string) { return this.c(coll).get(id) ?? null; }
  async list(coll: string, spec: any = {}) {
    let items = [...this.c(coll).values()].map((d) => ({ ...d }));
    for (const w of spec.where ?? []) items = items.filter((d) => match(d, w));
    for (const o of (spec.orderBy ?? []).slice().reverse()) {
      const dir = o.dir === "desc" ? -1 : 1;
      items.sort((a, b) => (a[o.field] < b[o.field] ? -dir : a[o.field] > b[o.field] ? dir : 0));
    }
    if (spec.limit) items = items.slice(0, spec.limit);
    return { items };
  }
  async create(coll: string, data: Doc, id?: string) {
    const _id = id ?? `id${++this.seq}`;
    const doc = { ...data, id: _id };
    this.c(coll).set(_id, doc);
    return { ...doc };
  }
  async update(coll: string, id: string, patch: Doc) {
    const cur = this.c(coll).get(id) ?? { id };
    const doc = { ...cur, ...patch, id };
    this.c(coll).set(id, doc);
    return { ...doc };
  }
  async delete(coll: string, id: string) { this.c(coll).delete(id); }
  async batch() { throw new Error("batch not implemented in fake"); }
  watch() { return () => {}; }
}

export function memPlatform() {
  const users = new Map<string, MemStore>();
  const inst = new MemStore();
  const provider = {
    forUser(uid: string) {
      if (!users.has(uid)) users.set(uid, new MemStore());
      return users.get(uid) as any;
    },
    instance() { return inst as any; },
  };
  const platform = {
    data: provider,
    auth: { async verify() { throw new Error("no bearer in tests"); } },
    files: { async put() { return { key: "", url: "" }; }, async get() { return null; }, async url() { return ""; }, async delete() {} },
    secrets: { async get() { return undefined; } },
  } as unknown as Platform;
  return { platform, users, inst };
}

export const TEST_EMAIL = "tester@example.com";

// Build the API with header-trust auth and return a request helper that sends the trusted email.
export function client(email: string = TEST_EMAIL) {
  const { platform, users, inst } = memPlatform();
  const app = buildApi(platform, { trustEmailHeader: "x-user-email" });
  const req = (path: string, init: any = {}) =>
    app.request(path, {
      ...init,
      headers: { "x-user-email": email, "content-type": "application/json", ...(init.headers || {}) },
    });
  return { req, users, inst, platform, email };
}
