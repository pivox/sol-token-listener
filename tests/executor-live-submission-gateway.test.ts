import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { Keypair, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { createSignedTransactionArtifact } from '../src/domain/execution-live.js';
import { compileInspectedV0Message } from '../src/executor-simulation/message-compiler.js';
import {
  LiveSubmissionGateway,
  LiveSubmissionGatewayError,
} from '../src/executor-live/submission-gateway.js';
import type {
  ExecutionLiveGateway,
  ExecutionRawSubmissionRequestV1,
  ExecutionSignedSimulationRequestV1,
  ExecutionSignedSimulationResultV1,
} from '../src/ports/execution-live-gateway.js';

void test('submits only exact authenticated persisted bytes with retry disabled', async () => {
  const persisted = persistedFixture();
  const provider = new SubmissionProvider(persisted.artifact.signature);
  const result = await new LiveSubmissionGateway(provider)
    .submitPersisted(persisted, new AbortController().signal);

  assert.equal(result.signature, persisted.artifact.signature);
  assert.deepEqual(provider.request, Object.freeze({
    payloadVersion: 1,
    transactionBase64: Buffer.from(persisted.artifact.signedTransactionBytes).toString('base64'),
    skipPreflight: true, maxRetries: 0, preflightCommitment: 'confirmed',
  }));
  assert.equal(provider.calls, 1);
});

void test('rejects tampered bytes before dispatch and divergent signatures after dispatch', async () => {
  const persisted = persistedFixture();
  const tamperedBytes = [...persisted.artifact.signedTransactionBytes];
  tamperedBytes[tamperedBytes.length - 1] = ((tamperedBytes.at(-1) ?? 0) + 1) % 256;
  const provider = new SubmissionProvider(persisted.artifact.signature);
  const gateway = new LiveSubmissionGateway(provider);
  await assert.rejects(gateway.submitPersisted(Object.freeze({
    ...persisted,
    artifact: Object.freeze({
      ...persisted.artifact, signedTransactionBytes: Object.freeze(tamperedBytes),
    }),
  }), new AbortController().signal), (error: unknown) =>
    error instanceof LiveSubmissionGatewayError
      && error.code === 'PERSISTED_TRANSACTION_INVALID'
      && !error.dispatchMayHaveOccurred);
  assert.equal(provider.calls, 0);

  provider.returnedSignature = bs58.encode(new Uint8Array(64).fill(9));
  await assert.rejects(gateway.submitPersisted(
    persisted, new AbortController().signal,
  ), (error: unknown) => error instanceof LiveSubmissionGatewayError
      && error.code === 'SUBMISSION_SIGNATURE_MISMATCH'
      && error.dispatchMayHaveOccurred);
  assert.equal(provider.calls, 1);
});

class SubmissionProvider implements ExecutionLiveGateway {
  public calls = 0;
  public request: ExecutionRawSubmissionRequestV1 | null = null;
  public constructor(public returnedSignature: string) {}
  public simulateSignedTransaction(
    _request: ExecutionSignedSimulationRequestV1,
  ): Promise<ExecutionSignedSimulationResultV1> {
    throw new Error('not used');
  }
  public sendRawTransaction(request: ExecutionRawSubmissionRequestV1): Promise<Readonly<{
    readonly signature: string;
  }>> {
    this.calls += 1;
    this.request = request;
    return Promise.resolve(Object.freeze({ signature: this.returnedSignature }));
  }
}

function persistedFixture() {
  const signer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const instruction = SystemProgram.transfer({
    fromPubkey: signer.publicKey, toPubkey: recipient, lamports: 1,
  });
  const compiled = compileInspectedV0Message(Object.freeze({
    feePayer: signer.publicKey.toBase58(),
    instructions: Object.freeze([Object.freeze({
      programId: instruction.programId.toBase58(),
      accounts: Object.freeze(instruction.keys.map((account) => Object.freeze({
        address: account.pubkey.toBase58(), isSigner: account.isSigner,
        isWritable: account.isWritable,
      }))), dataBase64: Buffer.from(instruction.data).toString('base64'),
    })]),
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    maximumTransactionBytes: 1_232,
  }));
  const transaction = VersionedTransaction.deserialize(
    Uint8Array.from(compiled.unsignedTransactionBytes),
  );
  transaction.sign([signer]);
  const signature = transaction.signatures[0];
  assert.ok(signature);
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1,
    intentId: `execution_intent_${'1'.repeat(64)}`, attemptNumber: 1,
    generationId: `execution_wallet_generation_${'2'.repeat(64)}`,
    armamentId: `execution_activation_armament_${'3'.repeat(64)}`,
    reservationId: `execution_exposure_reservation_${'7'.repeat(64)}`,
    exitAuthorizationId: null, providerId: 'primary',
    walletPublicKey: signer.publicKey.toBase58(), side: 'BUY', effectiveVenue: 'PUMP_FUN',
    messageHash: compiled.messageHash, buildFingerprint: '4'.repeat(64),
    snapshotFingerprint: '5'.repeat(64), quoteFingerprint: '6'.repeat(64),
    quoteObservedAtMs: 1_786_698_999_900, quoteExpiresAtMs: 1_786_699_005_000,
    blockhash: compiled.recentBlockhash, lastValidBlockHeight: 500n,
    signature: bs58.encode(signature), signedTransactionBytes: transaction.serialize(),
    signedAtMs: 1_786_699_000_000,
  });
  return Object.freeze({
    payloadVersion: 1 as const, artifact,
    state: 'SUBMISSION_STARTED' as const, stateRevision: 2n,
  });
}
