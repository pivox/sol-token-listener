import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runVaultPullCli, writePulledFile, type VaultPullDependencies } from '../scripts/deploy/vault-pull.js';
import { backEntries } from '../src/deploy/vault-layout.js';
import { FakeVault } from './helpers/fake-vault.js';

interface PullRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly files: ReadonlyMap<string, Readonly<{ content: string; mode: number }>>;
  readonly sleeps: readonly number[];
}

/** Planted in values and error messages: it must never reach stdout or stderr. */
const MARKER = 'marker-that-must-not-leak';

/** A Vault holding every entry of live mode: configurations `LOG_LEVEL=info`, secrets `value-of-<path>`. */
function seededVault(): FakeVault {
  const vault = new FakeVault();
  for (const entry of backEntries('live')) {
    vault.kv.set(entry.path, entry.kind === 'config'
      ? { LOG_LEVEL: 'info' }
      : entry.path === 'secrets/back/helius-listener-accounts'
        ? { '01-main': 'value-of-main' }
        : { value: `value-of-${entry.path}` });
  }
  return vault;
}

async function pull(
  vault: FakeVault,
  argv: readonly string[],
  approle: string,
  options: Readonly<{
    environment?: NodeJS.ProcessEnv;
    onSleep?: () => void;
    /** Called before a file is recorded; throwing makes that write fail. */
    onWrite?: (path: string) => void;
  }> = {},
): Promise<PullRun> {
  let clock = 0;
  const files = new Map<string, Readonly<{ content: string; mode: number }>>();
  const sleeps: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: VaultPullDependencies = {
    fetch: vault.fetch,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
      options.onSleep?.();
    },
    readFile: (path) => {
      if (path !== '/root/vault/approle.json') throw new Error(`unexpected read of ${path}`);
      return approle;
    },
    writeFile: (path, content, mode) => {
      options.onWrite?.(path);
      files.set(path, Object.freeze({ content, mode }));
    },
  };
  const code = await runVaultPullCli(argv, options.environment ?? {}, {
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  }, dependencies);
  return { code, stdout: stdout.join(''), stderr: stderr.join(''), files, sleeps };
}

void test('live writes every configuration 0644 and every secret 0600 at the current paths, then revokes', async () => {
  const vault = seededVault();
  const run = await pull(vault, ['back', 'live'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.files.get('/etc/sol/config/listener.env'), { content: 'LOG_LEVEL=info\n', mode: 0o644 });
  assert.deepEqual(run.files.get('/root/secrets/back/wallet-keypair.json'), {
    content: 'value-of-secrets/back/wallet-keypair.json', mode: 0o600,
  });
  assert.deepEqual(run.files.get('/root/secrets/logins/pg-sol_live-password'), {
    content: 'value-of-secrets/logins/sol_live', mode: 0o600,
  });
  const entries = backEntries('live');
  assert.equal(run.files.size, entries.length);
  assert.deepEqual(JSON.parse(run.stdout), {
    service: 'vault-pull', event: 'vault.pulled', container: 'back', mode: 'live',
    configs: 10, secrets: entries.length - 10, absent: [],
  });
  // One login, no retry, and its token revoked.
  assert.equal(vault.issuedTokens().length, 1);
  assert.ok(vault.issuedTokens().every((token) => vault.isRevoked(token)));
  assert.equal(`${run.stdout}${run.stderr}`.includes('value-of-'), false);
});

void test('observe never reads the keypair and skips absent optional entries', async () => {
  const vault = seededVault();
  vault.kv.delete('config/readiness');
  vault.kv.delete('secrets/back/helius-admin-api-key');
  const run = await pull(vault, ['back', 'observe'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(vault.requests.some((request) => request.includes('wallet-keypair')), false);
  assert.equal([...run.files.keys()].some((path) => path.includes('wallet-keypair')), false);
  assert.deepEqual((JSON.parse(run.stdout) as { absent: string[] }).absent, [
    'config/readiness', 'secrets/back/helius-admin-api-key',
  ]);
});

void test('missing required entries stop the pull before any write and are all named', async () => {
  const vault = seededVault();
  vault.kv.delete('config/live');
  vault.kv.delete('secrets/back/wallet-keypair.json');
  const run = await pull(vault, ['back', 'live'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 78);
  assert.equal(run.files.size, 0);
  assert.equal(run.stderr, 'vault-pull: missing required entries: config/live, secrets/back/wallet-keypair.json\n');
  // Spec 7.3: a missing entry exits at once, with one login and its token revoked.
  assert.deepEqual(run.sleeps, []);
  assert.equal(vault.issuedTokens().length, 1);
  assert.ok(vault.issuedTokens().every((token) => vault.isRevoked(token)));
});

void test('an unavailable Vault is retried every 2 s until the deadline, then exits 69', async () => {
  const sealed = seededVault();
  const approle = JSON.stringify(sealed.addAppRole('back'));
  sealed.sealed = true;
  const failed = await pull(sealed, ['back', 'observe'], approle, { environment: { SOL_VAULT_PULL_TIMEOUT_MS: '10000' } });
  assert.equal(failed.code, 69);
  assert.deepEqual(failed.sleeps, [2000, 2000, 2000, 2000, 2000]);
  assert.equal(failed.stderr, 'vault-pull: Vault unavailable for 10 s (vault POST auth/approle/login: HTTP 503)\n');
  assert.equal(failed.files.size, 0);

  const recovering = seededVault();
  const credentials = JSON.stringify(recovering.addAppRole('back'));
  recovering.unreachable = true;
  const recovered = await pull(recovering, ['back', 'observe'], credentials, {
    onSleep: () => { recovering.unreachable = false; },
  });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.deepEqual(recovered.sleeps, [2000]);
});

void test('a refused AppRole exits 77 and an unreadable AppRole file 78', async () => {
  const vault = seededVault();
  const credentials = vault.addAppRole('back');
  const refused = await pull(vault, ['back', 'observe'], JSON.stringify({ ...credentials, secret_id: 'wrong' }));
  assert.equal(refused.code, 77);
  assert.equal(refused.stderr, 'vault-pull: refused by Vault (vault POST auth/approle/login: HTTP 400)\n');
  // Spec 7.3: a refusal exits at once, it is never retried.
  assert.deepEqual(refused.sleeps, []);
  const unreadable = await pull(vault, ['back', 'observe'], 'not json');
  assert.equal(unreadable.code, 78);
  assert.equal(unreadable.stderr, 'vault-pull: missing or invalid AppRole file /root/vault/approle.json\n');
});

void test('an invalid configuration value exits 78 naming the variable, never the value', async () => {
  const vault = seededVault();
  vault.kv.set('config/listener', { API_HOST: 'leaked#tail' });
  const run = await pull(vault, ['back', 'observe'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 78);
  assert.equal(run.files.size, 0);
  assert.match(run.stderr, /^vault-pull: config\/listener: API_HOST does not survive the \.env format/u);
  assert.equal(run.stderr.includes('leaked'), false);
});

void test('a value that reads as further variables exits 78 without echoing the fragment', async () => {
  const vault = seededVault();
  // dotenv ends the line at the break, so `SECRET_X` would read as a variable of its own.
  vault.kv.set('config/listener', { LOG_LEVEL: 'info\nSECRET_X=1' });
  const run = await pull(vault, ['back', 'observe'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 78);
  assert.equal(run.files.size, 0);
  assert.equal(run.stderr.includes('SECRET_X'), false);
  assert.equal(
    run.stderr,
    'vault-pull: config/listener: LOG_LEVEL does not survive the .env format (#, quotes, outer spaces or line breaks)\n',
  );
});

void test('a configuration the role rules refuse exits 78 at once naming the variable, with nothing written', async () => {
  const vault = seededVault();
  vault.kv.set('config/listener', { API_TOKEN: 'x' });
  const run = await pull(vault, ['back', 'observe'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 78);
  assert.equal(run.files.size, 0);
  assert.deepEqual(run.sleeps, []);
  assert.equal(
    run.stderr,
    'vault-pull: config/listener: API_TOKEN comes from a secret file, not from the configuration\n',
  );
});

void test('an invalid entry read after valid ones still stops the pull before any write', async () => {
  // Entries are read and rendered in layout order. The first comes after nine valid configurations,
  // the second is the very last entry (optional, but present and invalid, so it stops the pull too).
  const cases: readonly Readonly<{ path: string; data: Record<string, unknown>; stderr: string }>[] = [
    {
      path: 'config/retention',
      data: { LOG_LEVEL: `a #${MARKER}` },
      stderr: 'vault-pull: config/retention: LOG_LEVEL does not survive the .env format (#, quotes, outer spaces or line breaks)\n',
    },
    {
      path: 'secrets/logins/sol_worker',
      data: { value: '' },
      stderr: 'vault-pull: secrets/logins/sol_worker: expected a non-empty value field\n',
    },
  ];
  for (const { path, data, stderr } of cases) {
    assert.ok(backEntries('observe').findIndex((entry) => entry.path === path) >= 9, `${path} must come late`);
    const vault = seededVault();
    vault.kv.set(path, data);
    const run = await pull(vault, ['back', 'observe'], JSON.stringify(vault.addAppRole('back')));
    assert.equal(run.code, 78, path);
    assert.equal(run.files.size, 0, path);
    assert.deepEqual(run.sleeps, [], path);
    assert.equal(run.stderr, stderr, path);
    assert.equal(`${run.stdout}${run.stderr}`.includes(MARKER), false, path);
  }
});

void test('an unexpected failure exits 1 naming only an errno code, never a message', async () => {
  const cases: readonly Readonly<{ failure: Error; code: string }>[] = [
    { failure: Object.assign(new Error(`EROFS: read-only file system, open '${MARKER}'`), { code: 'EROFS' }), code: 'EROFS' },
    { failure: new Error(`no code ${MARKER}`), code: 'unknown' },
    { failure: Object.assign(new Error(MARKER), { code: `E_${MARKER}` }), code: 'unknown' },
    { failure: Object.assign(new Error(MARKER), { code: 13 }), code: 'unknown' },
  ];
  for (const { failure, code } of cases) {
    const vault = seededVault();
    const run = await pull(vault, ['back', 'observe'], JSON.stringify(vault.addAppRole('back')), {
      onWrite: () => { throw failure; },
    });
    assert.equal(run.code, 1, code);
    assert.equal(run.stderr, `vault-pull: unexpected failure (${code})\n`);
    assert.equal(`${run.stdout}${run.stderr}`.includes(MARKER), false, code);
  }
});

void test('migrate writes the nine login passwords under its own secrets directory', async () => {
  const vault = seededVault();
  const run = await pull(vault, ['migrate'], JSON.stringify(vault.addAppRole('migrate')));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.files.size, 9);
  assert.ok([...run.files.keys()].every((path) => /^\/root\/secrets\/db\/logins\/pg-sol_[a-z]+-password$/u.test(path)));
  assert.deepEqual(JSON.parse(run.stdout), {
    service: 'vault-pull', event: 'vault.pulled', container: 'migrate', configs: 0, secrets: 9, absent: [],
  });
});

void test('usage errors exit 64', async () => {
  const vault = new FakeVault();
  for (const argv of [[], ['back'], ['back', 'paper'], ['migrate', 'live'], ['front'], ['back', 'live', 'x']]) {
    assert.equal((await pull(vault, argv, '{}')).code, 64, JSON.stringify(argv));
  }
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

void test('the file writer creates owner-only parents for secrets, readable ones for configurations, and the exact mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vault-pull-'));
  try {
    // A strict umask: the 0644 below is the mode the file itself is given, not what open() left.
    withUmask(0o077, () => {
      writePulledFile(join(directory, 'config.env'), 'A=b\n', 0o644);
    });
    // A directory takes its mode from mkdir, minus the umask: the usual 022 tells 0700 from 0755.
    withUmask(0o022, () => {
      writePulledFile(join(directory, 'secrets/back/token'), 'v', 0o600);
      writePulledFile(join(directory, 'config/listener.env'), 'A=b\n', 0o644);
    });
    assert.equal((await stat(join(directory, 'secrets'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'secrets/back'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'secrets/back/token'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'config.env'))).mode & 0o777, 0o644);
    assert.equal((await stat(join(directory, 'config'))).mode & 0o777, 0o755);
    assert.equal((await stat(join(directory, 'config/listener.env'))).mode & 0o777, 0o644);
    assert.equal(await readFile(join(directory, 'secrets/back/token'), 'utf8'), 'v');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('each container writes under the directory its consumer reads', async () => {
  const vault = seededVault();
  const migrate = await pull(vault, ['migrate'], JSON.stringify(vault.addAppRole('migrate')), {
    environment: { SOL_DB_SECRETS_DIR: '/x/db', SOL_SECRETS_DIR: '/wrong', SOL_CONFIG_DIR: '/wrong' },
  });
  assert.equal(migrate.code, 0, migrate.stderr);
  assert.ok([...migrate.files.keys()].every((path) => path.startsWith('/x/db/logins/')));
  const back = await pull(vault, ['back', 'observe'], JSON.stringify(vault.addAppRole('back')), {
    environment: { SOL_SECRETS_DIR: '/x/back', SOL_CONFIG_DIR: '/x/config', SOL_DB_SECRETS_DIR: '/wrong' },
  });
  assert.equal(back.code, 0, back.stderr);
  assert.ok([...back.files.keys()].every((path) => path.startsWith('/x/back/') || path.startsWith('/x/config/')));
  assert.ok([...back.files.keys()].some((path) => path.startsWith('/x/config/')));
});

void test('the listener accounts entry becomes its compact JSON file, names sorted', async () => {
  const vault = seededVault();
  vault.kv.set('secrets/back/helius-listener-accounts', { '02-spare': 'key-spare', '01-main': 'key-main' });
  const run = await pull(vault, ['back', 'live'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.files.get('/root/secrets/back/helius-listener-accounts'), {
    content: '{"01-main":"key-main","02-spare":"key-spare"}', mode: 0o600,
  });
});

void test('an invalid accounts entry stops the pull with 78, writes nothing and shows no key', async () => {
  const vault = seededVault();
  vault.kv.set('secrets/back/helius-listener-accounts', { '01-main': 'key with space' });
  const run = await pull(vault, ['back', 'live'], JSON.stringify(vault.addAppRole('back')));
  assert.equal(run.code, 78);
  assert.equal(run.stderr, 'vault-pull: secrets/back/helius-listener-accounts: 01-main must be one printable line without spaces\n');
  assert.equal(run.files.size, 0);
});
