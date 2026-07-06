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

## Configuration

All config is via environment variables:

| Variable | Required | Description |
|----------|:--------:|-------------|
| `APP_ENCRYPTION_KEY` | ✅ | Exactly 32 chars. Encrypts provider keys. `openssl rand -hex 16`. |
| `ADMIN_EMAILS` | ✅ | Comma-separated emails granted the Admin panel. |
| `AUTH_EMAIL_HEADER` | — | Header carrying the authenticated email. Default `Cf-Access-Authenticated-User-Email`. |
| `DEV_EMAIL` | — | **Local dev only** — impersonate this email with no proxy. Never set in prod. |
| `SUPERUSER_EMAIL` / `SUPERUSER_PASSWORD` | — | Auto-create the PocketBase dashboard superuser (`/_/`). |

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
