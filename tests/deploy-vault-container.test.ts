import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { VAULT_POLICIES } from '../scripts/deploy/vault-setup.js';

const root = new URL('../', import.meta.url);

async function artifact(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

function grants(policy: string): readonly string[] {
  return [...policy.matchAll(/^path "([^"]+)" \{\n {2}capabilities = \[([^\]]*)\]\n\}$/gmu)]
    .map((match) => `${match[1] ?? ''} ${match[2] ?? ''}`);
}

void test('the four policies grant only what spec 6.2 lists', async () => {
  assert.deepEqual(grants(await artifact('deploy/vault/policies/back.hcl')), [
    'sol/data/config/* "read"', 'sol/data/secrets/back/* "read"', 'sol/data/secrets/logins/* "read"',
  ]);
  assert.deepEqual(grants(await artifact('deploy/vault/policies/migrate.hcl')), ['sol/data/secrets/logins/* "read"']);
  assert.deepEqual(grants(await artifact('deploy/vault/policies/backup.hcl')), ['sys/storage/raft/snapshot "read"']);
  assert.deepEqual(grants(await artifact('deploy/vault/policies/operator.hcl')), [
    // patch: `vault kv patch` sends PATCH; without it, the CLI's fallback first logs a 403.
    'sol/* "create", "read", "update", "patch", "delete", "list"',
    // The exact path wins over the glob: the operator cannot change max_versions,
    // delete_version_after or cas_required, the last of which would fail vault-import.
    'sol/config "read"',
  ]);
  for (const name of VAULT_POLICIES) {
    const policy = await artifact(`deploy/vault/policies/${name}.hcl`);
    assert.equal((policy.match(/^\s*path\s/gmu) ?? []).length, grants(policy).length, name);
  }
});

void test('the vault entrypoint unseals from the key file without ever exposing the key', async () => {
  const entrypoint = await artifact('deploy/vault/vault-entrypoint');
  assert.ok(entrypoint.startsWith('#!/bin/sh\n'));
  const syntax = spawnSync('sh', ['-n'], { input: entrypoint, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  for (const line of [
    'key_file=/run/vault/unseal-key',
    // Both wget calls carry a read timeout: a listener that never answers must not hold the shell.
    'until seal="$(wget -q -T 5 -O- "$api/v1/sys/seal-status" 2> /dev/null)"; do',
    // Vault gone (a crash, or the forwarded TERM): the poll stops and `wait` reports its status.
    '    kill -0 "$server" 2> /dev/null || return 1',
    `*'"initialized":false'*)`,
    `  if printf '{"key":"%s"}' "$(head -n 1 "$key_file")" \\`,
    '    | wget -q -T 5 -O /dev/null --post-file=/dev/stdin "$api/v1/sys/unseal"; then',
    'su-exec vault vault server -config=/vault/config/vault.hcl &',
    `trap 'kill -TERM "$server" 2> /dev/null || true' TERM INT`,
    // HUP reloads Vault; unhandled, it would kill the shell (129) under `init: true` and Vault with it.
    `trap 'kill -HUP "$server" 2> /dev/null || true' HUP`,
    'unseal_when_ready || true',
    'wait "$server" || status=$?',
    // An interrupted wait is retried while Vault runs (a HUP then a TERM must not end the shell
    // before Vault); a Vault killed by a signal ends the loop with its own status.
    'while [ "$status" -gt 128 ] && kill -0 "$server" 2> /dev/null; do',
  ]) {
    assert.ok(entrypoint.includes(line), line);
  }
  // The key reaches wget through a pipe only; the shell that execs Vault would leave a zombie,
  // and xtrace would print the key.
  assert.doesNotMatch(entrypoint, /echo[^\n]*head|export [A-Z_]*KEY|vault operator unseal|exec su-exec|set -[a-z]*x/u);
});

void test('the vault server keeps raft on its volume and listens inside the Docker networks only', async () => {
  const config = await artifact('deploy/vault/vault.hcl');
  for (const line of [
    'ui            = true',
    'disable_mlock = true',
    'api_addr      = "http://vault:8200"',
    'cluster_addr  = "http://vault:8201"',
    'enable_unauthenticated_access = ["generate-root"]',
    '  path    = "/vault/file"',
    '  node_id = "sol-vault"',
    '  address     = "0.0.0.0:8200"',
    '  tls_disable = true',
  ]) {
    // Whole lines: an indented copy inside a block would be accepted by Vault and silently inert.
    assert.ok(config.split('\n').includes(line), line);
  }
});
