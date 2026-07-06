#!/bin/sh
set -e

# Fail fast if the encryption key is missing or the wrong length — provider keys can't be
# stored without it, and a late failure is confusing.
if [ -z "$APP_ENCRYPTION_KEY" ] || [ "${#APP_ENCRYPTION_KEY}" -ne 32 ]; then
  echo "FATAL: APP_ENCRYPTION_KEY must be exactly 32 characters (AES-256)." >&2
  echo "       Generate one with:  openssl rand -hex 16" >&2
  exit 1
fi

# Optionally provision the PocketBase superuser (the built-in /_/ dashboard) from env.
if [ -n "$SUPERUSER_EMAIL" ] && [ -n "$SUPERUSER_PASSWORD" ]; then
  /pb/pocketbase superuser upsert "$SUPERUSER_EMAIL" "$SUPERUSER_PASSWORD" || \
    echo "note: superuser upsert skipped (already exists or unsupported)" >&2
fi

exec /pb/pocketbase serve --http=0.0.0.0:8080
