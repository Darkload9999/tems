#!/usr/bin/env bash
# Roll the stack forward to prebuilt api/web images, and roll back if they
# don't come up healthy. CI runs this on the server over SSH after every push
# to main; you can also run it by hand to redeploy or roll back to any tag.
#
#   ./scripts/deploy.sh <tag> [image-prefix]
#   ./scripts/deploy.sh 3f2c1ab ghcr.io/darkload9999/tems    # → tems-api:3f2c1ab, tems-web:3f2c1ab
#
# The tag and prefix are stored in .env (TEMS_TAG, TEMS_IMAGE_PREFIX), so plain
# `docker compose` commands on the server keep using the deployed images.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:?usage: deploy.sh <tag> [image-prefix]}"
PREFIX="${2:-}"
WAIT="${DEPLOY_WAIT_SECONDS:-300}"
KEEP="${DEPLOY_KEEP_IMAGES:-3}"   # tagged images kept per service, for rollbacks

[[ -f .env ]] || { echo "✗ .env is missing: run scripts/init-env.sh first (see deploy/DEPLOY.md)." >&2; exit 1; }

get() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- || true; }
put() { # upsert KEY=VALUE in .env, keeping its permissions
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}

prev_tag="$(get TEMS_TAG)"
[[ -n "$PREFIX" ]] && put TEMS_IMAGE_PREFIX "$PREFIX"
prefix="$(get TEMS_IMAGE_PREFIX)"
[[ -n "$prefix" ]] || { echo "✗ No image prefix: pass one, or set TEMS_IMAGE_PREFIX in .env." >&2; exit 1; }

up() {
  put TEMS_TAG "$1"
  docker compose config --quiet
  docker compose up -d --no-build --remove-orphans --wait --wait-timeout "$WAIT"
}

echo "→ Deploying ${prefix}-{api,web}:${TAG} (was: ${prev_tag:-none})"
put TEMS_TAG "$TAG"
docker compose pull --quiet api web

if up "$TAG"; then
  echo "✓ Healthy on ${TAG}"
else
  echo "✗ ${TAG} did not become healthy within ${WAIT}s." >&2
  docker compose ps >&2 || true
  docker compose logs --tail 80 api web >&2 || true
  if [[ -n "$prev_tag" && "$prev_tag" != "$TAG" ]]; then
    echo "↩ Rolling back to ${prev_tag}" >&2
    if up "$prev_tag"; then echo "↩ Rolled back to ${prev_tag}" >&2; else echo "✗ Rollback to ${prev_tag} is unhealthy too: check the server." >&2; fi
  fi
  exit 1
fi

# keep the newest few tagged images per service so rollbacks stay instant
for svc in api web; do
  docker images "${prefix}-${svc}" --format '{{.Repository}}:{{.Tag}}' | grep -v ':<none>$' | tail -n +"$((KEEP + 1))" | xargs -r docker rmi >/dev/null 2>&1 || true
done
docker image prune -f >/dev/null
