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
    'sol/* "create", "read", "update", "delete", "list"',
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
    `*'"initialized":false'*)`,
    `  if printf '{"key":"%s"}' "$(head -n 1 "$key_file")" \\`,
    '    | wget -q -O /dev/null --post-file=/dev/stdin "$api/v1/sys/unseal"; then',
    'su-exec vault vault server -config=/vault/config/vault.hcl &',
    `trap 'kill -TERM "$server" 2> /dev/null || true' TERM INT`,
    'unseal_when_ready || true',
    'wait "$server" || status=$?',
  ]) {
    assert.ok(entrypoint.includes(line), line);
  }
  // The key reaches wget through a pipe only; the shell that execs Vault would leave a zombie.
  assert.doesNotMatch(entrypoint, /echo[^\n]*head|export [A-Z_]*KEY|vault operator unseal|exec su-exec/u);
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
    assert.ok(config.includes(`${line}\n`), line);
  }
});
