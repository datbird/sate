/// <reference path="../pb_data/types.d.ts" />

// Route registrations only. PocketBase runs each handler in an isolated JSVM that CANNOT see
// this file's top-level scope, so every handler require()s the logic module at call time.
// (require caches, so this is cheap after the first call.) The static frontend is served
// automatically from ./pb_public.

// Unauthenticated on purpose: the SPA needs to know which auth mode is active before it can log in.
routerAdd("GET", "/api/sate/auth-config", (e) => require(`${__hooks}/api.js`).authConfig(e));

routerAdd("GET", "/api/sate/me", (e) => require(`${__hooks}/api.js`).me(e));
routerAdd("POST", "/api/sate/log/text", (e) => require(`${__hooks}/api.js`).logText(e));
routerAdd("POST", "/api/sate/log/photo", (e) => require(`${__hooks}/api.js`).logPhoto(e));
routerAdd("POST", "/api/sate/log/barcode", (e) => require(`${__hooks}/api.js`).logBarcode(e));
routerAdd("POST", "/api/sate/chat", (e) => require(`${__hooks}/api.js`).chat(e));
routerAdd("POST", "/api/sate/log/activity", (e) => require(`${__hooks}/api.js`).logActivity(e));
routerAdd("POST", "/api/sate/log/heart-rate", (e) => require(`${__hooks}/api.js`).logHeartRate(e));
routerAdd("GET", "/api/sate/activities/search", (e) => require(`${__hooks}/api.js`).activitiesSearch(e));
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
routerAdd("GET", "/api/sate/entries", (e) => require(`${__hooks}/api.js`).listEntries(e));
routerAdd("DELETE", "/api/sate/entries/{id}", (e) => require(`${__hooks}/api.js`).deleteEntry(e));
routerAdd("PATCH", "/api/sate/entries/{id}", (e) => require(`${__hooks}/api.js`).updateEntry(e));
routerAdd("POST", "/api/sate/entries/{id}/web-lookup", (e) => require(`${__hooks}/api.js`).webLookupEntry(e));
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
