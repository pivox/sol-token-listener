import assert from 'node:assert/strict';
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
