#!/bin/sh
# Rebuild the Sate image and recreate the container, reusing the running container's
# ports, volumes, env, labels and restart policy.
#
# Sate stores its database AND the AES key that decrypts your provider API keys in the
# pb_data volume + APP_ENCRYPTION_KEY. Recreating the container with either one changed
# loses the database or makes stored keys undecryptable, so this script copies both from
# the live container instead of taking them as arguments.
#
# Run it on the Docker host, from a checkout of this repo:  ./scripts/redeploy.sh
#
# First deploy (no container yet): set APP_ENCRYPTION_KEY, SATE_DATA and SATE_PORT.
#   APP_ENCRYPTION_KEY=$(openssl rand -hex 16) SATE_DATA=/srv/sate SATE_PORT=127.0.0.1:8090 \
#     ADMIN_EMAILS=you@example.com ./scripts/redeploy.sh
set -e
cd "$(dirname "$0")/.."

NAME="${SATE_CONTAINER:-sate}"
IMAGE="${SATE_IMAGE:-sate:latest}"
TRIES="${SATE_HEALTH_TRIES:-60}"
OLD="${NAME}-previous"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
chmod 700 "$tmp"

if docker inspect "$NAME" >/dev/null 2>&1; then EXISTING=1; else EXISTING=0; fi

# sed, not grep, for the filtering below: grep exits 1 when a container has no labels
# (or no binds), which under `set -e` would abort the script before it built anything.
if [ "$EXISTING" = 1 ]; then
  echo "Reusing configuration from the running '$NAME' container."
  # PATH/HOME come from the image; re-applying the stale values would pin them forever.
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" \
    | sed -E '/^(PATH|HOME)=/d; /^$/d' > "$tmp/env"
  docker inspect --format '{{range .HostConfig.Binds}}{{println .}}{{end}}' "$NAME" \
    | sed '/^$/d' > "$tmp/binds"
  docker inspect --format '{{range $p, $bs := .HostConfig.PortBindings}}{{range $bs}}{{println .HostIp ":" .HostPort ":" $p}}{{end}}{{end}}' "$NAME" \
    | tr -d ' ' | sed '/^$/d' > "$tmp/ports"
  docker inspect --format '{{range $k, $v := .Config.Labels}}{{println $k "=" $v}}{{end}}' "$NAME" \
    | sed 's/ = /=/; /^$/d' > "$tmp/labels"
  RESTART="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$NAME")"
else
  echo "No '$NAME' container found — treating this as a first deploy."
  : "${APP_ENCRYPTION_KEY:?set APP_ENCRYPTION_KEY (openssl rand -hex 16)}"
  : "${SATE_DATA:?set SATE_DATA — host path to persist pb_data}"
  : "${SATE_PORT:?set SATE_PORT — e.g. 127.0.0.1:8090}"
  echo "APP_ENCRYPTION_KEY=$APP_ENCRYPTION_KEY" > "$tmp/env"
  if [ -n "$ADMIN_EMAILS" ]; then echo "ADMIN_EMAILS=$ADMIN_EMAILS" >> "$tmp/env"; fi
  echo "AUTH_EMAIL_HEADER=${AUTH_EMAIL_HEADER:-Cf-Access-Authenticated-User-Email}" >> "$tmp/env"
  echo "$SATE_DATA:/pb/pb_data" > "$tmp/binds"
  echo "$SATE_PORT:8080/tcp" > "$tmp/ports"
  : > "$tmp/labels"
  RESTART="unless-stopped"
fi
chmod 600 "$tmp/env"

# Refuse to build a container that would come up without its key or its database.
if ! grep -q '^APP_ENCRYPTION_KEY=.' "$tmp/env"; then
  echo "FATAL: APP_ENCRYPTION_KEY not carried over — refusing." >&2; exit 1
fi
if ! grep -q ':/pb/pb_data$' "$tmp/binds"; then
  echo "FATAL: no /pb/pb_data volume — refusing (this would discard the database)." >&2; exit 1
fi

echo "Building $IMAGE…"
PREV_IMAGE="$(docker inspect --format '{{.Image}}' "$NAME" 2>/dev/null || true)"
docker build -t "$IMAGE" .

set -- run -d --name "$NAME" --restart "${RESTART:-unless-stopped}" --env-file "$tmp/env"
while read -r b; do set -- "$@" -v "$b"; done < "$tmp/binds"
while read -r p; do set -- "$@" -p "$p"; done < "$tmp/ports"
while read -r l; do set -- "$@" -l "$l"; done < "$tmp/labels"
set -- "$@" "$IMAGE"

# Keep the old container until the new one proves healthy, so a bad build is recoverable.
rollback() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ "$EXISTING" = 1 ]; then
    echo "Rolling back to the previous container." >&2
    docker rename "$OLD" "$NAME"
    docker start "$NAME" >/dev/null
    if [ -n "$PREV_IMAGE" ]; then docker tag "$PREV_IMAGE" "$IMAGE" 2>/dev/null || true; fi
  fi
  exit 1
}

if [ "$EXISTING" = 1 ]; then
  docker rm -f "$OLD" >/dev/null 2>&1 || true
  docker stop "$NAME" >/dev/null
  docker rename "$NAME" "$OLD"
fi

if ! docker "$@" >/dev/null; then
  echo "FATAL: docker run failed." >&2
  rollback
fi

printf 'Waiting for health'
i=0
status=starting
while [ "$i" -lt "$TRIES" ]; do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME" 2>/dev/null || echo gone)"
  case "$status" in
    healthy|none|unhealthy|gone) break ;;
  esac
  printf '.'
  i=$((i + 1))
  sleep 2
done
echo

case "$status" in
  healthy|none) ;;
  *) echo "FATAL: new container did not become healthy (status: $status)." >&2
     docker logs --tail 30 "$NAME" >&2 2>/dev/null || true
     rollback ;;
esac

if [ "$EXISTING" = 1 ]; then docker rm "$OLD" >/dev/null 2>&1 || true; fi
echo "Sate redeployed: $(docker inspect --format '{{.Config.Image}} {{.State.Status}}' "$NAME")"
