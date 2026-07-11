#!/bin/sh
set -e

# Fail fast if the encryption key is missing or the wrong length — provider keys can't be
# stored without it, and a late failure is confusing.
if [ -z "$APP_ENCRYPTION_KEY" ] || [ "${#APP_ENCRYPTION_KEY}" -ne 32 ]; then
  echo "FATAL: APP_ENCRYPTION_KEY must be exactly 32 characters (AES-256)." >&2
  echo "       Generate one with:  openssl rand -hex 16" >&2
  exit 1
fi

# PocketBase runs as the unprivileged `pb` user, not root. The data dir may be a host-mounted volume
# owned by root (e.g. from an older root-run image), so make it writable by pb before dropping.
mkdir -p /pb/pb_data
chown -R pb:pb /pb/pb_data 2>/dev/null || true

# Optionally provision the PocketBase superuser (the built-in /_/ dashboard) from env, as pb.
if [ -n "$SUPERUSER_EMAIL" ] && [ -n "$SUPERUSER_PASSWORD" ]; then
  su-exec pb /pb/pocketbase superuser upsert "$SUPERUSER_EMAIL" "$SUPERUSER_PASSWORD" || \
    echo "note: superuser upsert skipped (already exists or unsupported)" >&2
fi
# Drop the credentials from the environment so they aren't left readable in the long-lived server
# process (/proc/1/environ, `docker inspect`). The account persists in pb_data.
unset SUPERUSER_PASSWORD SUPERUSER_EMAIL

exec su-exec pb /pb/pocketbase serve --http=0.0.0.0:8080
