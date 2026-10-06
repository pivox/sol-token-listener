import assert from 'node:assert/strict';
import { mkdtemp, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Keypair, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { loadLiveKeypairFile, verifySerializedLiveTransaction } from '../src/live/keypair-live-signer.js';

void test('isolated keyfile loader signs and verifies an offline disposable key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-listener-live-key-'));
  try {
    const keypair = Keypair.fromSeed(new Uint8Array(32).fill(41));
    const file = join(directory, 'throwaway.json');
    await writeFile(file, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
    await chmod(file, 0o600);
    const signer = await loadLiveKeypairFile(file, keypair.publicKey.toBase58(), process.cwd());
    const transaction = new VersionedTransaction(new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: Keypair.fromSeed(new Uint8Array(32).fill(42)).publicKey.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: Keypair.fromSeed(new Uint8Array(32).fill(43)).publicKey, lamports: 1 })],
    }).compileToV0Message());
    const signed = signer.sign(transaction);

    assert.equal(signer.publicKey, keypair.publicKey.toBase58());
    assert.equal(verifySerializedLiveTransaction(signed.bytes, keypair.publicKey.toBase58()), signed.signature);
    await assert.rejects(loadLiveKeypairFile(file, Keypair.generate().publicKey.toBase58(), process.cwd()), /does not match/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('keyfile loader refuses permissive files and paths inside the project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sol-listener-live-key-'));
  try {
    const keypair = Keypair.fromSeed(new Uint8Array(32).fill(44));
    const file = join(directory, 'throwaway.json');
    const projectRoot = join(directory, 'project-root');
    await mkdir(projectRoot);
    await writeFile(file, JSON.stringify([...keypair.secretKey]), { mode: 0o644 });
    await chmod(file, 0o644);
    await assert.rejects(loadLiveKeypairFile(file, keypair.publicKey.toBase58(), projectRoot), /owner-only/u);
    await assert.rejects(loadLiveKeypairFile(file, keypair.publicKey.toBase58(), directory), /outside the project/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
