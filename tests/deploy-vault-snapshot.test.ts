import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runVaultSnapshotCli } from '../scripts/deploy/vault-snapshot.js';
import { FakeVault } from './helpers/fake-vault.js';

async function snapshot(vault: FakeVault, input: string, argv: readonly string[] = []) {
  const chunks: Uint8Array[] = [];
  const stderr: string[] = [];
  const code = await runVaultSnapshotCli(argv, {}, input, async (chunk) => { chunks.push(chunk); }, {
    stderr: (text) => { stderr.push(text); },
  }, vault.fetch);
  return { code, bytes: Buffer.concat(chunks), stderr: stderr.join('') };
}

void test('the backup AppRole streams the raft snapshot to the output, then revokes its token', async () => {
  const vault = new FakeVault();
  const run = await snapshot(vault, `${JSON.stringify(vault.addAppRole('backup'))}\n`);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual([...run.bytes], [...vault.snapshotBytes]);
  assert.ok(vault.issuedTokens().length === 1 && vault.isRevoked(vault.issuedTokens()[0] ?? ''));
});

void test('another AppRole is refused, a sealed Vault is unavailable, bad input is a usage error', async () => {
  const vault = new FakeVault();
  const back = await snapshot(vault, JSON.stringify(vault.addAppRole('back')));
  assert.equal(back.code, 77);
  assert.equal(back.stderr, 'vault-snapshot: refused by Vault (vault GET sys/storage/raft/snapshot: HTTP 403)\n');
  assert.equal(back.bytes.length, 0);
  const invalid = await snapshot(vault, 'not json');
  assert.equal(invalid.code, 78);
  assert.equal(invalid.stderr, 'vault-snapshot: expected the backup AppRole JSON on stdin\n');
  vault.sealed = true;
  assert.equal((await snapshot(vault, JSON.stringify(vault.addAppRole('backup')))).code, 69);
  assert.equal((await snapshot(vault, '{}', ['extra'])).code, 64);
});

void test('an answer that is no gzip snapshot is refused before any byte is written', async () => {
  for (const bytes of [Uint8Array.from([]), Uint8Array.from([0x1f]), Uint8Array.from([0x50, 0x4b, 0x03, 0x04])]) {
    const vault = new FakeVault();
    vault.snapshotBytes = bytes;
    const run = await snapshot(vault, JSON.stringify(vault.addAppRole('backup')));
    assert.equal(run.code, 69, String([...bytes]));
    assert.equal(run.stderr, 'vault-snapshot: Vault answered no gzip snapshot\n');
    assert.equal(run.bytes.length, 0);
    assert.ok(vault.issuedTokens().length === 1 && vault.isRevoked(vault.issuedTokens()[0] ?? ''));
  }
});

void test('an output that fails is reported by its errno code only, and the token is still revoked', async () => {
  const vault = new FakeVault();
  const stderr: string[] = [];
  const code = await runVaultSnapshotCli([], {}, JSON.stringify(vault.addAppRole('backup')), async () => {
    throw Object.assign(new Error('write failed: marker-that-must-not-leak'), { code: 'EPIPE' });
  }, { stderr: (text) => { stderr.push(text); } }, vault.fetch);
  assert.equal(code, 1);
  assert.equal(stderr.join(''), 'vault-snapshot: snapshot failed (EPIPE)\n');
  assert.ok(vault.issuedTokens().length === 1 && vault.isRevoked(vault.issuedTokens()[0] ?? ''));
});
