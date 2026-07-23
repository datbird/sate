#!/usr/bin/env bash
# Run core unit tests. Core uses extensionless relative imports that Node's native ESM loader
# rejects, so each test file is bundled with esbuild (which resolves them + strips types) before
# running under node:test. Run with bash (not sh): set -o pipefail is a bashism.
set -euo pipefail
cd "$(dirname "$0")/.."   # -> core/
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
shopt -s nullglob
files=(test/*.test.ts)
if [ ${#files[@]} -eq 0 ]; then echo "no test files"; exit 0; fi
for f in "${files[@]}"; do
  npx esbuild "$f" --bundle --platform=node --format=cjs --outfile="$out/$(basename "$f" .ts).cjs" >/dev/null
done
node --test "$out"/*.cjs
