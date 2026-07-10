# Sate

**Self-hosted AI calorie counting, by chat or photo.** Describe a meal ("two eggs and toast")
or snap a photo, and Sate estimates the calories + macros and logs them against your daily goal.

Sate is **bring-your-own-AI**: you supply your own **Claude, OpenAI, and/or Gemini** API keys,
and an admin panel lets you choose which provider + model handles each task. It's a single
small Docker image built on [PocketBase](https://pocketbase.io) — SQLite storage, a built-in
admin dashboard, and JavaScript hooks, with no external services.

Access is gated by **your auth proxy** — designed for [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
email allow-lists, but it works with anything that injects an authenticated-email header
(oauth2-proxy, Authelia, Authentik, …).

---

## Features

- 💬 **Log by chat** — natural-language meals parsed into items + calories + macros.
- 📷 **Log by photo** — point a vision model at your plate.
- 🎯 **Goals & daily ring** — calories and protein/carbs/fat vs your targets.
- 🧠 **AI recap** — a friendly daily summary + one practical tip.
- 🔀 **Multi-provider, per-function routing** — e.g. Gemini for photos, Claude for chat.
- 🔐 **Keys encrypted at rest** (AES-256-GCM); shown only by their last 4 characters.
- 👤 **Admin vs user roles**, both derived from the auth-proxy email.

## How the AI is configured

There are four **functions**, each independently routable to a provider + model in the Admin tab:

| Function | What it does | Needs vision? |
|----------|--------------|---------------|
| `vision_estimate` | Food **photo** → items + calories | ✅ |
| `text_parse` | Meal **text** → items + calories | — |
| `chat` | Conversational coaching / Q&A | — |
| `daily_summary` | End-of-day recap + tip | — |

Admins paste their own API keys and set the model id per function (free-text, so you can use
any model your key supports). Defaults are Claude models.

## Quick start (Docker)

```sh
# 1. A 32-character key that encrypts your provider API keys at rest
export APP_ENCRYPTION_KEY=$(openssl rand -hex 16)
export ADMIN_EMAILS=you@example.com   # who gets the Admin tab

docker run -d --name sate \
  -p 127.0.0.1:8090:8080 \
  -e APP_ENCRYPTION_KEY \
  -e ADMIN_EMAILS \
  -v $PWD/pb_data:/pb/pb_data \
  ghcr.io/datbird/sate:latest
```

Or with Compose: copy `.env.example` → `.env`, fill it in, then `docker compose up -d`.

Then put it behind your auth proxy (see below), open the app, go to **Admin**, add a key,
and start logging.

> **Bind to loopback.** Sate trusts the auth-proxy email header, so the container must only be
> reachable *through* the proxy. Always publish on `127.0.0.1` (as above) and point your tunnel
> at it — never expose port 8080 directly.

## Upgrading a running instance

If you build the image yourself, `scripts/redeploy.sh` rebuilds it and recreates the container
on the Docker host, reading the ports, volumes, env, labels and restart policy back off the
container that's already running:

```sh
./scripts/redeploy.sh
```

This matters because Sate keeps its database in the `pb_data` volume and encrypts your provider
API keys with `APP_ENCRYPTION_KEY`. Recreating the container without the same volume loses the
database; without the same key, the stored keys can't be decrypted. The script carries both
across rather than asking you to retype them, refuses to start a container that is missing
either, and rolls back to the previous container if the new one doesn't pass its healthcheck.

For the very first deploy there's nothing to copy from, so pass the settings explicitly:

```sh
APP_ENCRYPTION_KEY=$(openssl rand -hex 16) \
SATE_DATA=/srv/sate SATE_PORT=127.0.0.1:8090 ADMIN_EMAILS=you@example.com \
  ./scripts/redeploy.sh
```

Running the published image instead? Just `docker pull ghcr.io/datbird/sate:latest` and
recreate the container with the same `-v` and `APP_ENCRYPTION_KEY` as before.

## iOS app (optional)

`mobile/` is a [Capacitor](https://capacitorjs.com) shell that runs your Sate instance as a native
iOS app, so you get a home-screen icon, the camera for barcode scanning, and room for native
integrations like Apple Health later.

The shell loads your instance in a webview rather than bundling the SPA. Sate authenticates by
trusting an email header from your auth proxy and serves its API same-origin — bundling the
frontend would make every API call cross-origin, which the proxy answers with a login redirect
instead of data. Pointing the webview at the instance keeps the proxy's normal login flow working
with no server-side changes.

```sh
cd mobile
npm install
SATE_URL=https://sate.example.com \
SATE_AUTH_HOSTS=myteam.cloudflareaccess.com \
  npm run sync                                   # bake in your instance + auth-proxy hosts
npm run open                                     # opens Xcode
```

`SATE_URL` is read from the environment and written into the generated
`ios/App/App/capacitor.config.json`, which is gitignored — your instance URL never lands in the
repo. Build it in Xcode against your own Apple team and bundle identifier.

**`SATE_AUTH_HOSTS` is required if you use an auth proxy.** Capacitor's webview only navigates
within `SATE_URL`'s host and hands every other host to the system browser. Your proxy logs you in
on *its* domain (Cloudflare Access redirects to `<team>.cloudflareaccess.com`), so unless that host
is listed the login opens in Safari, the session cookie is stored in Safari, and the app itself
stays logged out. List every host the login flow touches, comma-separated; wildcards work
(`*.cloudflareaccess.com`).

## Configuration

All config is via environment variables:

| Variable | Required | Description |
|----------|:--------:|-------------|
| `APP_ENCRYPTION_KEY` | ✅ | Exactly 32 chars. Encrypts provider keys. `openssl rand -hex 16`. |
| `ADMIN_EMAILS` | ✅ | Comma-separated emails granted the Admin panel. |
| `AUTH_MODE` | — | `proxy` (default) or `apple`. See below. |
| `AUTH_EMAIL_HEADER` | — | `proxy` mode only. Header carrying the authenticated email. Default `Cf-Access-Authenticated-User-Email`. |
| `DEV_EMAIL` | — | **Local dev only** — impersonate this email with no proxy. Never set in prod. |
| `SUPERUSER_EMAIL` / `SUPERUSER_PASSWORD` | — | Auto-create the PocketBase dashboard superuser (`/_/`). |

### Choosing an auth mode

**`AUTH_MODE=proxy`** (the default) means Sate has no login of its own. An auth proxy in front of it
authenticates the user and injects their email as a header, which Sate trusts. This is why the
container must be published on loopback only — anything that can reach the origin directly can
forge that header and become any user.

**`AUTH_MODE=apple`** means Sate authenticates people itself, with Sign in with Apple against its
`users` collection. The proxy header is then **ignored entirely**, so the origin can be exposed
directly. Sate becomes its own security boundary.

Note the two are mutually exclusive by design, not stacked: if you leave an auth proxy in front of
`AUTH_MODE=apple`, users will be asked to log in twice.

## Putting it behind Cloudflare Access

1. Expose the container to a Cloudflare Tunnel (`cloudflared`) pointing at `http://127.0.0.1:8090`.
2. Create an **Access application** for the hostname and add an **allow policy** listing the
   emails permitted in.
3. Cloudflare injects `Cf-Access-Authenticated-User-Email` on every request; Sate reads it.
   Any allowed email whose address is in `ADMIN_EMAILS` gets the Admin tab.

Using a different proxy? Set `AUTH_EMAIL_HEADER` to whatever it injects (e.g. `X-Forwarded-Email`).

## Security model

- Sate does **not** run its own end-user login — it trusts the email header set by your proxy.
  That is safe **only** when the container is not directly reachable (loopback + tunnel).
- Provider API keys are encrypted at rest with `APP_ENCRYPTION_KEY` and never returned in full.
- All app data is read/written through privileged server hooks that scope every query to the
  caller's email; the raw PocketBase collection API is superuser-only.
- The built-in PocketBase dashboard at `/_/` has its own superuser login — keep it behind the
  same Access policy.

> Roadmap: optional cryptographic verification of the Cloudflare Access JWT
> (`Cf-Access-Jwt-Assertion`) for defense even if the loopback assumption is broken.

## Local development

```sh
cp .env.example .env      # set DEV_EMAIL + ADMIN_EMAILS to your email
./scripts/dev.sh          # downloads PocketBase, runs on http://127.0.0.1:8090
```

`DEV_EMAIL` stands in for the proxy header so you can use the app without Cloudflare. The script
generates a throwaway encryption key if you didn't set one.

## Architecture

```
pb_migrations/   SQLite schema as code (profiles, entries, providers, function_config)
pb_hooks/
  main.pb.js     custom /api/sate/* routes: identity, logging, chat, admin
  providers.js   Claude / OpenAI / Gemini adapters over $http.send
  functions.js   prompts, key encryption, per-function config resolution
pb_public/       framework-free SPA (chat log, history, admin) — served at /
Dockerfile       Alpine + PocketBase binary + the above
```

## License

MIT © datbird
