#!/usr/bin/env bash
# Logical backup of the stack database (spec 9.4): pg_dump -Fc through the postgres container,
# SHA-256 next to it, 14-day rotation. The secrets directory is never part of a backup; copying
# backups off the machine stays the operator's job.
set -euo pipefail
: "${SOL_HOST_DIR:?SOL_HOST_DIR is required}"
: "${SOL_REPOSITORY:?SOL_REPOSITORY is required}"
backups="$SOL_HOST_DIR/backups"
umask 077
mkdir -p "$backups"
name="sol-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose --env-file "$SOL_HOST_DIR/compose.env" -f "$SOL_REPOSITORY/deploy/compose.yaml" \
  exec -T postgres sh -c 'exec pg_dump -Fc -U sol_owner -d "$POSTGRES_DB"' > "$backups/$name.partial"
mv "$backups/$name.partial" "$backups/$name"
if command -v sha256sum > /dev/null; then
  (cd "$backups" && sha256sum "$name" > "$name.sha256")
else
  (cd "$backups" && shasum -a 256 "$name" > "$name.sha256")
fi
find "$backups" -maxdepth 1 -type f -name 'sol-*.dump*' -mtime +14 -delete
echo "backup $backups/$name"
