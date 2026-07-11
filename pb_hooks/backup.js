/// <reference path="../pb_data/types.d.ts" />

// Sate — external backup / restore. Serializes the instance's data into a single JSON snapshot and
// stores it on an EXTERNAL server (another PocketBase, or Firebase/Firestore), and restores from one.
// This is a backup channel, not a live mirror: Sate still runs on its own embedded PocketBase; these
// just push/pull point-in-time snapshots so you can back up off-box and restore onto a fresh instance.

const F = require(`${__hooks}/functions.js`);

// Collections included in a snapshot — user data + config + reference tables. Excludes system/auth
// collections and transient counters (ai_usage). `settings` carries app config; on restore the
// backup_* keys are preserved so a restore can never sever the link to the backup server.
const SNAPSHOT_COLLECTIONS = [
  "profiles", "entries", "measurements", "weight_goals", "checkins",
  "foods", "activities", "sources", "function_config", "providers",
  "ai_prices", "ai_limits", "settings",
];
const SYS_FIELDS = { id: 1, created: 1, updated: 1, collectionId: 1, collectionName: 1, expand: 1 };
const SNAPSHOT_COLL_NAME = "sate_snapshots";

function nowIso() { return new Date().toISOString(); }

// ---- local export / import -------------------------------------------------------------------

function exportSnapshot(app) {
  const out = { version: 1, app: "sate", created: nowIso(), collections: {} };
  for (const name of SNAPSHOT_COLLECTIONS) {
    let recs = [];
    try { recs = app.findAllRecords(name); } catch (_) { continue; }
    let rows = recs.map((r) => r.publicExport());
    // Never ship the local backup-target credentials / sync bookkeeping off-box: a restore keeps the
    // live instance's backup_* keys anyway (see importSnapshot), so exporting them only leaks secrets.
    if (name === "settings") rows = rows.filter((row) => !isLocalOnlySetting(String(row.key || "")));
    out.collections[name] = rows;
  }
  return out;
}

// Replace each collection's rows with the snapshot's. Destructive by design (a restore). For the
// `settings` collection, backup_* keys are kept from the CURRENT instance so the connection to the
// backup server survives the restore.
function importSnapshot(app, snapshot) {
  if (!snapshot || !snapshot.collections) throw new Error("invalid snapshot");
  const report = {};
  for (const name of SNAPSHOT_COLLECTIONS) {
    const rows = snapshot.collections[name];
    if (!Array.isArray(rows)) continue;
    let coll;
    try { coll = app.findCollectionByNameOrId(name); } catch (_) { continue; }

    if (name === "settings") {
      // Merge, not replace: keep the live backup_* keys; upsert everything else by key.
      const keep = {};
      try { app.findAllRecords("settings").forEach((r) => { const k = r.getString("key"); if (k.indexOf("backup_") === 0) keep[k] = true; }); } catch (_) {}
      let n = 0;
      for (const row of rows) {
        const key = row.key; if (!key || keep[key]) continue;
        let rec;
        try { rec = app.findFirstRecordByFilter("settings", "key = {:k}", { k: key }); }
        catch (_) { rec = new Record(coll); rec.set("key", key); }
        rec.set("value", row.value != null ? String(row.value) : "");
        app.save(rec); n++;
      }
      report[name] = n;
      continue;
    }

    // Replace: delete existing, recreate from the snapshot's field data (fresh ids — Sate's model is
    // keyed by user_email/natural fields, not cross-collection record-id relations). The delete+recreate
    // runs in ONE transaction so a mid-restore failure (schema drift, a unique collision, a required
    // field) rolls the whole collection back to its original rows instead of silently leaving it
    // half-emptied — and the failure is reported, not swallowed as a successful-looking partial count.
    try {
      let n = 0;
      app.runInTransaction((tx) => {
        tx.findAllRecords(name).forEach((r) => tx.delete(r));
        for (const row of rows) {
          const rec = new Record(coll);
          for (const k in row) { if (SYS_FIELDS[k]) continue; try { rec.set(k, row[k]); } catch (_) {} }
          tx.save(rec); n++;
        }
      });
      report[name] = n;
    } catch (err) {
      // Transaction rolled back — the collection's original rows are intact. Surface the failure.
      report[name] = { restored: 0, expected: rows.length, error: String((err && err.message) || err) };
    }
  }
  return report;
}

// ---- config (encrypted secrets live in the settings collection) ------------------------------

function getSetting(app, key) {
  try { return app.findFirstRecordByFilter("settings", "key = {:k}", { k: key }).getString("value"); }
  catch (_) { return ""; }
}
function setSetting(app, key, value) {
  let rec;
  try { rec = app.findFirstRecordByFilter("settings", "key = {:k}", { k: key }); }
  catch (_) { rec = new Record(app.findCollectionByNameOrId("settings")); rec.set("key", key); }
  rec.set("value", value == null ? "" : String(value));
  app.save(rec);
}
function dec(v) { try { return v ? F.decryptKey(v) : ""; } catch (_) { return ""; } }

// The saved target config (secrets decrypted for use). type = "" | "pocketbase" | "firebase".
function backupConfig(app) {
  return {
    type: getSetting(app, "backup_type"),
    auto: getSetting(app, "backup_auto") === "on",
    pb: { url: getSetting(app, "backup_pb_url"), email: getSetting(app, "backup_pb_email"), password: dec(getSetting(app, "backup_pb_password_enc")) },
    fb: { project: getSetting(app, "backup_fb_project"), apiKey: dec(getSetting(app, "backup_fb_apikey_enc")), email: getSetting(app, "backup_fb_email"), password: dec(getSetting(app, "backup_fb_password_enc")) },
  };
}

// ---- PocketBase target -----------------------------------------------------------------------

function pbAuth(cfg) {
  const url = cfg.pb.url.replace(/\/+$/, "");
  const res = $http.send({
    url: url + "/api/collections/_superusers/auth-with-password",
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: cfg.pb.email, password: cfg.pb.password }), timeout: 30,
  });
  if (res.statusCode >= 300) throw new Error("PocketBase auth failed (" + res.statusCode + ")");
  return { url: url, token: res.json.token };
}
function pbEnsureCollection(s) {
  const get = $http.send({ url: s.url + "/api/collections/" + SNAPSHOT_COLL_NAME, method: "GET", headers: { Authorization: s.token } });
  if (get.statusCode < 300) return;
  const create = $http.send({
    url: s.url + "/api/collections", method: "POST",
    headers: { "content-type": "application/json", Authorization: s.token },
    body: JSON.stringify({ name: SNAPSHOT_COLL_NAME, type: "base", fields: [
      { type: "text", name: "label", max: 200 },
      { type: "json", name: "data", maxSize: 60000000 },
      { type: "autodate", name: "created", onCreate: true },
    ] }),
  });
  if (create.statusCode >= 300) throw new Error("could not create " + SNAPSHOT_COLL_NAME + " on target (" + create.statusCode + ")");
}
function pbPush(cfg, snapshot, label) {
  const s = pbAuth(cfg); pbEnsureCollection(s);
  const res = $http.send({
    url: s.url + "/api/collections/" + SNAPSHOT_COLL_NAME + "/records", method: "POST",
    headers: { "content-type": "application/json", Authorization: s.token },
    body: JSON.stringify({ label: label || ("sate-" + nowIso()), data: snapshot }), timeout: 120,
  });
  if (res.statusCode >= 300) throw new Error("push failed (" + res.statusCode + ")");
  return { id: res.json.id };
}
function pbList(cfg) {
  const s = pbAuth(cfg);
  const res = $http.send({ url: s.url + "/api/collections/" + SNAPSHOT_COLL_NAME + "/records?sort=-created&perPage=50&fields=id,label,created", method: "GET", headers: { Authorization: s.token } });
  if (res.statusCode >= 300) return [];
  return (res.json.items || []).map((r) => ({ id: r.id, label: r.label, created: r.created }));
}
function pbFetch(cfg, id) {
  const s = pbAuth(cfg);
  const res = $http.send({ url: s.url + "/api/collections/" + SNAPSHOT_COLL_NAME + "/records/" + id, method: "GET", headers: { Authorization: s.token } });
  if (res.statusCode >= 300) throw new Error("fetch failed (" + res.statusCode + ")");
  return res.json.data;
}

// ---- Firebase / Firestore target (Identity Toolkit sign-in → Firestore REST) ------------------

function fbAuth(cfg) {
  const res = $http.send({
    url: "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + encodeURIComponent(cfg.fb.apiKey),
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: cfg.fb.email, password: cfg.fb.password, returnSecureToken: true }), timeout: 30,
  });
  if (res.statusCode >= 300) throw new Error("Firebase auth failed (" + res.statusCode + ")");
  return { token: res.json.idToken, base: "https://firestore.googleapis.com/v1/projects/" + cfg.fb.project + "/databases/(default)/documents" };
}
function fbPush(cfg, snapshot, label) {
  const s = fbAuth(cfg);
  const doc = { fields: { label: { stringValue: label || ("sate-" + nowIso()) }, created: { timestampValue: nowIso() }, data: { stringValue: JSON.stringify(snapshot) } } };
  const res = $http.send({ url: s.base + "/" + SNAPSHOT_COLL_NAME, method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + s.token }, body: JSON.stringify(doc), timeout: 120 });
  if (res.statusCode >= 300) throw new Error("Firestore push failed (" + res.statusCode + ") — a snapshot field is capped at 1MB; large instances may exceed it");
  const name = res.json.name || ""; return { id: name.split("/").pop() };
}
function fbList(cfg) {
  const s = fbAuth(cfg);
  const res = $http.send({ url: s.base + "/" + SNAPSHOT_COLL_NAME + "?pageSize=50", method: "GET", headers: { Authorization: "Bearer " + s.token } });
  if (res.statusCode >= 300) return [];
  const docs = (res.json.documents || []).map((d) => ({
    id: (d.name || "").split("/").pop(),
    label: d.fields && d.fields.label ? d.fields.label.stringValue : "",
    created: d.fields && d.fields.created ? d.fields.created.timestampValue : "",
  }));
  docs.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
  return docs;
}
function fbFetch(cfg, id) {
  const s = fbAuth(cfg);
  const res = $http.send({ url: s.base + "/" + SNAPSHOT_COLL_NAME + "/" + id, method: "GET", headers: { Authorization: "Bearer " + s.token } });
  if (res.statusCode >= 300) throw new Error("Firestore fetch failed (" + res.statusCode + ")");
  return JSON.parse(res.json.fields.data.stringValue);
}

// ---- unified target dispatch -----------------------------------------------------------------

function testTarget(app, cfg) {
  if (cfg.type === "pocketbase") { const s = pbAuth(cfg); pbEnsureCollection(s); return { ok: true }; }
  if (cfg.type === "firebase") { fbAuth(cfg); return { ok: true }; }
  throw new Error("no backup target configured");
}
function pushSnapshot(app, cfg, label) {
  const snap = exportSnapshot(app);
  const r = cfg.type === "firebase" ? fbPush(cfg, snap, label) : pbPush(cfg, snap, label);
  try { setSetting(app, "backup_last_at", nowIso()); setSetting(app, "backup_last_status", "ok"); } catch (_) {}
  const count = Object.keys(snap.collections).reduce((a, k) => a + (snap.collections[k] || []).length, 0);
  return { id: r.id, records: count };
}
function listSnapshots(app, cfg) { return cfg.type === "firebase" ? fbList(cfg) : pbList(cfg); }
function restoreSnapshot(app, cfg, id) {
  const snap = cfg.type === "firebase" ? fbFetch(cfg, id) : pbFetch(cfg, id);
  return importSnapshot(app, snap);
}

// ---- live sync: one-way local → remote mirror (record-level) ---------------------------------
// The local instance stays the source of truth; every change is mirrored into a remote `sate_mirror`
// collection (PocketBase) or Firestore collection, keyed by (coll, rid). Enqueue-then-flush so user
// writes never block on the network and a down remote just backlogs the queue.

const MIRROR_COLL = "sate_mirror";
const FLUSH_LIMIT = 300;

function syncLiveEnabled(app) { return getSetting(app, "sync_live") === "on"; }

// Local operational bookkeeping (sync/backup timestamps + the encrypted backup-target credentials)
// that lives in the `settings` collection but must NEVER mirror: it's per-instance state, and
// mirroring `sync_last_at` would re-enqueue itself on every flush — an endless per-minute loop.
function isLocalOnlySetting(key) {
  return key.indexOf("sync_") === 0 || key.indexOf("backup_") === 0;
}

// Called from the record event hooks. Enqueue only when live sync is on and it's a synced collection.
function onLocalChange(app, record, op) {
  try {
    if (!syncLiveEnabled(app)) return;
    const coll = record.collection().name;
    if (SNAPSHOT_COLLECTIONS.indexOf(coll) === -1) return;
    // Skip local-only settings so flushQueue's own sync_last_at write can't re-trigger a flush.
    if (coll === "settings" && isLocalOnlySetting(record.getString("key"))) return;
    const q = new Record(app.findCollectionByNameOrId("sync_queue"));
    q.set("coll", coll); q.set("rid", record.id); q.set("op", op === "delete" ? "delete" : "upsert");
    app.save(q);
  } catch (_) {}
}

// -- PocketBase mirror --
function pbEnsureMirror(s) {
  const get = $http.send({ url: s.url + "/api/collections/" + MIRROR_COLL, method: "GET", headers: { Authorization: s.token } });
  if (get.statusCode < 300) return;
  const res = $http.send({
    url: s.url + "/api/collections", method: "POST",
    headers: { "content-type": "application/json", Authorization: s.token },
    body: JSON.stringify({ name: MIRROR_COLL, type: "base", fields: [
      { type: "text", name: "coll", max: 100 }, { type: "text", name: "rid", max: 100 },
      { type: "json", name: "data", maxSize: 5000000 },
    ], indexes: ["CREATE UNIQUE INDEX idx_satemirror ON " + MIRROR_COLL + " (coll, rid)"] }),
  });
  if (res.statusCode >= 300) throw new Error("could not create " + MIRROR_COLL + " on target (" + res.statusCode + ")");
}
function pbMirrorFind(s, coll, rid) {
  const res = $http.send({ url: s.url + "/api/collections/" + MIRROR_COLL + "/records?perPage=1&filter=" + encodeURIComponent("coll='" + coll + "' && rid='" + rid + "'"), method: "GET", headers: { Authorization: s.token } });
  if (res.statusCode >= 300) return null;
  const items = res.json.items || [];
  return items.length ? items[0].id : null;
}
function pbMirrorUpsert(s, coll, rid, data) {
  const id = pbMirrorFind(s, coll, rid);
  const body = JSON.stringify({ coll: coll, rid: rid, data: data });
  const res = id
    ? $http.send({ url: s.url + "/api/collections/" + MIRROR_COLL + "/records/" + id, method: "PATCH", headers: { "content-type": "application/json", Authorization: s.token }, body: body })
    : $http.send({ url: s.url + "/api/collections/" + MIRROR_COLL + "/records", method: "POST", headers: { "content-type": "application/json", Authorization: s.token }, body: body });
  if (res.statusCode >= 300) throw new Error("mirror upsert failed (" + res.statusCode + ")");
}
function pbMirrorDelete(s, coll, rid) {
  const id = pbMirrorFind(s, coll, rid);
  if (!id) return;
  $http.send({ url: s.url + "/api/collections/" + MIRROR_COLL + "/records/" + id, method: "DELETE", headers: { Authorization: s.token } });
}

// -- Firebase mirror --
function fbDocId(coll, rid) { return coll + "__" + rid; }
function fbMirrorUpsert(s, coll, rid, data) {
  const doc = { fields: { coll: { stringValue: coll }, rid: { stringValue: rid }, data: { stringValue: JSON.stringify(data) } } };
  const res = $http.send({ url: s.base + "/" + MIRROR_COLL + "/" + fbDocId(coll, rid), method: "PATCH", headers: { "content-type": "application/json", Authorization: "Bearer " + s.token }, body: JSON.stringify(doc) });
  if (res.statusCode >= 300) throw new Error("Firestore mirror upsert failed (" + res.statusCode + ")");
}
function fbMirrorDelete(s, coll, rid) {
  $http.send({ url: s.base + "/" + MIRROR_COLL + "/" + fbDocId(coll, rid), method: "DELETE", headers: { Authorization: "Bearer " + s.token } });
}

// Drain the queue to the remote. Coalesces multiple edits of the same record; a delete wins.
function flushQueue(app, cfg) {
  if (!cfg.type) return { flushed: 0, remaining: 0 };
  let rows = [];
  try { rows = app.findRecordsByFilter("sync_queue", "id != ''", "created", FLUSH_LIMIT, 0, {}); } catch (_) { return { flushed: 0, remaining: 0 }; }
  if (!rows.length) return { flushed: 0, remaining: 0 };

  // Coalesce by (coll,rid): last op wins; collect the queue-row ids to clear on success.
  const byKey = {};
  for (const r of rows) {
    const key = r.getString("coll") + " " + r.getString("rid");
    const e = byKey[key] || (byKey[key] = { coll: r.getString("coll"), rid: r.getString("rid"), op: "upsert", ids: [] });
    e.op = r.getString("op"); e.ids.push(r.id);
  }
  const s = cfg.type === "firebase" ? fbAuth(cfg) : pbAuth(cfg);
  if (cfg.type === "pocketbase") pbEnsureMirror(s);

  let flushed = 0;
  for (const key in byKey) {
    const e = byKey[key];
    try {
      if (e.op === "delete") {
        cfg.type === "firebase" ? fbMirrorDelete(s, e.coll, e.rid) : pbMirrorDelete(s, e.coll, e.rid);
      } else {
        let rec = null; try { rec = app.findRecordById(e.coll, e.rid); } catch (_) {}
        if (rec) { const data = rec.publicExport();
          cfg.type === "firebase" ? fbMirrorUpsert(s, e.coll, e.rid, data) : pbMirrorUpsert(s, e.coll, e.rid, data);
        } else { cfg.type === "firebase" ? fbMirrorDelete(s, e.coll, e.rid) : pbMirrorDelete(s, e.coll, e.rid); }
      }
      for (const id of e.ids) { try { app.delete(app.findRecordById("sync_queue", id)); } catch (_) {} }
      flushed++;
    } catch (_) { /* leave queued for the next flush (remote may be down) */ }
  }
  let remaining = 0; try { remaining = app.countRecords("sync_queue"); } catch (_) {}
  if (flushed) { try { setSetting(app, "sync_last_at", nowIso()); } catch (_) {} }
  return { flushed: flushed, remaining: remaining };
}

// Seed the remote when live sync is first turned on: enqueue every existing record as an upsert.
function initialMirror(app) {
  let n = 0;
  const coll = app.findCollectionByNameOrId("sync_queue");
  for (const name of SNAPSHOT_COLLECTIONS) {
    let recs = []; try { recs = app.findAllRecords(name); } catch (_) { continue; }
    for (const r of recs) {
      // Same exclusion as onLocalChange: never seed local-only settings into the mirror.
      if (name === "settings" && isLocalOnlySetting(r.getString("key"))) continue;
      const q = new Record(coll); q.set("coll", name); q.set("rid", r.id); q.set("op", "upsert"); app.save(q); n++;
    }
  }
  return n;
}

// Rebuild local data from the remote mirror (a live-mirror restore, distinct from a snapshot restore).
function restoreFromMirror(app, cfg) {
  const collections = {};
  if (cfg.type === "firebase") {
    const s = fbAuth(cfg); let pageToken = "";
    do {
      const res = $http.send({ url: s.base + "/" + MIRROR_COLL + "?pageSize=300" + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""), method: "GET", headers: { Authorization: "Bearer " + s.token } });
      if (res.statusCode >= 300) break;
      for (const d of (res.json.documents || [])) {
        const c = d.fields.coll.stringValue, data = JSON.parse(d.fields.data.stringValue);
        (collections[c] || (collections[c] = [])).push(data);
      }
      pageToken = res.json.nextPageToken || "";
    } while (pageToken);
  } else {
    const s = pbAuth(cfg); let page = 1;
    for (;;) {
      const res = $http.send({ url: s.url + "/api/collections/" + MIRROR_COLL + "/records?perPage=500&page=" + page, method: "GET", headers: { Authorization: s.token } });
      if (res.statusCode >= 300) break;
      const items = res.json.items || [];
      for (const it of items) (collections[it.coll] || (collections[it.coll] = [])).push(it.data);
      if (page >= (res.json.totalPages || 1)) break;
      page++;
    }
  }
  return importSnapshot(app, { collections: collections });
}

// ---- local-file DB backups (PocketBase native zip of the whole pb_data) ----------------------
// Writes a full-DB zip via PocketBase's own backup engine. Backups land in pb_data/backups (which is
// host-mounted, so they're reachable off-container); an optional custom directory is also supported.

const PB_BACKUP_DIR = "/pb/pb_data/backups";
function localDir(app) { return (getSetting(app, "backup_local_dir") || PB_BACKUP_DIR).replace(/\/+$/, ""); }
function localKeep(app) { const n = parseInt(getSetting(app, "backup_local_keep") || "14", 10); return n > 0 ? n : 14; }

function listLocalBackups(app) {
  const dir = localDir(app);
  const out = [];
  try {
    const entries = $os.readDir(dir);
    for (const e of entries) {
      const name = typeof e.name === "function" ? e.name() : e.name;
      if (!/^sate-backup-.*\.zip$/.test(name)) continue;
      let size = 0; try { const st = $os.stat(dir + "/" + name); size = typeof st.size === "function" ? st.size() : st.size; } catch (_) {}
      out.push({ name: name, size: Number(size) || 0 });
    }
  } catch (_) {}
  out.sort((a, b) => b.name.localeCompare(a.name)); // newest first (timestamped names)
  return out;
}

function pruneLocalBackups(app) {
  const dir = localDir(app), keep = localKeep(app);
  const files = listLocalBackups(app);
  for (let i = keep; i < files.length; i++) { try { $os.remove(dir + "/" + files[i].name); } catch (_) {} }
}

// Create a full-DB zip. PocketBase writes it to pb_data/backups; if a different dir is configured,
// move it there. Returns { name, path }.
function localBackupNow(app) {
  const name = "sate-backup-" + nowIso().replace(/[:.]/g, "-") + ".zip";
  app.createBackup(new Context(), name); // → PB_BACKUP_DIR/name (createBackup needs a context.Context)
  const src = PB_BACKUP_DIR + "/" + name;
  const dir = localDir(app);
  let path = src;
  if (dir !== PB_BACKUP_DIR) {
    try { $os.mkdirAll(dir, 0755); } catch (_) {}
    try { const data = $os.readFile(src); $os.writeFile(dir + "/" + name, data, 0644); $os.remove(src); path = dir + "/" + name; }
    catch (err) { throw new Error("backup created at " + src + " but couldn't move to " + dir + ": " + (err.message || err)); }
  }
  try { pruneLocalBackups(app); } catch (_) {}
  try { setSetting(app, "backup_local_last_at", nowIso()); } catch (_) {}
  return { name: name, path: path };
}

module.exports = {
  SNAPSHOT_COLLECTIONS, backupConfig, getSetting, setSetting,
  exportSnapshot, importSnapshot, testTarget, pushSnapshot, listSnapshots, restoreSnapshot,
  syncLiveEnabled, onLocalChange, flushQueue, initialMirror, restoreFromMirror,
  localBackupNow, listLocalBackups, PB_BACKUP_DIR,
};
