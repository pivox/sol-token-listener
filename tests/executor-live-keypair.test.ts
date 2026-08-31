import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import type { LiveExecutorConfig } from '../src/executor-live/config.js';
import {
  LiveKeypairError,
  loadLiveTransactionSigner,
  type LiveKeypairFilesystem,
} from '../src/executor-live/keypair-loader.js';

void test('loads a 0600 owned canonical keypair, signs and closes deterministically', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'executor-live-keypair-'));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const keypair = Keypair.generate();
  const path = join(directory, 'keypair.json');
  await writeFile(path, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
  await chmod(path, 0o600);

  const signer = await loadLiveTransactionSigner(config(path, keypair.publicKey.toBase58()));
  const message = Uint8Array.from([1, 2, 3, 4]);
  const signed = await signer.signMessage(message);
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    keypair.publicKey.toBuffer(),
  ]);
  assert.equal(signed.signature.length, 64);
  assert.equal(verify(null, message, createPublicKey({ key: spki, format: 'der', type: 'spki' }), signed.signature), true);
  assert.equal(signer.publicKey, keypair.publicKey.toBase58());

  await signer.close();
  await signer.close();
  await assert.rejects(signer.signMessage(message), /Live transaction signer is closed/u);
});

void test('rejects symlinks, permissive modes, malformed payloads and wallet mismatch without leaking', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'executor-live-reject-'));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const keypair = Keypair.generate();
  const valid = join(directory, 'valid.json');
  const link = join(directory, 'link.json');
  await writeFile(valid, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
  await symlink(valid, link);

  await assertKeypairFailure(config(link, keypair.publicKey.toBase58()), [link]);
  await chmod(valid, 0o644);
  await assertKeypairFailure(config(valid, keypair.publicKey.toBase58()), [valid]);
  await chmod(valid, 0o600);
  await assertKeypairFailure(config(valid, Keypair.generate().publicKey.toBase58()), [valid]);
  await writeFile(valid, `${JSON.stringify([...keypair.secretKey])}\n`, { mode: 0o600 });
  await assertKeypairFailure(config(valid, keypair.publicKey.toBase58()), [valid]);
});

void test('erases every readable secret buffer after importing it', async () => {
  const keypair = Keypair.generate();
  const raw = Buffer.from(JSON.stringify([...keypair.secretKey]), 'utf8');
  let closed = false;
  const stats = await lstat(new URL(import.meta.url));
  const filesystem: LiveKeypairFilesystem = {
    async open() {
      return {
        async stat() {
          return {
            isFile: () => true,
            isSymbolicLink: () => false,
            mode: 0o100600,
            uid: typeof process.getuid === 'function' ? process.getuid() : stats.uid,
            size: raw.length,
          };
        },
        async readFile() { return raw; },
        async close() { closed = true; },
      };
    },
  };
  const signer = await loadLiveTransactionSigner(
    config('/run/secrets/keypair.json', keypair.publicKey.toBase58()),
    filesystem,
  );
  assert.equal(closed, true);
  assert.equal(raw.every((byte) => byte === 0), true);
  await signer.close();
});

function config(path: string, executorPublicKey: string): LiveExecutorConfig {
  return Object.freeze({
    mode: 'live', liveTradingEnabled: true, cluster: 'mainnet-beta',
    databaseUrl: 'postgresql://localhost/test', pollMs: 1_000, leaseMs: 60_000,
    databaseStatementTimeoutMs: 3_000, shutdownGraceMs: 10_000,
    generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    executorPublicKey, keypairPath: path, providerId: 'primary',
    httpRpcUrl: 'https://rpc.example.test',
    expectedGenesisHash: '11111111111111111111111111111111',
    buildHash: 'b'.repeat(64), configurationFingerprint: 'c'.repeat(64),
    strategyFingerprint: 'd'.repeat(64), phase: 'CANARY', quoteMaxAgeMs: 3_000,
    slippageBps: 500n, snapshotMaxSlotLag: 8, maxComputeUnits: 300_000n,
    maxFeeLamports: 100_000n, maxFeePayerLamportDebit: 2_500_000n,
    maxPriorityFeeLamports: 0n, rpcTimeoutMs: 5_000,
    maxRpcCallsPerAttempt: 8, quoteMintAllowlist: Object.freeze([
      'So11111111111111111111111111111111111111112',
    ] as const),
  });
}

async function assertKeypairFailure(
  input: LiveExecutorConfig,
  forbidden: readonly string[],
): Promise<void> {
  await assert.rejects(
    loadLiveTransactionSigner(input),
    (error: unknown) => error instanceof LiveKeypairError
      && (error.code === 'KEYPAIR_UNAVAILABLE' || error.code === 'KEYPAIR_PERMISSIONS_INVALID')
      && forbidden.every((secret) => !error.message.includes(secret)),
  );
}
