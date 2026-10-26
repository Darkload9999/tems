#!/usr/bin/env bash
# Dump both databases (Keycloak: users, groups, permissions; TEMS: audit, outbox,
# denies, settings) and the DKIM key into ./backups/<timestamp>/.
#
#   ./scripts/backup.sh            # e.g. nightly from cron: 17 3 * * * /opt/tems/scripts/backup.sh
#   KEEP_DAYS=30 ./scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

out="backups/$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$out"
for db in keycloak tems; do
  docker compose exec -T db pg_dump -U postgres --format=custom "$db" > "$out/$db.dump"
done
docker compose exec -T mail tar -C /etc/opendkim -cf - keys > "$out/dkim-keys.tar"
find backups -mindepth 1 -maxdepth 1 -type d -mtime +"${KEEP_DAYS:-14}" -exec rm -rf {} +
echo "Backed up to $out"
# Restore one: docker compose exec -T db pg_restore -U postgres --clean -d tems < backups/<ts>/tems.dump
