#!/usr/bin/env bash
# Creates the host directory of the stack (docs/operations/deployment.md, « Dossier hôte »):
# secrets/ (0700) with generated database passwords and operator API token, config/ (0755) with
# the role templates, backups/ (0700). It never overwrites a file and prints no secret, except
# the generated front password, shown once so the operator can store it.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'usage: deploy/host/init-secrets.sh <host directory>' >&2
  exit 64
fi
host="$1"
repository="$(cd "$(dirname "$0")/../.." && pwd)"
caddy_image='caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
umask 077
mkdir -p "$host/secrets/db/logins" "$host/secrets/back" "$host/secrets/front" "$host/backups" "$host/config"
chmod 0700 "$host" "$host/secrets" "$host/backups"
chmod 0755 "$host/config"

generate() {
  # 32 random bytes in hex, only when the file does not exist yet.
  if [ ! -e "$1" ]; then
    openssl rand -hex 32 > "$1"
    chmod 0600 "$1"
    echo "created $1"
  fi
}
generate "$host/secrets/db/postgres-admin-password"
for login in sol_listener sol_live sol_recovery sol_autoarm sol_reader sol_retention sol_worker sol_ops sol_readiness; do
  generate "$host/secrets/db/logins/pg-$login-password"
done
generate "$host/secrets/back/operator-api-token"

hash_file="$host/secrets/front/front-basic-auth-hash"
if [ ! -e "$hash_file" ]; then
  password="$(openssl rand -base64 24 | tr -d '\n')"
  printf '%s\n' "$password" | docker run --rm -i --entrypoint caddy "$caddy_image" hash-password > "$hash_file"
  chmod 0600 "$hash_file"
  printf 'front password, shown once (store it in your password manager): %s\n' "$password"
  unset password
fi

for template in "$repository"/deploy/config/*.env.example; do
  target="$host/config/$(basename "$template" .example)"
  if [ ! -e "$target" ]; then
    cp "$template" "$target"
    chmod 0644 "$target"
    echo "created $target (example values: replace them, see the runbook)"
  fi
done

for file in helius-listener-http-url helius-listener-ws-url helius-executor-http-url helius-admin-api-key evidence-private-key wallet-keypair.json; do
  if [ ! -e "$host/secrets/back/$file" ]; then echo "to provide: $host/secrets/back/$file"; fi
done
