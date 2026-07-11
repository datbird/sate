#!/bin/sh
# Fetch the PocketBase binary (if missing) and run Sate locally against ./pb_data.
# Loads .env if present. Usage: ./scripts/dev.sh
set -e
cd "$(dirname "$0")/.."

PB_VERSION="${PB_VERSION:-0.39.5}"

# best-effort OS/arch detection for the download
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported arch: $(uname -m)"; exit 1 ;;
esac

if [ ! -x ./pocketbase ]; then
  echo "Downloading PocketBase ${PB_VERSION} (${OS}/${ARCH})…"
  url="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_${OS}_${ARCH}.zip"
  curl -fsSL "$url" -o /tmp/sate-pb.zip
  unzip -o /tmp/sate-pb.zip pocketbase -d . >/dev/null
  chmod +x ./pocketbase
  rm -f /tmp/sate-pb.zip
fi

# load .env into the environment if it exists
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

if [ -z "$APP_ENCRYPTION_KEY" ] || [ "${#APP_ENCRYPTION_KEY}" -ne 32 ]; then
  echo "APP_ENCRYPTION_KEY missing/invalid — generating a throwaway dev key."
  export APP_ENCRYPTION_KEY="$(openssl rand -hex 16)"
fi

# Local dev: honour DEV_EMAIL (the no-proxy escape hatch). In production this flag is unset, so a
# stray DEV_EMAIL can never authenticate a header-less request.
export SATE_DEV=1

echo "Sate dev server on http://127.0.0.1:8090   (admin dashboard: /_/)"
exec ./pocketbase serve --http=127.0.0.1:8090
