#!/usr/bin/env bash
# Creates the host directory of the stack (docs/operations/deployment.md, « Dossier hôte et
# Vault »). It holds only the bootstrap secrets, since every other variable lives in Vault:
# - secrets/ (0700): the PostgreSQL admin password, the front bcrypt hash, and the empty
#   secrets/vault/ directories that deploy/host/vault-init.sh fills;
# - backups/ (0700).
# It never overwrites a file and prints no secret, except the generated front password, shown once
# so the operator can store it.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'usage: deploy/host/init-secrets.sh <host directory>' >&2
  exit 64
fi
host="$1"
caddy_image='caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
admin_file="$host/secrets/db/postgres-admin-password"
hash_file="$host/secrets/front/front-basic-auth-hash"
# A compose run before this script makes Docker create a missing bind source as a directory.
for file in "$admin_file" "$hash_file"; do
  if [ -d "$file" ]; then
    echo "init-secrets: $file is a directory: remove it, then run again" >&2
    exit 78
  fi
done
umask 077
mkdir -p "$host/secrets/db" "$host/secrets/front" "$host/secrets/vault/unseal" "$host/secrets/vault/approle" "$host/backups"
chmod 0700 "$host" "$host/secrets" "$host/secrets/vault" "$host/secrets/vault/unseal" "$host/secrets/vault/approle" "$host/backups"

if [ ! -e "$admin_file" ]; then
  openssl rand -hex 32 > "$admin_file"
  chmod 0600 "$admin_file"
  echo "created $admin_file"
fi

if [ ! -e "$hash_file" ]; then
  password="$(openssl rand -base64 24 | tr -d '\n')"
  # Cost 10: each failed login costs Caddy one bcrypt comparison, and the password is random.
  # The hash lands in place only once complete: a failed run leaves no empty secret behind.
  printf '%s\n' "$password" \
    | docker run --rm -i --entrypoint caddy "$caddy_image" hash-password --bcrypt-cost 10 > "$hash_file.tmp"
  grep -Eq '^\$2a\$10\$[./A-Za-z0-9]{53}$' "$hash_file.tmp"
  chmod 0600 "$hash_file.tmp"
  mv "$hash_file.tmp" "$hash_file"
  printf 'front password, shown once (store it in your password manager): %s\n' "$password"
  unset password
fi

echo 'next: deploy/host/vault-init.sh, then deploy/host/vault-import.sh (docs/operations/deployment.md)'
