// Contract test for the SQLite DataStore adapter — exercises the QuerySpec→SQL mapping that the ORDER
// BY bug hid in. Run: npx esbuild test-adapter.ts --bundle --platform=node --format=cjs --packages=external
// --outfile=dist/test.js && node dist/test.js   (exits non-zero on any failed assertion).
import { rmSync } from "node:fs";
import { SqliteData } from "./adapters/sqlite";

const DB = "/tmp/claude-1000/-home-tbird-aiplayground/befece52-0b7b-40e9-9b00-1a9616824540/scratchpad/adapter-test.db";
rmSync(DB, { force: true });
rmSync(DB + "-wal", { force: true });
rmSync(DB + "-shm", { force: true });

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${name}` + (extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""));
  }
}

type E = { id: string; user: string; kind: string; kcal: number; day: string; tags?: string[]; done?: boolean };

async function main() {
  const data = new SqliteData(DB);
  const u = data.forUser("alice@example.com");
  const other = data.forUser("bob@example.com");
  const inst = data.instance();

  // create + get (explicit id) + auto id
  const a = await u.create<E>("entries", { user: "alice@example.com", kind: "food", kcal: 100, day: "2026-07-10" }, "e1");
  ok("create returns id", a.id === "e1", a.id);
  const got = await u.get<E>("entries", "e1");
  ok("get round-trips", !!got && got.kcal === 100 && got.user === "alice@example.com", got);
  const auto = await u.create<E>("entries", { user: "alice@example.com", kind: "food", kcal: 5, day: "2026-07-10" });
  ok("auto id generated", !!auto.id && auto.id !== "e1", auto.id);

  // seed a spread for query tests
  await u.create<E>("entries", { user: "alice@example.com", kind: "activity", kcal: 200, day: "2026-07-11", tags: ["run", "am"] }, "e2");
  await u.create<E>("entries", { user: "alice@example.com", kind: "food", kcal: 300, day: "2026-07-12", done: true }, "e3");
  await other.create<E>("entries", { user: "bob@example.com", kind: "food", kcal: 999, day: "2026-07-12" }, "b1");

  // user scoping isolation
  const aliceAll = await u.list<E>("entries");
  ok("scoping: alice sees only her rows", aliceAll.items.length === 4 && aliceAll.items.every((e) => e.user === "alice@example.com"), aliceAll.items.length);
  const bobAll = await other.list<E>("entries");
  ok("scoping: bob sees only his row", bobAll.items.length === 1 && bobAll.items[0]!.id === "b1");

  // where ==, !=, <, >=
  ok("where ==", (await u.list<E>("entries", { where: [{ field: "kind", op: "==", value: "food" }] })).items.length === 3);
  ok("where !=", (await u.list<E>("entries", { where: [{ field: "kind", op: "!=", value: "activity" }] })).items.length === 3);
  ok("where < num", (await u.list<E>("entries", { where: [{ field: "kcal", op: "<", value: 200 }] })).items.length === 2);
  ok("where >= num", (await u.list<E>("entries", { where: [{ field: "kcal", op: ">=", value: 200 }] })).items.length === 2);

  // day-range window (the stats pattern) + orderBy (the bug that was fixed)
  const win = await u.list<E>("entries", {
    where: [
      { field: "day", op: ">=", value: "2026-07-11" },
      { field: "day", op: "<", value: "2026-07-13" },
    ],
    orderBy: [{ field: "day", dir: "asc" }],
  });
  ok("day-range window count", win.items.length === 2, win.items.map((e) => e.day));
  ok("orderBy asc", win.items[0]!.day === "2026-07-11" && win.items[1]!.day === "2026-07-12");
  const desc = await u.list<E>("entries", { orderBy: [{ field: "kcal", dir: "desc" }] });
  ok("orderBy desc", desc.items[0]!.kcal === 300 && desc.items[desc.items.length - 1]!.kcal === 5, desc.items.map((e) => e.kcal));

  // in
  ok("where in", (await u.list<E>("entries", { where: [{ field: "kind", op: "in", value: ["activity", "nope"] }] })).items.length === 1);
  ok("where in empty → none", (await u.list<E>("entries", { where: [{ field: "kind", op: "in", value: [] }] })).items.length === 0);

  // array-contains
  ok("array-contains hit", (await u.list<E>("entries", { where: [{ field: "tags", op: "array-contains", value: "run" }] })).items.length === 1);
  ok("array-contains miss", (await u.list<E>("entries", { where: [{ field: "tags", op: "array-contains", value: "zzz" }] })).items.length === 0);

  // boolean filter (json true/false ↔ 1/0)
  ok("where bool ==true", (await u.list<E>("entries", { where: [{ field: "done", op: "==", value: true }] })).items.length === 1);

  // limit + cursor pagination
  const p1 = await u.list<E>("entries", { orderBy: [{ field: "kcal", dir: "asc" }], limit: 2 });
  ok("limit caps page", p1.items.length === 2 && !!p1.nextCursor, p1.items.length);
  const p2 = await u.list<E>("entries", { orderBy: [{ field: "kcal", dir: "asc" }], limit: 2, cursor: p1.nextCursor });
  ok("cursor advances", p2.items.length === 2 && p2.items[0]!.id !== p1.items[0]!.id, p2.items.map((e) => e.id));

  // update = merge-upsert
  const upd = await u.update<E>("entries", "e1", { kcal: 111 } as Partial<E>);
  ok("update merges (kept fields)", upd.kcal === 111 && upd.day === "2026-07-10" && upd.kind === "food", upd);
  const upsert = await u.update<E>("entries", "new1", { user: "alice@example.com", kcal: 7 } as Partial<E>);
  ok("update upserts when absent", upsert.id === "new1" && upsert.kcal === 7);

  // delete
  await u.delete("entries", "e1");
  ok("delete removes", (await u.get<E>("entries", "e1")) === null);

  // batch (atomic multi-write)
  await u.batch([
    { kind: "create", collection: "entries", id: "bx1", data: { user: "alice@example.com", kcal: 1, day: "2026-07-20" } },
    { kind: "update", collection: "entries", id: "e3", patch: { kcal: 301 } },
    { kind: "delete", collection: "entries", id: "e2" },
  ]);
  ok("batch create", !!(await u.get<E>("entries", "bx1")));
  ok("batch update", (await u.get<E>("entries", "e3"))!.kcal === 301);
  ok("batch delete", (await u.get<E>("entries", "e2")) === null);

  // instance() scope is separate from any user
  await inst.create("settings", { key: "app_name", value: "Sate" }, "app_name");
  ok("instance get", (await inst.get<{ value: string }>("settings", "app_name"))!.value === "Sate");
  ok("instance not visible to forUser", (await u.get("settings", "app_name")) === null);

  console.log(`\nSQLite adapter contract: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("TEST CRASH:", e);
  process.exit(1);
});
