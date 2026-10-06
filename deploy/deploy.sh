#!/usr/bin/env bash
# Runs ON the server, from the repo root: deploy a commit with pm2 and roll back if unhealthy.
#   ./deploy/deploy.sh <git sha>
# First time only:  pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
set -euo pipefail

SHA="${1:?usage: deploy.sh <git sha>}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4100/health}"
cd "$(dirname "$0")/.."
PREVIOUS="$(git rev-parse HEAD)"

release() {
  git fetch --quiet origin
  git checkout --quiet --detach "$1"
  pnpm install --frozen-lockfile
  # Migrations are additive, so the previous build can still read the schema on rollback.
  pnpm --filter @paylink/api db:deploy   # reads DATABASE_URL from the repo-root .env
  pnpm --filter @paylink/api build
  pm2 reload ecosystem.config.cjs --update-env
  pm2 save
}

healthy() {
  for _ in $(seq 1 12); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL")" = "200" ] && return 0
    sleep 5
  done
  return 1
}

release "$SHA"
if healthy; then
  echo "deployed $SHA"
  exit 0
fi
echo "health check failed; rolling back to $PREVIOUS" >&2
git checkout --quiet --detach "$PREVIOUS"
pnpm install --frozen-lockfile
pnpm build
pm2 reload ecosystem.config.cjs --update-env
# pm2 backs off after a crash loop, so the old version can take a few seconds to come up.
if healthy; then
  echo "rolled back to $PREVIOUS and healthy again" >&2
else
  echo "ROLLBACK DID NOT RECOVER: $HEALTH_URL is still failing. Check: pm2 logs paylink-api" >&2
fi
exit 1
