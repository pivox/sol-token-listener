import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VaultClient,
  VaultDeniedError,
  VaultMissingError,
  VaultUnavailableError,
  parseAppRoleCredentials,
} from '../src/deploy/vault-client.js';
import { FakeVault } from './helpers/fake-vault.js';

void test('reads, writes and errors follow the HTTP API without ever quoting a body or a value', async () => {
  const vault = new FakeVault();
  const client = new VaultClient({ address: 'http://vault:8200/', fetch: vault.fetch });
  vault.kv.set('secrets/back/x', { value: 'top-secret-value' });
  const credentials = vault.addAppRole('back');
  const token = await client.appRoleLogin(credentials);
  assert.deepEqual(await client.readKv(token, 'secrets/back/x'), { value: 'top-secret-value' });
  await assert.rejects(client.readKv(token, 'secrets/back/absent'),
    (error) => error instanceof VaultMissingError && error.message === 'vault GET sol/data/secrets/back/absent: HTTP 404');
  await assert.rejects(client.writeKv(token, 'secrets/back/x', { value: 'y' }), VaultDeniedError);
  await assert.rejects(client.appRoleLogin({ role_id: credentials.role_id, secret_id: 'wrong' }),
    (error) => error instanceof VaultDeniedError && error.message === 'vault POST auth/approle/login: HTTP 400');
  await client.revokeSelf(token);
  assert.equal(vault.isRevoked(token), true);
  await assert.rejects(client.readKv(token, 'secrets/back/x'), VaultDeniedError);
  vault.sealed = true;
  await assert.rejects(client.appRoleLogin(credentials),
    (error) => error instanceof VaultUnavailableError && error.message === 'vault POST auth/approle/login: HTTP 503');
  vault.unreachable = true;
  await assert.rejects(client.sealStatus(),
    (error) => error instanceof VaultUnavailableError && error.message === 'vault GET sys/seal-status: unreachable');
  assert.ok(vault.requests.every((request) => !request.includes('top-secret-value')));
});

void test('init, unseal, administration and snapshot use the root token, then the backup AppRole', async () => {
  const vault = new FakeVault();
  vault.initialized = false;
  vault.sealed = true;
  const client = new VaultClient({ address: 'http://vault:8200', fetch: vault.fetch });
  assert.deepEqual(await client.sealStatus(), { initialized: false, sealed: true });
  const { unsealKey, rootToken } = await client.initialize();
  await client.unseal(unsealKey);
  assert.deepEqual(await client.sealStatus(), { initialized: true, sealed: false });
  await client.enableKv2(rootToken, 'sol');
  await client.enableAuth(rootToken, 'approle');
  const policy = 'path "sys/storage/raft/snapshot" { capabilities = ["read"] }\n';
  await client.putPolicy(rootToken, 'backup', policy);
  const backup = await client.createAppRole(rootToken, 'backup');
  await client.createUser(rootToken, 'operator', 'operator-password-0123456789', 'operator');
  assert.deepEqual([...vault.mounts], ['sol']);
  assert.deepEqual([...vault.auths], ['approle']);
  assert.equal(vault.policies.get('backup'), policy);
  assert.equal(vault.users.get('operator')?.policy, 'operator');
  const operator = await client.userpassLogin('operator', 'operator-password-0123456789');
  await client.writeKv(operator, 'secrets/back/y', { value: 'z' });
  assert.deepEqual(await client.readKv(operator, 'secrets/back/y'), { value: 'z' });
  const stream = await client.snapshot(await client.appRoleLogin(backup));
  assert.deepEqual([...new Uint8Array(await new Response(stream).arrayBuffer())].slice(0, 2), [0x1f, 0x8b]);
  await assert.rejects(client.initialize(), VaultDeniedError);
});

/** A 200 answer whose body fails when it is read, as on a reset, an abort or the timeout. */
function brokenBody(failure: unknown): Response {
  return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }), { status: 200 });
}

void test('an answer whose body fails while it is read is unreachable, never the platform error', async () => {
  for (const failure of [new TypeError('terminated'), new DOMException('timed out', 'TimeoutError')]) {
    const client = new VaultClient({ address: 'http://vault:8200', fetch: async () => brokenBody(failure) });
    await assert.rejects(client.sealStatus(), (error) => (
      error instanceof VaultUnavailableError
      && error.message === 'vault GET sys/seal-status: unreachable'
      && !('cause' in error)
    ), failure.name);
  }
});

void test('the snapshot stream is handed over raw: a read failure reaches its consumer unchanged', async () => {
  const client = new VaultClient({ address: 'http://vault:8200', fetch: async () => brokenBody(new TypeError('terminated')) });
  const reader = (await client.snapshot('token')).getReader();
  await assert.rejects(reader.read(), (error) => error instanceof TypeError && error.message === 'terminated');
});

void test('AppRole credentials come from a JSON object with two non-empty strings', () => {
  assert.deepEqual(parseAppRoleCredentials('{"role_id":"r","secret_id":"s"}\n'), { role_id: 'r', secret_id: 's' });
  for (const text of ['', 'not json', '{"role_id":"r"}', '{"role_id":"","secret_id":"s"}', '[]']) {
    assert.throws(() => parseAppRoleCredentials(text), /^TypeError: expected an AppRole JSON object$/u);
  }
});
