#!/usr/bin/env bash
# Initializes the stack's Vault once (docs/operations/deployment.md, « Dossier hôte et Vault »):
# starts the vault service, waits for its API, then runs `vault-setup init` in a tools container
# as the calling user (secrets/vault/ stays the operator's). vault-setup unseals Vault and exits 0
# only once it has written its entries. Prints only the Vault operator password, once. Refuses to
# run unless secrets/vault/unseal and secrets/vault/approle are empty directories the caller owns:
# Docker would otherwise create a missing one root-owned, or a leftover file would fail
# vault-setup after Vault is initialized.
set -euo pipefail
: "${SOL_HOST_DIR:?SOL_HOST_DIR is required}"
# The checks below read $SOL_HOST_DIR from the current directory, while Compose resolves the same
# variable in its bind sources from the compose file's: only an absolute path names one place.
case "$SOL_HOST_DIR" in /*) ;; *) echo 'vault-init: SOL_HOST_DIR must be an absolute path' >&2; exit 78 ;; esac
repository="$(cd "$(dirname "$0")/../.." && pwd)"
compose() {
  docker compose --env-file "$SOL_HOST_DIR/compose.env" -f "$repository/deploy/compose.yaml" "$@"
}
for directory in unseal approle; do
  path="$SOL_HOST_DIR/secrets/vault/$directory"
  if [ ! -d "$path" ] || [ ! -O "$path" ] || [ ! -w "$path" ]; then
    echo "vault-init: secrets/vault/$directory must be a directory you own and can write (deploy/host/init-secrets.sh creates it)" >&2
    exit 78
  fi
done
if [ -e "$SOL_HOST_DIR/secrets/vault/unseal/unseal-key" ]; then
  echo 'vault-init: secrets/vault/unseal/unseal-key exists: Vault is already initialized: nothing to do (to start over, see the runbook)' >&2
  exit 78
fi
for directory in unseal approle; do
  path="$SOL_HOST_DIR/secrets/vault/$directory"
  # Its own statement: a failing ls aborts here (set -e) instead of reading as an empty directory.
  listing="$(ls -A "$path")"
  if [ -n "$listing" ]; then
    echo "vault-init: secrets/vault/$directory holds files of an earlier attempt: start over as the runbook says" >&2
    exit 78
  fi
done
compose up --detach vault
ready=no
for _ in $(seq 60); do
  if compose exec -T vault wget -q -O /dev/null http://127.0.0.1:8200/v1/sys/seal-status 2> /dev/null; then
    ready=yes
    break
  fi
  sleep 1
done
if [ "$ready" != yes ]; then
  echo 'vault-init: the Vault API did not answer within 60 tries: see docker compose logs vault' >&2
  exit 69
fi
compose run --rm --no-deps --user "$(id -u):$(id -g)" vault-setup init
echo 'next: store secrets/vault/unseal/unseal-key in your password manager, then run deploy/host/vault-import.sh'
