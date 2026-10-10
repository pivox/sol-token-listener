#!/usr/bin/env bash
# Backup of the stack (full-bot spec 9.4, Vault spec 8.4): pg_dump -Fc through the postgres
# container and Vault's raft snapshot through a vault-snapshot tools container, each with its
# SHA-256, kept 14 days. The snapshot is encrypted; restoring it needs the unseal key, which is
# never part of a backup. Copying backups off the machine stays the operator's job. The tools run
# with --no-deps: a backup never starts or recreates Vault, and a stopped Vault fails it. A failed
# run keeps what it completed (the dump when only the snapshot fails) and no partial file.
set -euo pipefail
: "${SOL_HOST_DIR:?SOL_HOST_DIR is required}"
: "${SOL_REPOSITORY:?SOL_REPOSITORY is required}"
backups="$SOL_HOST_DIR/backups"
umask 077
mkdir -p "$backups"
compose() {
  docker compose --env-file "$SOL_HOST_DIR/compose.env" -f "$SOL_REPOSITORY/deploy/compose.yaml" "$@"
}
checksum() {
  if command -v sha256sum > /dev/null; then
    (cd "$backups" && sha256sum "$1" > "$1.sha256")
  else
    (cd "$backups" && shasum -a 256 "$1" > "$1.sha256")
  fi
}
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="sol-$stamp.dump"
snapshot="vault-$stamp.snap"
# Whatever the exit, no .partial file stays: a finished one was renamed away.
trap 'rm -f "$backups/$dump.partial" "$backups/$snapshot.partial"' EXIT
compose exec -T postgres sh -c 'exec pg_dump -Fc -U sol_owner -d "$POSTGRES_DB"' > "$backups/$dump.partial"
if [ ! -s "$backups/$dump.partial" ]; then
  echo 'backup: the database dump is empty' >&2
  exit 1
fi
mv "$backups/$dump.partial" "$backups/$dump"
checksum "$dump"
approle="$SOL_HOST_DIR/secrets/vault/approle/backup.json"
if [ ! -f "$approle" ]; then
  echo 'backup: secrets/vault/approle/backup.json is missing: run deploy/host/vault-init.sh first' >&2
  exit 78
fi
compose run --rm --no-deps -T vault-snapshot < "$approle" > "$backups/$snapshot.partial"
if [ ! -s "$backups/$snapshot.partial" ]; then
  echo 'backup: the Vault snapshot is empty' >&2
  exit 1
fi
mv "$backups/$snapshot.partial" "$backups/$snapshot"
checksum "$snapshot"
find "$backups" -maxdepth 1 -type f \( -name 'sol-*.dump*' -o -name 'vault-*.snap*' \) -mtime +14 -delete
echo "backup $backups/$dump $backups/$snapshot"
