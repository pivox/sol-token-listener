import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  VAULT_APPROLES,
  VAULT_POLICIES,
  runVaultSetupCli,
  writeSecretFile,
  type VaultSetupDependencies,
} from '../scripts/deploy/vault-setup.js';
import type { VaultFetch } from '../src/deploy/vault-client.js';
import { DATABASE_LOGIN_NAMES } from '../src/deploy/stack.js';
import { FakeVault } from './helpers/fake-vault.js';

interface SetupRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly files: ReadonlyMap<string, string>;
}

async function setup(
  vault: FakeVault,
  options: Readonly<{ fetch?: VaultFetch; missingPolicy?: string; failWrite?: string }> = {},
): Promise<SetupRun> {
  const files = new Map<string, string>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  let draws = 0;
  const dependencies: VaultSetupDependencies = {
    fetch: options.fetch ?? vault.fetch,
    readFile: (path) => {
      const name = /^\/etc\/sol\/vault\/policies\/([a-z]+)\.hcl$/u.exec(path)?.[1];
      if (name === undefined || name === options.missingPolicy) throw new Error(`no ${path}`);
      return `# policy ${name}\n`;
    },
    writeSecretFile: (path, content) => {
      if (path === options.failWrite) throw Object.assign(new Error(`marker ${content}`), { code: 'EACCES' });
      if (files.has(path)) throw new Error(`overwrite of ${path}`);
      files.set(path, content);
    },
    random: (bytes) => {
      draws += 1;
      return Buffer.alloc(bytes, draws);
    },
  };
  const code = await runVaultSetupCli(['init'], {}, {
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  }, dependencies);
  return { code, stdout: stdout.join(''), stderr: stderr.join(''), files };
}

function freshVault(): FakeVault {
  const vault = new FakeVault();
  vault.initialized = false;
  vault.sealed = true;
  return vault;
}

void test('init unseals, configures Vault and writes only the unseal key and the AppRole files', async () => {
  const vault = freshVault();
  const run = await setup(vault);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(vault.sealed, false);
  assert.deepEqual([...vault.mounts], ['sol']);
  assert.deepEqual([...vault.auths].sort(), ['approle', 'userpass']);
  // Both secrets are random: a lockout would only let a wrong AppRole file lock the back out.
  assert.deepEqual([...vault.lockoutDisabled].sort(), ['approle', 'userpass']);
  assert.deepEqual([...vault.audits], ['file']);
  // The audit device comes right after the unseal, so that every later request is audited, and
  // each auth method loses its lockout right after it is enabled.
  assert.deepEqual(vault.requests.slice(0, 10), [
    'GET sys/seal-status', 'PUT sys/init', 'PUT sys/unseal', 'GET sys/health', 'PUT sys/audit/file', 'POST sys/mounts/sol',
    'POST sys/auth/approle', 'POST sys/auth/approle/tune', 'POST sys/auth/userpass', 'POST sys/auth/userpass/tune',
  ]);
  assert.deepEqual([...vault.policies.keys()].sort(), [...VAULT_POLICIES].sort());
  for (const name of VAULT_POLICIES) assert.equal(vault.policies.get(name), `# policy ${name}\n`);
  assert.deepEqual([...vault.appRoles.keys()].sort(), [...VAULT_APPROLES].sort());
  assert.deepEqual([...run.files.keys()].sort(), [
    '/out/approle/back.json', '/out/approle/backup.json', '/out/approle/migrate.json', '/out/unseal/unseal-key',
  ]);
  assert.equal(run.files.get('/out/unseal/unseal-key'), `${vault.unsealKey}\n`);
  assert.deepEqual(JSON.parse(run.files.get('/out/approle/back.json') ?? ''), vault.appRoles.get('back'));
  for (const login of DATABASE_LOGIN_NAMES) {
    assert.match(String(vault.kv.get(`secrets/logins/${login}`)?.value), /^[0-9a-f]{64}$/u, login);
  }
  assert.match(String(vault.kv.get('secrets/back/operator-api-token')?.value), /^[0-9a-f]{64}$/u);
  const operator = vault.users.get('operator');
  assert.equal(operator?.policy, 'operator');
  assert.match(operator?.password ?? '', /^[A-Za-z0-9_-]{32}$/u);
  assert.equal(vault.isRevoked(vault.rootToken), true);
  const lines = run.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    service: 'vault-setup', event: 'vault.initialized', approles: ['back', 'migrate', 'backup'], logins: 9,
  });
  assert.equal(
    lines[1],
    `Vault operator password, shown once (store it in your password manager): ${operator?.password ?? ''}`,
  );
  for (const value of [
    vault.unsealKey, vault.rootToken, vault.appRoles.get('back')?.secret_id ?? '',
    String(vault.kv.get('secrets/logins/sol_live')?.value),
  ]) {
    assert.equal(`${run.stdout}${run.stderr}`.includes(value), false);
  }
});

void test('an initialized Vault is refused before any change', async () => {
  const vault = new FakeVault();
  const run = await setup(vault);
  assert.equal(run.code, 78);
  assert.equal(run.stderr, 'vault-setup: Vault is already initialized; nothing changed\n');
  assert.equal(run.files.size, 0);
  assert.deepEqual(vault.requests, ['GET sys/seal-status']);
});

void test('a missing policy file stops the setup before any request', async () => {
  const vault = freshVault();
  const run = await setup(vault, { missingPolicy: 'backup' });
  assert.equal(run.code, 78);
  assert.equal(run.stderr, 'vault-setup: missing policy file /etc/sol/vault/policies/backup.hcl\n');
  assert.deepEqual(vault.requests, []);
});

void test('the unseal key is saved before a later failure, and the message says so', async () => {
  const vault = freshVault();
  const failing: VaultFetch = async (url, init) => {
    if (url.endsWith('/v1/sys/mounts/sol')) throw new TypeError('fetch failed');
    return vault.fetch(url, init);
  };
  const run = await setup(vault, { fetch: failing });
  assert.equal(run.code, 69);
  assert.deepEqual([...run.files.keys()], ['/out/unseal/unseal-key']);
  assert.equal(
    run.stderr,
    'vault-setup: Vault unavailable (vault POST sys/mounts/sol: unreachable); the unseal key is saved: start over as the runbook says\n',
  );
});

void test('an unseal key that cannot be saved is reported as lost, by its errno code only', async () => {
  const vault = freshVault();
  const run = await setup(vault, { failWrite: '/out/unseal/unseal-key' });
  assert.equal(run.code, 1);
  assert.equal(
    run.stderr,
    'vault-setup: setup failed (EACCES); Vault may be initialized but its unseal key was not saved: start over as the runbook says\n',
  );
  assert.equal(run.files.size, 0);
  assert.equal(vault.initialized, true);
  assert.equal(vault.sealed, true);
});

void test('a sys/init whose answer is lost is flagged: Vault may be initialized and no key was saved', async () => {
  const vault = freshVault();
  // Vault processes the request, then the connection dies: the keys exist, and nobody holds them.
  const dying: VaultFetch = async (url, init) => {
    const response = await vault.fetch(url, init);
    if (url.endsWith('/v1/sys/init')) throw new TypeError('fetch failed');
    return response;
  };
  const run = await setup(vault, { fetch: dying });
  assert.equal(run.code, 69);
  assert.equal(
    run.stderr,
    'vault-setup: Vault unavailable (vault PUT sys/init: unreachable); Vault may be initialized but its unseal key was not saved: start over as the runbook says\n',
  );
  assert.equal(run.stdout, '');
  assert.equal(run.files.size, 0);
  assert.equal(vault.initialized, true);
});

void test('usage errors exit 64', async () => {
  const errors: string[] = [];
  const code = await runVaultSetupCli([], {}, { stdout: () => undefined, stderr: (text) => { errors.push(text); } });
  assert.equal(code, 64);
  assert.deepEqual(errors, ['usage: vault-setup init\n']);
});

/** Runs the synchronous `action` under `mask`, then restores the umask of the process. */
function withUmask(mask: number, action: () => void): void {
  const previous = process.umask(mask);
  try {
    action();
  } finally {
    process.umask(previous);
  }
}

void test('the file writer creates owner-only parents and files, never overwrites, and sets the exact mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vault-setup-'));
  try {
    // The usual 022 tells 0700 and 0600 from the 0755 and 0644 that mkdir() and open() leave by default.
    withUmask(0o022, () => {
      writeSecretFile(join(directory, 'unseal/unseal-key'), 'key\n');
    });
    assert.equal((await stat(join(directory, 'unseal'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'unseal/unseal-key'))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(directory, 'unseal/unseal-key'), 'utf8'), 'key\n');
    // An existing file is never replaced: the unseal key has no other copy.
    assert.throws(() => { writeSecretFile(join(directory, 'unseal/unseal-key'), 'other\n'); }, { code: 'EEXIST' });
    assert.equal(await readFile(join(directory, 'unseal/unseal-key'), 'utf8'), 'key\n');
    // A umask that strips an owner bit leaves 0400 at creation; the file is 0600 all the same.
    withUmask(0o200, () => {
      writeSecretFile(join(directory, 'unseal/approle.json'), '{}\n');
    });
    assert.equal((await stat(join(directory, 'unseal/approle.json'))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
