import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDistributeSecretsCli } from '../scripts/deploy/distribute-secrets.js';
import {
  SecretDistributionError,
  distributeSecrets,
  secretGrants,
  type DistributionFileSystem,
} from '../src/deploy/secret-distribution.js';

function describe(mode: 'observe' | 'live', user: string): string[] {
  return secretGrants(mode)
    .filter((grant) => grant.user === user)
    .map((grant) => `${grant.source}/${grant.file}${grant.required ? '' : ' (optional)'}`)
    .sort();
}

void test('live grants give every program its own secrets and nothing else', () => {
  assert.deepEqual(describe('live', 'listener'), [
    'back/helius-listener-accounts', 'logins/pg-sol_listener-password',
  ]);
  assert.deepEqual(describe('live', 'h2b'), [
    'back/helius-executor-http-url', 'back/wallet-keypair.json', 'logins/pg-sol_live-password',
  ]);
  assert.deepEqual(describe('live', 'h2a'), [
    'back/helius-executor-http-url', 'logins/pg-sol_recovery-password',
  ]);
  assert.deepEqual(describe('live', 'autoarm'), [
    'back/helius-executor-http-url', 'logins/pg-sol_autoarm-password',
  ]);
  assert.deepEqual(describe('live', 'opapi'), [
    'back/helius-executor-http-url', 'back/operator-api-token', 'logins/pg-sol_reader-password',
  ]);
  assert.deepEqual(describe('live', 'retention'), ['logins/pg-sol_retention-password']);
  assert.deepEqual(describe('live', 'worker'), [
    'back/helius-executor-http-url (optional)', 'logins/pg-sol_worker-password (optional)',
  ]);
  assert.deepEqual(describe('live', 'ops'), [
    'back/evidence-private-key (optional)',
    'back/helius-admin-api-key (optional)',
    'back/helius-executor-http-url (optional)',
    'logins/pg-sol_ops-password',
    'logins/pg-sol_readiness-password (optional)',
  ]);
});

void test('observe needs only the listener, operator API and retention secrets', () => {
  const required = secretGrants('observe')
    .filter((grant) => grant.required)
    .map((grant) => `${grant.user}:${grant.file}`)
    .sort();
  assert.deepEqual(required, [
    'listener:helius-listener-accounts',
    'listener:pg-sol_listener-password',
    'opapi:helius-executor-http-url',
    'opapi:operator-api-token',
    'opapi:pg-sol_reader-password',
    'retention:pg-sol_retention-password',
  ]);
});

function recordingFileSystem(present: readonly string[]): Readonly<{
  fs: DistributionFileSystem;
  operations: string[];
}> {
  const files = new Set(present);
  const operations: string[] = [];
  return {
    operations,
    fs: {
      exists: (path) => files.has(path),
      makeDirectory: (path, mode) => { operations.push(`mkdir ${path} ${mode.toString(8)}`); },
      copy: (source, target) => { operations.push(`copy ${source} ${target}`); },
      chown: (path, uid, gid) => { operations.push(`chown ${path} ${uid}:${gid}`); },
      chmod: (path, mode) => { operations.push(`chmod ${path} ${mode.toString(8)}`); },
    },
  };
}

const OBSERVE_REQUIRED = Object.freeze([
  '/s/logins/pg-sol_listener-password',
  '/s/back/helius-listener-accounts',
  '/s/back/helius-executor-http-url',
  '/s/logins/pg-sol_reader-password',
  '/s/back/operator-api-token',
  '/s/logins/pg-sol_retention-password',
]);

void test('distribution copies present secrets owner-only, and the keypair to H2b alone', () => {
  const { fs, operations } = recordingFileSystem([...OBSERVE_REQUIRED, '/s/back/wallet-keypair.json']);
  const copied = distributeSecrets({ mode: 'observe', secretsDirectory: '/s', runDirectory: '/r', fs });
  assert.equal(copied, operations.filter((operation) => operation.startsWith('copy ')).length);
  assert.deepEqual(operations.slice(0, 3), [
    'mkdir /r/listener 700', 'chown /r/listener 10001:10001', 'chmod /r/listener 700',
  ]);
  assert.deepEqual(operations.filter((operation) => operation.includes('wallet-keypair.json')), [
    'copy /s/back/wallet-keypair.json /r/h2b/wallet-keypair.json',
    'chown /r/h2b/wallet-keypair.json 10002:10002',
    'chmod /r/h2b/wallet-keypair.json 400',
  ]);
  assert.ok(operations.includes('copy /s/back/helius-executor-http-url /r/opapi/helius-executor-http-url'));
});

void test('only the listener user receives the Helius account list, in both modes', () => {
  for (const mode of ['observe', 'live'] as const) {
    const holders = secretGrants(mode).filter(({ file }) => file === 'helius-listener-accounts').map(({ user }) => user);
    assert.deepEqual(holders, ['listener']);
  }
});

void test('a missing required secret stops the distribution before any write', () => {
  const { fs, operations } = recordingFileSystem(OBSERVE_REQUIRED.slice(1));
  assert.throws(
    () => distributeSecrets({ mode: 'observe', secretsDirectory: '/s', runDirectory: '/r', fs }),
    (error: unknown) => error instanceof SecretDistributionError
      && error.message === 'missing required secret files for observe: logins/pg-sol_listener-password',
  );
  assert.deepEqual(operations, []);
});

void test('the command refuses a non-root caller and an unknown mode', () => {
  const err: string[] = [];
  const io = { stdout: () => undefined, stderr: (text: string) => { err.push(text); } };
  const { fs } = recordingFileSystem([]);
  assert.equal(runDistributeSecretsCli(['live'], {}, io, { uid: 1000, fs }), 77);
  assert.equal(runDistributeSecretsCli(['prod'], {}, io, { uid: 0, fs }), 64);
  assert.equal(
    runDistributeSecretsCli(['live'], { SOL_SECRETS_DIR: '/s', SOL_RUN_DIR: '/r' }, io, { uid: 0, fs }),
    78,
  );
  assert.match(err.at(-1) ?? '', /^sol-entrypoint: missing required secret files for live: /u);
});
