/// <reference path="../pb_data/types.d.ts" />

// Sate — live-sync change queue. Event hooks enqueue every create/update/delete on the synced
// collections here; a flush drains the queue to the remote mirror (so your writes never block on the
// network and survive remote outages — a down remote just means the queue grows and catches up).
//   sync_queue: coll (collection name), rid (record id), op ("upsert" | "delete").

migrate(
  (app) => {
    if (collExists(app, "sync_queue")) return;
    const c = new Collection({
      type: "base",
      name: "sync_queue",
      fields: [
        { type: "text", name: "coll", required: true, max: 100 },
        { type: "text", name: "rid", required: true, max: 100 },
        { type: "text", name: "op", required: true, max: 10 },
        { type: "autodate", name: "created", onCreate: true },
      ],
      indexes: [
        "CREATE INDEX idx_syncq_created ON sync_queue (created)",
        "CREATE INDEX idx_syncq_rec ON sync_queue (coll, rid)",
      ],
    });
    app.save(c);
  },
  (app) => {
    try { app.delete(app.findCollectionByNameOrId("sync_queue")); } catch (_) {}
  }
);

function collExists(app, name) {
  try { app.findCollectionByNameOrId(name); return true; } catch (_) { return false; }
}
