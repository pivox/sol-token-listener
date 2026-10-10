import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runVaultImportCli } from '../scripts/deploy/vault-import.js';
import { FakeVault } from './helpers/fake-vault.js';

const PASSWORD = 'operator-password-0123456789';

function operatorVault(): FakeVault {
  const vault = new FakeVault();
  vault.users.set('operator', Object.freeze({ password: PASSWORD, policy: 'operator' }));
  return vault;
}

async function withSource(files: Readonly<Record<string, string>>, body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'vault-import-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), content);
    }
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function importInto(vault: FakeVault, directory: string, input: string, environment: NodeJS.ProcessEnv = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runVaultImportCli([], { SOL_IMPORT_DIR: directory, ...environment }, input, {
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  }, { fetch: vault.fetch, exists: (path) => existsSync(path), readFile: (path) => readFileSync(path, 'utf8') });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

const SOURCE = Object.freeze({
  'env/listener.env': [
    'API_HOST=127.0.0.1', 'LOG_LEVEL=info', 'DATABASE_URL=postgresql://u:p@h/db',
    'SOLANA_HTTP_RPC_URL=https://rpc.invalid/?api-key=listener-key',
    'SOLANA_WS_RPC_URL=wss://rpc.invalid/?api-key=listener-key', '',
  ].join('\n'),
  'env/live.env': 'EXECUTOR_PHASE=CANARY\nSOLANA_HTTP_RPC_URL="https://exec.invalid/?api-key=executor-key"\nEXECUTOR_KEYPAIR_PATH=/host/keypair.json\n',
  'env/operations.env': 'EXECUTOR_PREFLIGHT_EVIDENCE_PATH=/Users/me/lot5/evidence/bundle/qualification.json\n',
  'templates/retention.env.example': 'RETENTION_HOURS=4\n',
  // The role file wins whole: its template is neither merged into it (LOG_LEVEL, TEMPLATE_ONLY) nor counted as imported.
  'templates/listener.env.example': 'API_HOST=template\nLOG_LEVEL=debug\nTEMPLATE_ONLY=1\n',
  'keys/wallet-keypair.json': '[1,2,3]\n',
});

void test('the import maps role files, key files and templates into Vault and prints only names', async () => {
  await withSource(SOURCE, async (directory) => {
    const vault = operatorVault();
    const run = await importInto(vault, directory, `${PASSWORD}\n`, { SOL_IMPORT_EVIDENCE_PREFIX: '/Users/me/lot5/evidence' });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(vault.kv.get('config/listener'), {
      API_HOST: '0.0.0.0', API_PORT: '3000', LOG_LEVEL: 'info',
      HELIUS_RPC_HTTP_URL: 'https://rpc.invalid/', HELIUS_RPC_WS_URL: 'wss://rpc.invalid/',
    });
    assert.deepEqual(vault.kv.get('config/live'), { EXECUTOR_PHASE: 'CANARY' });
    assert.deepEqual(vault.kv.get('config/operations'), {
      EXECUTOR_PREFLIGHT_EVIDENCE_PATH: '/var/lib/sol/evidence/bundle/qualification.json',
    });
    assert.deepEqual(vault.kv.get('config/retention'), { RETENTION_HOURS: '4' });
    assert.deepEqual(vault.kv.get('secrets/back/helius-listener-accounts'), { '01': 'listener-key' });
    assert.equal(vault.kv.get('secrets/back/helius-listener-http-url'), undefined);
    assert.deepEqual(vault.kv.get('secrets/back/helius-executor-http-url'), { value: 'https://exec.invalid/?api-key=executor-key' });
    assert.deepEqual(vault.kv.get('secrets/back/wallet-keypair.json'), { value: '[1,2,3]\n' });
    assert.deepEqual(JSON.parse(run.stdout), {
      service: 'vault-import', event: 'vault.imported',
      configs: ['listener', 'live', 'operations'], templates: ['retention'],
      secrets: ['helius-listener-accounts', 'helius-executor-http-url', 'wallet-keypair.json'],
    });
    for (const value of ['listener-key', 'executor-key', '[1,2,3]', PASSWORD]) {
      assert.equal(`${run.stdout}${run.stderr}`.includes(value), false, value);
    }
    assert.ok(vault.issuedTokens().length === 1 && vault.isRevoked(vault.issuedTokens()[0] ?? ''));
  });
});

void test('an evidence path is rewritten only under the prefix directory itself', async () => {
  await withSource({
    'env/operations.env': [
      'EXECUTOR_PREFLIGHT_EVIDENCE_PATH=/Users/me/lot5/evidence/bundle/qualification.json',
      'EXECUTOR_EVIDENCE_DIRECTORY=/Users/me/lot5/evidence',
      'EXECUTOR_ARCHIVE_PATH=/Users/me/lot5/evidence-old/bundle.json', '',
    ].join('\n'),
    // A template holds no value of its own for a URL secret: those come from role files only.
    'templates/live.env.example': 'SOLANA_HTTP_RPC_URL=https://template.invalid\n',
  }, async (directory) => {
    const vault = operatorVault();
    const run = await importInto(vault, directory, `${PASSWORD}\n`, { SOL_IMPORT_EVIDENCE_PREFIX: '/Users/me/lot5/evidence/' });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(vault.kv.get('config/operations'), {
      EXECUTOR_PREFLIGHT_EVIDENCE_PATH: '/var/lib/sol/evidence/bundle/qualification.json',
      EXECUTOR_EVIDENCE_DIRECTORY: '/var/lib/sol/evidence',
      EXECUTOR_ARCHIVE_PATH: '/Users/me/lot5/evidence-old/bundle.json',
    });
    assert.equal(vault.kv.has('secrets/back/helius-executor-http-url'), false);
  });

  // The host script passes a relative directory argument with its dot segments as typed: they must
  // not make the prefix miss the absolute paths of the role files.
  for (const prefix of ['/Users/me/lot5/env/../evidence', '/Users/me/lot5/./evidence/', '/Users/me//lot5/evidence']) {
    await withSource({
      'env/operations.env': [
        'EXECUTOR_PREFLIGHT_EVIDENCE_PATH=/Users/me/lot5/evidence/x',
        'EXECUTOR_ARCHIVE_PATH=/Users/me/lot5/evidence-old/x', '',
      ].join('\n'),
    }, async (directory) => {
      const vault = operatorVault();
      const run = await importInto(vault, directory, `${PASSWORD}\n`, { SOL_IMPORT_EVIDENCE_PREFIX: prefix });
      assert.equal(run.code, 0, `${prefix}: ${run.stderr}`);
      assert.deepEqual(vault.kv.get('config/operations'), {
        EXECUTOR_PREFLIGHT_EVIDENCE_PATH: '/var/lib/sol/evidence/x',
        EXECUTOR_ARCHIVE_PATH: '/Users/me/lot5/evidence-old/x',
      }, prefix);
    });
  }
});

void test('the executor key is refused as the listener key, with nothing written', async () => {
  await withSource({
    ...SOURCE,
    'env/listener.env': 'SOLANA_HTTP_RPC_URL=https://rpc.invalid/?api-key=executor-key\nSOLANA_WS_RPC_URL=wss://rpc.invalid/?api-key=executor-key\n',
  }, async (directory) => {
    const vault = operatorVault();
    const run = await importInto(vault, directory, `${PASSWORD}\n`);
    assert.equal(run.code, 78);
    assert.equal(run.stderr, 'vault-import: listener.env: the listener key is the executor key\n');
    assert.equal(vault.kv.size, 0);
  });
});

void test('an invalid source is refused before the login, with nothing written', async () => {
  for (const [file, content, message] of [
    // A URL secret meets the rule boot applies (rpcUrl): one that imports must also start the back.
    ['env/listener.env', 'SOLANA_HTTP_RPC_URL=http://insecure.invalid\n', 'vault-import: listener.env: SOLANA_HTTP_RPC_URL: expected a https URL\n'],
    ['env/listener.env', 'SOLANA_WS_RPC_URL=https://rpc.invalid/\n', 'vault-import: listener.env: SOLANA_WS_RPC_URL: expected a wss URL\n'],
    ['env/listener.env', 'SOLANA_HTTP_RPC_URL=not-a-url\n', 'vault-import: listener.env: SOLANA_HTTP_RPC_URL: not a URL\n'],
    // U+200B is invisible and outside the printable ASCII range: boot refuses it, so does the import.
    ['env/listener.env', 'SOLANA_HTTP_RPC_URL="https://rpc.invalid/\u200b"\n', 'vault-import: listener.env: SOLANA_HTTP_RPC_URL: expected one printable line without spaces\n'],
    ['env/listener.env', 'SOLANA_HTTP_RPC_URL=https://rpc.invalid/?api-key=a\nSOLANA_WS_RPC_URL=wss://rpc.invalid/?api-key=b\n',
      'vault-import: listener.env: SOLANA_HTTP_RPC_URL and SOLANA_WS_RPC_URL carry different api-key values\n'],
    ['env/listener.env', 'SOLANA_HTTP_RPC_URL=https://rpc.invalid/\nSOLANA_WS_RPC_URL=wss://rpc.invalid/\n',
      'vault-import: listener.env: SOLANA_HTTP_RPC_URL has no api-key parameter\n'],
    ['env/listener.env', 'SOLANA_HTTP_RPC_URL=https://rpc.invalid/?api-key=a\n',
      'vault-import: listener.env: SOLANA_HTTP_RPC_URL and SOLANA_WS_RPC_URL go together\n'],
    ['env/listener.env', 'API_TOKEN=x\n', 'vault-import: config/listener: API_TOKEN comes from a secret file, not from the configuration\n'],
    ['keys/wallet-keypair.json', ' \n', 'vault-import: keys/wallet-keypair.json is empty\n'],
  ] as const) {
    await withSource({ [file]: content }, async (directory) => {
      const vault = operatorVault();
      const run = await importInto(vault, directory, `${PASSWORD}\n`);
      assert.equal(run.code, 78, file);
      assert.equal(run.stderr, message);
      assert.equal(vault.kv.size, 0);
      assert.deepEqual(vault.requests, []);
    });
  }
  await withSource({}, async (directory) => {
    const run = await importInto(operatorVault(), directory, `${PASSWORD}\n`);
    assert.equal(run.code, 78);
    assert.equal(run.stderr, `vault-import: no role file under ${directory}/env\n`);
  });
});

void test('a source without role files is refused: the templates and the key files never make an import alone', async () => {
  // The host script always mounts the templates: a wrong source directory would otherwise replace every config/* with placeholders.
  await withSource({
    'templates/retention.env.example': 'RETENTION_HOURS=4\n',
    'templates/listener.env.example': 'API_HOST=template\n',
    'keys/wallet-keypair.json': '[1,2,3]\n',
  }, async (directory) => {
    const vault = operatorVault();
    const run = await importInto(vault, directory, `${PASSWORD}\n`);
    assert.equal(run.code, 78);
    assert.equal(run.stderr, `vault-import: no role file under ${directory}/env\n`);
    assert.equal(vault.kv.size, 0);
    assert.deepEqual(vault.requests, []);
  });
});

void test('a wrong password exits 77, a sealed Vault 69, and usage errors 64', async () => {
  await withSource(SOURCE, async (directory) => {
    const vault = operatorVault();
    const refused = await importInto(vault, directory, 'wrong-password\n');
    assert.equal(refused.code, 77);
    assert.equal(refused.stderr, 'vault-import: refused by Vault (vault POST auth/userpass/login/operator: HTTP 400)\n');
    assert.equal(vault.kv.size, 0);
    vault.sealed = true;
    assert.equal((await importInto(vault, directory, `${PASSWORD}\n`)).code, 69);
    assert.equal((await importInto(vault, directory, '\n')).code, 64);
  });
});
