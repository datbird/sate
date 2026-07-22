#!/usr/bin/env bash
# Regenerate the shared `core-dist` lineage from core/ and push it, so consumers
# (the private sate-cloud repo) can pull core via git subtree.
#
#   Public repo:  bash scripts/dist-core.sh
#   sate-cloud:   git subtree pull --prefix=core core-src core-dist --squash
#
# Run it with bash, NOT sh: `set -o pipefail` below is a bashism and dash dies on it
# ("Illegal option -o pipefail"). Same trap as sate-cloud's deploy.sh.
#
# core/ is CANONICAL here; edit it here, run this, then pull in sate-cloud → exact sync.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git branch -D core-dist 2>/dev/null || true
git subtree split --prefix=core -b core-dist
git push origin core-dist
echo "✓ core-dist updated. In sate-cloud:  git subtree pull --prefix=core core-src core-dist --squash"
echo "  (add/add conflicts there are a squash-subtree artifact, not drift — verify sate-cloud's"
echo "   pre-merge core matches this repo's previous commit, then resolve with --theirs.)"
