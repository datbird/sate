/// <reference path="../pb_data/types.d.ts" />

// Route registrations only. PocketBase runs each handler in an isolated JSVM that CANNOT see
// this file's top-level scope, so every handler require()s the logic module at call time.
// (require caches, so this is cheap after the first call.) The static frontend is served
// automatically from ./pb_public.

routerAdd("GET", "/api/sate/me", (e) => require(`${__hooks}/api.js`).me(e));
routerAdd("POST", "/api/sate/log/text", (e) => require(`${__hooks}/api.js`).logText(e));
routerAdd("POST", "/api/sate/log/photo", (e) => require(`${__hooks}/api.js`).logPhoto(e));
routerAdd("POST", "/api/sate/log/barcode", (e) => require(`${__hooks}/api.js`).logBarcode(e));
routerAdd("POST", "/api/sate/chat", (e) => require(`${__hooks}/api.js`).chat(e));
routerAdd("GET", "/api/sate/entries", (e) => require(`${__hooks}/api.js`).listEntries(e));
routerAdd("DELETE", "/api/sate/entries/{id}", (e) => require(`${__hooks}/api.js`).deleteEntry(e));
routerAdd("POST", "/api/sate/entries/{id}/web-lookup", (e) => require(`${__hooks}/api.js`).webLookupEntry(e));
routerAdd("PATCH", "/api/sate/goals", (e) => require(`${__hooks}/api.js`).setGoals(e));
routerAdd("GET", "/api/sate/day/summary", (e) => require(`${__hooks}/api.js`).daySummary(e));

routerAdd("GET", "/api/sate/admin/providers", (e) => require(`${__hooks}/api.js`).adminGetProviders(e));
routerAdd("PUT", "/api/sate/admin/providers", (e) => require(`${__hooks}/api.js`).adminPutProvider(e));
routerAdd("GET", "/api/sate/admin/models", (e) => require(`${__hooks}/api.js`).adminGetModels(e));
routerAdd("GET", "/api/sate/admin/functions", (e) => require(`${__hooks}/api.js`).adminGetFunctions(e));
routerAdd("PUT", "/api/sate/admin/functions", (e) => require(`${__hooks}/api.js`).adminPutFunction(e));
routerAdd("GET", "/api/sate/admin/settings", (e) => require(`${__hooks}/api.js`).adminGetSettings(e));
routerAdd("PUT", "/api/sate/admin/settings", (e) => require(`${__hooks}/api.js`).adminPutSettings(e));
routerAdd("GET", "/api/sate/admin/users", (e) => require(`${__hooks}/api.js`).adminGetUsers(e));
routerAdd("PUT", "/api/sate/admin/users/role", (e) => require(`${__hooks}/api.js`).adminSetUserRole(e));
routerAdd("GET", "/api/sate/admin/foods", (e) => require(`${__hooks}/api.js`).adminGetFoods(e));
routerAdd("PUT", "/api/sate/admin/foods", (e) => require(`${__hooks}/api.js`).adminPutFood(e));
routerAdd("DELETE", "/api/sate/admin/foods/{id}", (e) => require(`${__hooks}/api.js`).adminDeleteFood(e));
routerAdd("GET", "/api/sate/admin/sources", (e) => require(`${__hooks}/api.js`).adminGetSources(e));
routerAdd("PUT", "/api/sate/admin/sources", (e) => require(`${__hooks}/api.js`).adminPutSource(e));
routerAdd("DELETE", "/api/sate/admin/sources/{id}", (e) => require(`${__hooks}/api.js`).adminDeleteSource(e));
routerAdd("GET", "/api/sate/admin/prompts", (e) => require(`${__hooks}/api.js`).adminGetPrompts(e));
routerAdd("PUT", "/api/sate/admin/prompts", (e) => require(`${__hooks}/api.js`).adminPutPrompt(e));
routerAdd("GET", "/api/sate/admin/lookup", (e) => require(`${__hooks}/api.js`).adminGetLookup(e));
routerAdd("PUT", "/api/sate/admin/lookup", (e) => require(`${__hooks}/api.js`).adminPutLookup(e));
