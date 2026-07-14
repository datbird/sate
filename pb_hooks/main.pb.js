/// <reference path="../pb_data/types.d.ts" />

// Route registrations only. PocketBase runs each handler in an isolated JSVM that CANNOT see
// this file's top-level scope, so every handler require()s the logic module at call time.
// (require caches, so this is cheap after the first call.) The static frontend is served
// automatically from ./pb_public.

// Origin guard (defense-in-depth) + cache-control, run before every request.
//
// Guard: Sate's proxy-mode identity trusts an email header that the auth proxy (Cloudflare Access)
// injects, which is only safe if the origin is reachable ONLY through that proxy. Full RS256
// verification of the Cf-Access-Jwt-Assertion isn't feasible inside PocketBase's JSVM (no RSA
// primitive), so the implementable equivalent is a proxy-injected shared secret: set SATE_PROXY_SECRET
// on the container AND have the edge (a Cloudflare Transform Rule on the hostname) add the matching
// X-Sate-Proxy-Secret header. Requests that bypass the proxy and hit the origin directly lack the
// header → 403, so a direct-to-origin request can't forge an identity header. Opt-in: when the env is
// unset the guard is a no-op (current behaviour). /api/health is exempt so the container healthcheck
// (loopback, no header) keeps working.
//
// Cache-control: PocketBase's static server sends only Last-Modified (no Cache-Control), so
// browsers/webviews heuristically cache index.html and can pin an OLD app.js?vN even after a hard
// refresh. no-cache forces a cheap conditional request (304 when unchanged) so a new deploy is picked
// up immediately.
routerUse((e) => {
  const p = (e.request && e.request.url && e.request.url.path) || "";
  let secret = "", mode = "enforce";
  try { secret = ($os && $os.getenv && $os.getenv("SATE_PROXY_SECRET")) || ""; } catch (_) {}
  // SATE_PROXY_GUARD=report logs whether the edge is injecting the header (a rollout aid) but blocks
  // nothing; anything else (default) enforces. Lets you confirm real traffic carries the header before
  // turning enforcement on, so you can't accidentally 403 every user at once.
  try { mode = (($os && $os.getenv && $os.getenv("SATE_PROXY_GUARD")) || "enforce").toLowerCase(); } catch (_) {}
  if (secret && p !== "/api/health") {
    let got = "";
    try { got = e.request.header.get("X-Sate-Proxy-Secret") || ""; } catch (_) {}
    // Constant-time compare, inlined: this middleware runs in an isolated JSVM that can't see this
    // file's top-level functions, so it must not call out to one.
    let diff = got.length ^ secret.length;
    for (let i = 0; i < got.length && i < secret.length; i++) diff |= got.charCodeAt(i) ^ secret.charCodeAt(i);
    const ok = diff === 0;
    if (mode === "report") {
      if (p.indexOf("/api/sate/") === 0) console.log("proxy-guard[report] " + (ok ? "header-OK" : "header-MISSING") + " " + p);
    } else if (!ok) {
      throw new ApiError(403, "forbidden", null);
    }
  }
  try {
    if (p.indexOf("/api/") !== 0) e.response.header().set("Cache-Control", "no-cache, must-revalidate");
  } catch (_) {}
  return e.next();
});

// Unauthenticated on purpose: the SPA needs to know which auth mode is active before it can log in.
routerAdd("GET", "/api/sate/auth-config", (e) => require(`${__hooks}/api.js`).authConfig(e));

routerAdd("GET", "/api/sate/me", (e) => require(`${__hooks}/api.js`).me(e));
routerAdd("POST", "/api/sate/log/text", (e) => require(`${__hooks}/api.js`).logText(e));
routerAdd("POST", "/api/sate/log/photo", (e) => require(`${__hooks}/api.js`).logPhoto(e));
routerAdd("POST", "/api/sate/log/barcode", (e) => require(`${__hooks}/api.js`).logBarcode(e));
routerAdd("POST", "/api/sate/log/activity", (e) => require(`${__hooks}/api.js`).logActivity(e));
routerAdd("POST", "/api/sate/log/heart-rate", (e) => require(`${__hooks}/api.js`).logHeartRate(e));
routerAdd("GET", "/api/sate/activities/search", (e) => require(`${__hooks}/api.js`).activitiesSearch(e));
routerAdd("GET", "/api/sate/feed", (e) => require(`${__hooks}/api.js`).feedPage(e));
routerAdd("GET", "/api/sate/foods/search", (e) => require(`${__hooks}/api.js`).foodsSearch(e));
routerAdd("POST", "/api/sate/log/food", (e) => require(`${__hooks}/api.js`).logFood(e));
routerAdd("POST", "/api/sate/foods/manual", (e) => require(`${__hooks}/api.js`).foodsManual(e));
routerAdd("GET", "/api/sate/foods/search-online", (e) => require(`${__hooks}/api.js`).foodsSearchOnline(e));
routerAdd("POST", "/api/sate/foods/web-candidate", (e) => require(`${__hooks}/api.js`).foodsWebCandidate(e));
routerAdd("POST", "/api/sate/foods/accept", (e) => require(`${__hooks}/api.js`).foodsAccept(e));
routerAdd("GET", "/api/sate/stats", (e) => require(`${__hooks}/api.js`).statsRange(e));
routerAdd("POST", "/api/sate/health/sync", (e) => require(`${__hooks}/api.js`).healthSync(e));
routerAdd("POST", "/api/sate/weight/log", (e) => require(`${__hooks}/api.js`).weightLog(e));
routerAdd("POST", "/api/sate/weight/sync", (e) => require(`${__hooks}/api.js`).weightSync(e));
routerAdd("GET", "/api/sate/weight", (e) => require(`${__hooks}/api.js`).weightGet(e));
routerAdd("GET", "/api/sate/weight/goals", (e) => require(`${__hooks}/api.js`).weightGoalsList(e));
routerAdd("POST", "/api/sate/weight/goals", (e) => require(`${__hooks}/api.js`).weightGoalSet(e));
routerAdd("DELETE", "/api/sate/weight/goals/{id}", (e) => require(`${__hooks}/api.js`).weightGoalDelete(e));
routerAdd("POST", "/api/sate/plan/compute", (e) => require(`${__hooks}/api.js`).planCompute(e));
routerAdd("POST", "/api/sate/nutritionist", (e) => require(`${__hooks}/api.js`).nutritionist(e));
routerAdd("POST", "/api/sate/second-opinion", (e) => require(`${__hooks}/api.js`).secondOpinion(e));
routerAdd("GET", "/api/sate/checkins/pending", (e) => require(`${__hooks}/api.js`).checkinsPending(e));
routerAdd("POST", "/api/sate/checkins/{id}/seen", (e) => require(`${__hooks}/api.js`).checkinSeen(e));
routerAdd("POST", "/api/sate/checkins/{id}/notified", (e) => require(`${__hooks}/api.js`).checkinNotified(e));
routerAdd("POST", "/api/sate/admin/checkins/run", (e) => require(`${__hooks}/api.js`).adminRunCheckins(e));
routerAdd("GET", "/api/sate/admin/backup", (e) => require(`${__hooks}/api.js`).adminGetBackup(e));
routerAdd("PUT", "/api/sate/admin/backup", (e) => require(`${__hooks}/api.js`).adminPutBackup(e));
routerAdd("POST", "/api/sate/admin/backup/test", (e) => require(`${__hooks}/api.js`).adminTestBackup(e));
routerAdd("POST", "/api/sate/admin/backup/run", (e) => require(`${__hooks}/api.js`).adminBackupNow(e));
routerAdd("GET", "/api/sate/admin/backup/list", (e) => require(`${__hooks}/api.js`).adminListBackups(e));
routerAdd("POST", "/api/sate/admin/backup/restore", (e) => require(`${__hooks}/api.js`).adminRestore(e));
routerAdd("POST", "/api/sate/admin/backup/flush", (e) => require(`${__hooks}/api.js`).adminFlushSync(e));
routerAdd("POST", "/api/sate/admin/backup/restore-mirror", (e) => require(`${__hooks}/api.js`).adminRestoreMirror(e));
routerAdd("POST", "/api/sate/admin/backup/local-now", (e) => require(`${__hooks}/api.js`).adminLocalBackupNow(e));
routerAdd("GET", "/api/sate/entries", (e) => require(`${__hooks}/api.js`).listEntries(e));
routerAdd("DELETE", "/api/sate/entries/{id}", (e) => require(`${__hooks}/api.js`).deleteEntry(e));
routerAdd("PATCH", "/api/sate/entries/{id}", (e) => require(`${__hooks}/api.js`).updateEntry(e));
routerAdd("PATCH", "/api/sate/goals", (e) => require(`${__hooks}/api.js`).setGoals(e));
routerAdd("GET", "/api/sate/day/summary", (e) => require(`${__hooks}/api.js`).daySummary(e));

routerAdd("GET", "/api/sate/admin/providers", (e) => require(`${__hooks}/api.js`).adminGetProviders(e));
routerAdd("PUT", "/api/sate/admin/providers", (e) => require(`${__hooks}/api.js`).adminPutProvider(e));
routerAdd("GET", "/api/sate/admin/models", (e) => require(`${__hooks}/api.js`).adminGetModels(e));
routerAdd("GET", "/api/sate/admin/functions", (e) => require(`${__hooks}/api.js`).adminGetFunctions(e));
routerAdd("PUT", "/api/sate/admin/functions", (e) => require(`${__hooks}/api.js`).adminPutFunction(e));
routerAdd("GET", "/api/sate/admin/usage", (e) => require(`${__hooks}/api.js`).adminGetUsage(e));
routerAdd("GET", "/api/sate/admin/limits", (e) => require(`${__hooks}/api.js`).adminGetLimits(e));
routerAdd("POST", "/api/sate/admin/limit", (e) => require(`${__hooks}/api.js`).adminSetLimit(e));
routerAdd("GET", "/api/sate/admin/prices", (e) => require(`${__hooks}/api.js`).adminGetPrices(e));
routerAdd("POST", "/api/sate/admin/price", (e) => require(`${__hooks}/api.js`).adminSetPrice(e));
routerAdd("GET", "/api/sate/admin/settings", (e) => require(`${__hooks}/api.js`).adminGetSettings(e));
routerAdd("PUT", "/api/sate/admin/settings", (e) => require(`${__hooks}/api.js`).adminPutSettings(e));
routerAdd("GET", "/api/sate/admin/users", (e) => require(`${__hooks}/api.js`).adminGetUsers(e));
routerAdd("PUT", "/api/sate/admin/users/role", (e) => require(`${__hooks}/api.js`).adminSetUserRole(e));
routerAdd("PUT", "/api/sate/admin/users/models", (e) => require(`${__hooks}/api.js`).adminSetUserModels(e));
routerAdd("GET", "/api/sate/admin/foods", (e) => require(`${__hooks}/api.js`).adminGetFoods(e));
routerAdd("PUT", "/api/sate/admin/foods", (e) => require(`${__hooks}/api.js`).adminPutFood(e));
routerAdd("POST", "/api/sate/admin/foods/estimate", (e) => require(`${__hooks}/api.js`).adminFoodEstimate(e));
routerAdd("POST", "/api/sate/admin/foods/barcode", (e) => require(`${__hooks}/api.js`).adminFoodBarcode(e));
routerAdd("DELETE", "/api/sate/admin/foods/{id}", (e) => require(`${__hooks}/api.js`).adminDeleteFood(e));
routerAdd("GET", "/api/sate/admin/activities", (e) => require(`${__hooks}/api.js`).adminGetActivities(e));
routerAdd("PUT", "/api/sate/admin/activities", (e) => require(`${__hooks}/api.js`).adminPutActivity(e));
routerAdd("DELETE", "/api/sate/admin/activities/{id}", (e) => require(`${__hooks}/api.js`).adminDeleteActivity(e));
routerAdd("GET", "/api/sate/admin/sources", (e) => require(`${__hooks}/api.js`).adminGetSources(e));
routerAdd("PUT", "/api/sate/admin/sources", (e) => require(`${__hooks}/api.js`).adminPutSource(e));
routerAdd("DELETE", "/api/sate/admin/sources/{id}", (e) => require(`${__hooks}/api.js`).adminDeleteSource(e));
routerAdd("GET", "/api/sate/admin/prompts", (e) => require(`${__hooks}/api.js`).adminGetPrompts(e));
routerAdd("PUT", "/api/sate/admin/prompts", (e) => require(`${__hooks}/api.js`).adminPutPrompt(e));
routerAdd("GET", "/api/sate/admin/lookup", (e) => require(`${__hooks}/api.js`).adminGetLookup(e));
routerAdd("PUT", "/api/sate/admin/lookup", (e) => require(`${__hooks}/api.js`).adminPutLookup(e));

// Proactive coach check-ins: analyze each opted-in user's recent logs and, when worthwhile, generate
// a check-in the app surfaces (in-app + a local notification). Runs every 3 hours so the per-user
// frequency (a few a day / daily / every couple of days) can be honored; each user is gated by their
// own min-gap and an "already-pending" short-circuit, and the whole job is a no-op when the admin's
// global check-ins toggle is off. Messages are picked up on the user's next app open.
cronAdd("sate_checkins", "0 */3 * * *", () => {
  try { require(`${__hooks}/api.js`).generateCheckins($app); } catch (err) { console.log("sate_checkins cron error:", err); }
});

// ---- live sync + scheduled backup ----
// Capture every create/update/delete and enqueue it for the remote mirror. Each hook callback runs
// in its OWN isolated JSVM (it can't see this file's top-level scope), so it must require the module
// and use injected globals ($app/require) directly — never a helper defined here. onLocalChange
// filters to the synced set and is a fast no-op unless live sync is on.
onRecordAfterCreateSuccess((e) => {
  try { require(`${__hooks}/backup.js`).onLocalChange(e.app, e.record, "upsert"); } catch (_) {}
  e.next();
});
onRecordAfterUpdateSuccess((e) => {
  try { require(`${__hooks}/backup.js`).onLocalChange(e.app, e.record, "upsert"); } catch (_) {}
  e.next();
});
onRecordAfterDeleteSuccess((e) => {
  try { require(`${__hooks}/backup.js`).onLocalChange(e.app, e.record, "delete"); } catch (_) {}
  e.next();
});

// Live-sync flush: drain the change queue to the remote every minute (no-op unless live sync is on
// and a destination is configured). A down remote just backlogs the queue until it recovers.
cronAdd("sate_sync_flush", "* * * * *", () => {
  try {
    const BK = require(`${__hooks}/backup.js`);
    if (!BK.syncLiveEnabled($app)) return;
    const cfg = BK.backupConfig($app);
    if (cfg.type) BK.flushQueue($app, cfg);
  } catch (err) { console.log("sate_sync_flush error:", err); }
});

// Nightly backups (03:30 UTC): a remote snapshot (if auto-backup is on) and/or a local full-DB zip
// (if local backups are on). Each is independent and guarded so one being off/failing doesn't stop
// the other.
cronAdd("sate_backup", "30 3 * * *", () => {
  const BK = require(`${__hooks}/backup.js`);
  try {
    if (BK.getSetting($app, "backup_auto") === "on") {
      const cfg = BK.backupConfig($app);
      if (cfg.type) BK.pushSnapshot($app, cfg, "scheduled");
    }
  } catch (err) { console.log("sate_backup remote error:", err); }
  try {
    if (BK.getSetting($app, "backup_local_enabled") === "on") BK.localBackupNow($app);
  } catch (err) { console.log("sate_backup local error:", err); }
});
