import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VaultClient,
  VaultDeniedError,
  VaultMissingError,
  VaultUnavailableError,
  parseAppRoleCredentials,
  type VaultFetch,
} from '../src/deploy/vault-client.js';
import { backEntries, migrateEntries } from '../src/deploy/vault-layout.js';
import { FakeVault } from './helpers/fake-vault.js';

const ADDRESS = 'http://vault:8200';
/** Planted in every error body and malformed answer: it must never reach a message. */
const MARKER = 'marker-that-must-not-leak';

type ErrorClass = typeof VaultDeniedError | typeof VaultMissingError | typeof VaultUnavailableError;

function json(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

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
  await client.enableAuth(rootToken, 'userpass');
  const policy = 'path "sys/storage/raft/snapshot" { capabilities = ["read"] }\n';
  await client.putPolicy(rootToken, 'backup', policy);
  const backup = await client.createAppRole(rootToken, 'backup');
  await client.createUser(rootToken, 'operator', 'operator-password-0123456789', 'operator');
  assert.deepEqual([...vault.mounts], ['sol']);
  assert.deepEqual([...vault.auths], ['approle', 'userpass']);
  assert.equal(vault.policies.get('backup'), policy);
  assert.equal(vault.users.get('operator')?.policy, 'operator');
  const operator = await client.userpassLogin('operator', 'operator-password-0123456789');
  await client.writeKv(operator, 'secrets/back/y', { value: 'z' });
  assert.deepEqual(await client.readKv(operator, 'secrets/back/y'), { value: 'z' });
  const snapshot = await client.snapshot(await client.appRoleLogin(backup));
  assert.deepEqual([...snapshot].slice(0, 2), [0x1f, 0x8b]);
  await assert.rejects(client.initialize(), VaultDeniedError);
});

void test('the HTTP status decides the error class and a message never quotes the body', async () => {
  const inits: RequestInit[] = [];
  const statuses: readonly (readonly [number, ErrorClass])[] = [
    [400, VaultDeniedError], [401, VaultDeniedError], [403, VaultDeniedError],
    [404, VaultMissingError],
    [307, VaultUnavailableError], [405, VaultUnavailableError], [412, VaultUnavailableError],
    [429, VaultUnavailableError], [500, VaultUnavailableError], [501, VaultUnavailableError],
    [503, VaultUnavailableError],
  ];
  for (const [status, expected] of statuses) {
    const client = new VaultClient({
      address: ADDRESS,
      fetch: async (_url, init) => {
        inits.push(init);
        return json(status, { errors: [MARKER] }, status === 307 ? { Location: `${ADDRESS}/${MARKER}` } : {});
      },
    });
    await assert.rejects(client.readKv('token', 'secrets/back/x'), (error) => {
      assert.ok(error instanceof expected, `HTTP ${String(status)}`);
      assert.equal((error as Error).message, `vault GET sol/data/secrets/back/x: HTTP ${String(status)}`);
      assert.equal((error as Error).message.includes(MARKER), false);
      return true;
    });
  }
  // A redirect is never followed: the token would travel to its target.
  assert.equal(inits.length, statuses.length);
  assert.ok(inits.every((init) => init.redirect === 'manual'));
});

void test('a 2xx answer Vault would not give is unreadable, unexpected or tokenless, and never quoted', async () => {
  interface Shape {
    readonly body: string | null;
    readonly call: (client: VaultClient) => Promise<unknown>;
    readonly error: ErrorClass;
    readonly message: string;
  }
  const shapes: readonly Shape[] = [
    {
      body: `<html>${MARKER}</html>`, call: (client) => client.readKv('token', 'secrets/back/x'),
      error: VaultUnavailableError, message: 'vault GET sol/data/secrets/back/x: unreadable answer',
    },
    {
      body: JSON.stringify({ data: { data: MARKER } }), call: (client) => client.readKv('token', 'secrets/back/x'),
      error: VaultUnavailableError, message: 'vault GET sol/data/secrets/back/x: unexpected answer',
    },
    // The seal status needs two booleans: anything else must not read as "not initialized".
    ...['', '{}', JSON.stringify({ initialized: true }), JSON.stringify({ initialized: 'yes', sealed: MARKER })].map(
      (body): Shape => ({
        body, call: (client) => client.sealStatus(),
        error: VaultUnavailableError, message: 'vault GET sys/seal-status: unexpected answer',
      }),
    ),
    {
      body: JSON.stringify({ keys_base64: MARKER, root_token: 5 }), call: (client) => client.initialize(),
      error: VaultUnavailableError, message: 'vault PUT sys/init: unexpected answer',
    },
    {
      body: JSON.stringify({ sealed: true, progress: MARKER }), call: (client) => client.unseal('key'),
      error: VaultUnavailableError, message: 'vault PUT sys/unseal: still sealed',
    },
    {
      body: JSON.stringify({ auth: { client_token: 12345, note: MARKER } }),
      call: (client) => client.appRoleLogin({ role_id: 'r', secret_id: 's' }),
      error: VaultDeniedError, message: 'vault POST auth/approle/login: no token',
    },
    {
      body: JSON.stringify({ auth: { client_token: '' } }), call: (client) => client.userpassLogin('operator', 'pw'),
      error: VaultDeniedError, message: 'vault POST auth/userpass/login/operator: no token',
    },
    {
      body: JSON.stringify({ data: { role_id: 7 } }), call: (client) => client.createAppRole('token', 'back'),
      error: VaultUnavailableError, message: 'vault GET auth/approle/role/back/role-id: unexpected answer',
    },
    {
      body: JSON.stringify({ data: { role_id: 'r', note: MARKER } }), call: (client) => client.createAppRole('token', 'back'),
      error: VaultUnavailableError, message: 'vault POST auth/approle/role/back/secret-id: unexpected answer',
    },
  ];
  for (const shape of shapes) {
    const client = new VaultClient({ address: ADDRESS, fetch: async () => new Response(shape.body, { status: 200 }) });
    await assert.rejects(shape.call(client), (error) => {
      assert.ok(error instanceof shape.error, shape.message);
      assert.equal((error as Error).message, shape.message);
      assert.equal((error as Error).message.includes(MARKER), false);
      return true;
    });
  }
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

void test('a snapshot whose body fails while it is read is unreachable, never the platform error', async () => {
  for (const failure of [new TypeError('terminated'), new DOMException('timed out', 'TimeoutError')]) {
    const client = new VaultClient({ address: 'http://vault:8200', fetch: async () => brokenBody(failure) });
    await assert.rejects(client.snapshot('token'), (error) => (
      error instanceof VaultUnavailableError
      && error.message === 'vault GET sys/storage/raft/snapshot: unreachable'
      && !('cause' in error)
    ), failure.name);
  }
});

void test('the snapshot is read whole, and an empty body is empty bytes for the caller to refuse', async () => {
  const bytes = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0x2a]);
  const whole = new VaultClient({ address: ADDRESS, fetch: async () => new Response(bytes, { status: 200 }) });
  assert.deepEqual(await whole.snapshot('token'), bytes);
  const empty = new VaultClient({ address: ADDRESS, fetch: async () => new Response(null, { status: 200 }) });
  assert.deepEqual(await empty.snapshot('token'), new Uint8Array(0));
});

/** Answers after `delayMs` unless its signal aborts first, as the platform `fetch` does. */
function slowFetch(delayMs: number, answer: (url: string) => Response): VaultFetch {
  return async (url, init) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      }, { once: true });
    });
    return answer(url);
  };
}

void test('init and snapshot outlive the default timeout, any other request does not', async () => {
  const answer = (url: string): Response => {
    if (url.endsWith('/v1/sys/init')) return json(200, { keys_base64: ['key'], root_token: 'root' });
    if (url.endsWith('/v1/sys/storage/raft/snapshot')) return new Response(Uint8Array.from([0x1f, 0x8b]));
    return json(200, { initialized: true, sealed: false });
  };
  // Every request takes 100 ms and the default allows 50: only the two long operations get through.
  const client = new VaultClient({ address: ADDRESS, fetch: slowFetch(100, answer), timeoutMs: 50 });
  assert.deepEqual(await client.initialize(), { unsealKey: 'key', rootToken: 'root' });
  assert.deepEqual([...await client.snapshot('token')], [0x1f, 0x8b]);
  await assert.rejects(client.sealStatus(),
    (error) => error instanceof VaultUnavailableError && error.message === 'vault GET sys/seal-status: unreachable');
});

// A regression here would wait out the real 60 s, or loop: fail fast instead.
void test('unseal returns only once the node is active; without the wait the fake answers 500', { timeout: 10_000 }, async () => {
  const freshVault = (): FakeVault => {
    const vault = new FakeVault();
    vault.initialized = false;
    vault.sealed = true;
    vault.standbyRequestsAfterUnseal = 3;
    return vault;
  };
  const vault = freshVault();
  const client = new VaultClient({ address: ADDRESS, fetch: vault.fetch, pollIntervalMs: 1 });
  const { unsealKey, rootToken } = await client.initialize();
  await client.unseal(unsealKey);
  // Three standby answers (429), then the active one (200).
  assert.deepEqual(vault.requests, [
    'PUT sys/init', 'PUT sys/unseal', 'GET sys/health', 'GET sys/health', 'GET sys/health', 'GET sys/health',
  ]);
  await client.enableKv2(rootToken, 'sol');
  assert.deepEqual([...vault.mounts], ['sol']);

  // Control: the same unseal, without the wait, leaves the next call in the standby window.
  const impatient = freshVault();
  const raw = new VaultClient({ address: ADDRESS, fetch: impatient.fetch });
  const keys = await raw.initialize();
  await impatient.fetch(`${ADDRESS}/v1/sys/unseal`, { method: 'PUT', body: JSON.stringify({ key: keys.unsealKey }) });
  await assert.rejects(raw.enableKv2(keys.rootToken, 'sol'),
    (error) => error instanceof VaultUnavailableError && error.message === 'vault POST sys/mounts/sol: HTTP 500');
});

void test('unseal gives up after 60 s when the node never becomes active', { timeout: 10_000 }, async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const calls: string[] = [];
  const standby: VaultFetch = async (url) => {
    calls.push(new URL(url).pathname);
    if (url.endsWith('/v1/sys/unseal')) return json(200, { sealed: false });
    now += 30_000;
    return json(429, { initialized: true, sealed: false, standby: true });
  };
  const client = new VaultClient({ address: ADDRESS, fetch: standby, pollIntervalMs: 1 });
  await assert.rejects(client.unseal('key'),
    (error) => error instanceof VaultUnavailableError && error.message === 'vault GET sys/health: not active');
  // Two polls, 30 s apart: the second one is at the 60 s mark.
  assert.deepEqual(calls, ['/v1/sys/unseal', '/v1/sys/health', '/v1/sys/health']);
});

void test('the fake enforces enablement like Vault, and a fresh Vault has nothing enabled', async () => {
  const vault = new FakeVault();
  const client = new VaultClient({ address: ADDRESS, fetch: vault.fetch });
  const root = vault.rootToken;
  const credentials = vault.addAppRole('back');

  // Before the mount every KV route answers 404, even to root.
  vault.mounts.clear();
  await assert.rejects(client.readKv(root, 'config/listener'), VaultMissingError);
  await assert.rejects(client.writeKv(root, 'config/listener', { A: 'b' }), VaultMissingError);
  await client.enableKv2(root, 'sol');
  await client.writeKv(root, 'config/listener', { A: 'b' });
  assert.deepEqual(await client.readKv(root, 'config/listener'), { A: 'b' });

  // Before the auth method the logins answer 403 and the administration routes 404.
  vault.auths.clear();
  await assert.rejects(client.appRoleLogin(credentials), VaultDeniedError);
  await assert.rejects(client.userpassLogin('operator', 'pw'), VaultDeniedError);
  await assert.rejects(client.createAppRole(root, 'ci'), VaultMissingError);
  await assert.rejects(client.createUser(root, 'operator', 'pw', 'operator'), VaultMissingError);
  await client.enableAuth(root, 'approle');
  await client.enableAuth(root, 'userpass');
  await client.createUser(root, 'operator', 'pw', 'operator');
  assert.ok((await client.createAppRole(root, 'ci')).role_id.length > 0);
  assert.ok((await client.userpassLogin('operator', 'pw')).length > 0);
  assert.ok((await client.appRoleLogin(credentials)).length > 0);

  // `sys/init` hands out a Vault with no mount, no auth method, no policy and no AppRole.
  vault.policies.set('back', 'path "x" {}');
  vault.initialized = false;
  vault.sealed = true;
  await client.initialize();
  assert.deepEqual(
    [vault.mounts.size, vault.auths.size, vault.policies.size, vault.appRoles.size],
    [0, 0, 0, 0],
  );
});

void test('the fake answers like the measured Vault: health, uninitialized, role routes, rights of the policy', async () => {
  const vault = new FakeVault();
  const call = async (method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<number> => {
    const headers: Record<string, string> = options.token === undefined ? {} : { 'X-Vault-Token': options.token };
    const response = await vault.fetch(`${ADDRESS}/v1/${path}`, {
      method, headers, body: options.body === undefined ? null : JSON.stringify(options.body),
    });
    return response.status;
  };
  const root = { token: vault.rootToken };
  const unseal = { body: { key: vault.unsealKey } };

  assert.equal(await call('GET', 'sys/health'), 200);
  vault.sealed = true;
  assert.equal(await call('GET', 'sys/health'), 503);
  vault.initialized = false;
  assert.equal(await call('GET', 'sys/health'), 501);
  // Uninitialized, the logins and the KV routes answer like a sealed Vault, and unseal refuses.
  assert.equal(await call('POST', 'auth/approle/login', { body: {} }), 503);
  assert.equal(await call('GET', 'sol/data/config/listener', root), 503);
  assert.equal(await call('PUT', 'sys/unseal', unseal), 400);

  // After the unseal, `standbyRequestsAfterUnseal` requests find the node standby; seal-status does not count.
  vault.standbyRequestsAfterUnseal = 2;
  assert.equal(await call('PUT', 'sys/init'), 200);
  assert.equal(await call('PUT', 'sys/unseal', unseal), 200);
  assert.equal(await call('GET', 'sys/seal-status'), 200);
  assert.equal(await call('GET', 'sol/data/config/listener', root), 500);
  assert.equal(await call('GET', 'sys/health'), 429);
  assert.equal(await call('GET', 'sys/health'), 200);

  // role-id is read with GET only, secret-id is generated with POST only.
  assert.equal(await call('POST', 'sys/auth/approle', { ...root, body: { type: 'approle' } }), 204);
  assert.equal(await call('POST', 'auth/approle/role/reader', { ...root, body: { token_policies: ['migrate'] } }), 204);
  assert.equal(await call('GET', 'auth/approle/role/reader/role-id', root), 200);
  assert.equal(await call('POST', 'auth/approle/role/reader/role-id', root), 400);
  assert.equal(await call('POST', 'auth/approle/role/reader/secret-id', root), 200);
  assert.equal(await call('GET', 'auth/approle/role/reader/secret-id', root), 405);

  // What an AppRole token may read comes from the policy its role was created with, not from the role name.
  const client = new VaultClient({ address: ADDRESS, fetch: vault.fetch });
  await client.enableKv2(vault.rootToken, 'sol');
  vault.kv.set('secrets/logins/sol_live', { value: 'v' });
  vault.kv.set('config/listener', { A: 'b' });
  const reader = vault.appRoles.get('reader');
  assert.ok(reader !== undefined);
  const readerToken = await client.appRoleLogin(reader);
  assert.deepEqual(await client.readKv(readerToken, 'secrets/logins/sol_live'), { value: 'v' });
  await assert.rejects(client.readKv(readerToken, 'config/listener'), VaultDeniedError);
  await assert.rejects(client.snapshot(readerToken), VaultDeniedError);
  const nightlyToken = await client.appRoleLogin(vault.addAppRole('nightly', 'backup'));
  assert.equal((await client.snapshot(nightlyToken)).length, vault.snapshotBytes.length);
  await assert.rejects(client.readKv(nightlyToken, 'secrets/logins/sol_live'), VaultDeniedError);
});

void test('the stdout audit device is enabled by root alone, once, with the body Vault expects', async () => {
  const vault = new FakeVault();
  const sent: { readonly method: string | undefined; readonly body: unknown }[] = [];
  const recording: VaultFetch = async (url, init) => {
    if (url.endsWith('/v1/sys/audit/file')) {
      sent.push({ method: init.method, body: typeof init.body === 'string' ? JSON.parse(init.body) as unknown : init.body });
    }
    return vault.fetch(url, init);
  };
  const client = new VaultClient({ address: ADDRESS, fetch: recording });

  // Only root administers, and a refused call adds nothing: checked before any device exists, so it is no 400.
  const appRoleToken = await client.appRoleLogin(vault.addAppRole('back'));
  await assert.rejects(client.enableStdoutAudit(appRoleToken),
    (error) => error instanceof VaultDeniedError && error.message === 'vault PUT sys/audit/file: HTTP 403');
  assert.equal(vault.audits.size, 0);

  await client.enableStdoutAudit(vault.rootToken);
  assert.deepEqual([...vault.audits], ['file']);
  assert.deepEqual(sent.at(-1), { method: 'PUT', body: { type: 'file', options: { file_path: 'stdout' } } });

  // A device already at `file/` answers 400.
  await assert.rejects(client.enableStdoutAudit(vault.rootToken),
    (error) => error instanceof VaultDeniedError && error.message === 'vault PUT sys/audit/file: HTTP 400');
  assert.deepEqual([...vault.audits], ['file']);

  // `sys/init` hands out a Vault without any device, and until it is unsealed the route answers 503 like the others.
  vault.initialized = false;
  vault.sealed = true;
  await client.initialize();
  assert.equal(vault.audits.size, 0);
  await assert.rejects(client.enableStdoutAudit(vault.rootToken),
    (error) => error instanceof VaultUnavailableError && error.message === 'vault PUT sys/audit/file: HTTP 503');
  assert.equal(vault.audits.size, 0);
});

void test('a path segment outside the safe alphabet is refused before any request', async () => {
  const vault = new FakeVault();
  const client = new VaultClient({ address: ADDRESS, fetch: vault.fetch });
  for (const path of [
    '', '.', '..', '../sys/seal-status', 'a/../b', 'a//b', '/a', 'a/', 'a?b', 'a#b', 'a%2Fb', 'a b', 'A', 'a\\b',
  ]) {
    await assert.rejects(client.readKv(vault.rootToken, path), /^TypeError: invalid Vault path$/u, JSON.stringify(path));
  }
  // A user name is one segment (it is URL-encoded, so a `/` becomes `%2F`); the other names are checked as paths.
  await assert.rejects(client.userpassLogin('a/b', 'pw'), /^TypeError: invalid Vault path$/u);
  await assert.rejects(client.createUser(vault.rootToken, '../x', 'pw', 'operator'), /^TypeError: invalid Vault path$/u);
  await assert.rejects(client.putPolicy(vault.rootToken, '..', 'p'), /^TypeError: invalid Vault path$/u);
  await assert.rejects(client.createAppRole(vault.rootToken, 'a b'), /^TypeError: invalid Vault path$/u);
  assert.deepEqual(vault.requests, []);

  // Every entry the stack reads, the keypair included, goes through: the fake answers 404, not the guard.
  const paths = [...backEntries('live'), ...backEntries('observe'), ...migrateEntries()].map((entry) => entry.path);
  assert.ok(paths.includes('secrets/back/wallet-keypair.json'));
  for (const path of paths) await assert.rejects(client.readKv(vault.rootToken, path), VaultMissingError, path);
});

void test('the timeouts are integers within what Node timers honour', () => {
  const build = (option: 'timeoutMs' | 'pollIntervalMs', value: number): VaultClient => new VaultClient(
    option === 'timeoutMs' ? { address: ADDRESS, timeoutMs: value } : { address: ADDRESS, pollIntervalMs: value },
  );
  for (const option of ['timeoutMs', 'pollIntervalMs'] as const) {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      assert.throws(
        () => build(option, value),
        new RegExp(`^TypeError: ${option} must be an integer from 1 to 2147483647$`, 'u'),
        `${option} ${String(value)}`,
      );
    }
    assert.doesNotThrow(() => build(option, 1));
    assert.doesNotThrow(() => build(option, 2_147_483_647));
  }
});

void test('AppRole credentials come from a JSON object with two non-empty strings', () => {
  assert.deepEqual(parseAppRoleCredentials('{"role_id":"r","secret_id":"s"}\n'), { role_id: 'r', secret_id: 's' });
  for (const text of ['', 'not json', '{"role_id":"r"}', '{"role_id":"","secret_id":"s"}', '[]']) {
    assert.throws(() => parseAppRoleCredentials(text), /^TypeError: expected an AppRole JSON object$/u);
  }
});
