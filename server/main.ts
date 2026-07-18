// Sate self-host edition — Node/Hono host that mounts the SAME shared `@sate/core` API the cloud host
// mounts (buildApi), but over the local SQLite/proxy-auth/local-file platform. Replaces the PocketBase
// binary + pb_hooks. Only the platform + this host differ from cloud; every route lives in core/.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { buildApi } from "../core/src/api/index";
import { selfHostPlatform } from "./platform";

const WEB = process.env.SATE_WEB_DIR || "./web";
const platform = selfHostPlatform();
const app = new Hono();

// Origin guard (mirror of the cloud edge-secret): only requests routed through the trusted proxy —
// which injects the shared secret — may reach the app, closing the direct back door that would let a
// caller forge the trusted email header. Fail-open when unset (local dev). /health is exempt (probes).
const GUARD = process.env.SATE_PROXY_SECRET;
app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  if (GUARD && c.req.header("X-Sate-Proxy-Secret") !== GUARD) return c.json({ error: "forbidden" }, 403);
  await next();
});

app.get("/health", (c) => c.json({ ok: true, edition: "selfhost" }));

// Client bootstrap. mode:"proxy" tells the shared SPA there is no in-app login — identity comes from
// the Cloudflare-Access email header (the cloud host instead returns a `firebase` config here).
app.get("/config", (c) => c.json({ mode: "proxy", app_name: process.env.SATE_APP_NAME || "Sate" }));

// The shared core API. Self-host trusts a proxy-injected email header for identity (Cloudflare Access);
// the origin guard above ensures the header can only arrive through the proxy.
app.route(
  "/",
  buildApi(platform, {
    aiProvider: "google",
    aiModel: "gemini-2.5-flash",
    trustEmailHeader: process.env.AUTH_EMAIL_HEADER || "Cf-Access-Authenticated-User-Email",
  }),
);

// Static SPA (the shared core/src/web bundle) + SPA fallback.
app.use("/*", serveStatic({ root: WEB }));
app.get("*", serveStatic({ path: `${WEB}/index.html` }));

const port = Number(process.env.PORT || 8080);
serve({ fetch: app.fetch, port });
console.log(`sate self-host listening on :${port} (web ${WEB}, data ${process.env.SATE_DATA || "./pb_data"})`);
