#!/usr/bin/env bash
# Imports the current role files into Vault (docs/operations/deployment.md, « Dossier hôte et
# Vault »). It mounts read-only into a vault-import tools container:
# - the env directory (lot5 layout);
# - the key files that its *_PATH variables name;
# - the repository's configuration templates.
# The operator password goes on stdin. No value is printed. Vault must be running (--no-deps:
# the import never starts or recreates it).
set -euo pipefail
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'usage: deploy/host/vault-import.sh <env directory> [evidence directory]' >&2
  exit 64
fi
: "${SOL_HOST_DIR:?SOL_HOST_DIR is required}"
source_dir="$(cd "$1" && pwd)"
evidence_dir="${2:-$(dirname "$source_dir")/evidence}"
# The tool matches this prefix against absolute paths: resolve a relative argument from the current
# directory (it need not exist; the tool normalizes any dot segments).
case "$evidence_dir" in /*) ;; *) evidence_dir="$PWD/$evidence_dir" ;; esac
repository="$(cd "$(dirname "$0")/../.." && pwd)"
compose() {
  docker compose --env-file "$SOL_HOST_DIR/compose.env" -f "$repository/deploy/compose.yaml" "$@"
}
# A *_PATH variable of a role file, without surrounding quotes. Paths only, never a secret value.
# It reads only the plain VAR=value form of the lot5 files, not `export VAR=` or `VAR = value`.
path_of() {
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | head -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
mounts=(-v "$source_dir:/import/env:ro" -v "$repository/deploy/config:/import/templates:ro")
add_key() {
  if [ -n "$2" ]; then
    if [ ! -f "$2" ]; then
      echo "vault-import: $2 (named by $3) does not exist" >&2
      exit 78
    fi
    mounts+=(-v "$2:/import/keys/$1:ro")
  fi
}
# Each path in its own statement: a failing read stops the script instead of reading as "no key".
admin_key="$(path_of HELIUS_API_KEY_PATH "$source_dir/provider-evidence.env")"
evidence_key="$(path_of EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH "$source_dir/provider-evidence.env")"
wallet_key="$(path_of EXECUTOR_KEYPAIR_PATH "$source_dir/live.env")"
add_key helius-admin-api-key "$admin_key" HELIUS_API_KEY_PATH
add_key evidence-private-key "$evidence_key" EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH
add_key wallet-keypair.json "$wallet_key" EXECUTOR_KEYPAIR_PATH
# No trace from here on: xtrace would print the password through printf. A password piped without
# a trailing newline makes read fail at EOF but still sets it; an empty one is refused.
set +x
IFS= read -r -s -p 'Vault operator password: ' password || true
echo >&2
if [ -z "$password" ]; then
  echo 'vault-import: no password given' >&2
  exit 64
fi
printf '%s\n' "$password" \
  | compose run --rm --no-deps -T "${mounts[@]}" -e "SOL_IMPORT_EVIDENCE_PREFIX=$evidence_dir" vault-import
unset password
