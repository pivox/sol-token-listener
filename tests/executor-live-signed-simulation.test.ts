import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { Keypair, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { createSignedTransactionArtifact } from '../src/domain/execution-live.js';
import { compileInspectedV0Message } from '../src/executor-simulation/message-compiler.js';
import {
  SignedSimulationGateway,
  SignedSimulationGatewayError,
} from '../src/executor-live/signed-simulation-gateway.js';
import type {
  ExecutionLiveGateway,
  ExecutionSignedSimulationRequestV1,
  ExecutionSignedSimulationResultV1,
} from '../src/ports/execution-live-gateway.js';
import type { AuthenticatedPersistedSignedTransactionV1 } from '../src/ports/execution-live-repository.js';

void test('verifies persisted bytes and performs one exact signed simulation without send', async () => {
  const fixture = signedFixture();
  const provider = new StubLiveGateway(Object.freeze({
    payloadVersion: 1, providerId: 'primary', contextSlot: 125n,
    failureKind: null, unitsConsumed: 26_000n, feePayerLamportDebit: 5_500n,
    baseDeltaRaw: 95n, quoteDeltaRaw: -100n,
    logsFingerprint: 'd'.repeat(64), logsLineCount: 2,
  }));
  const gateway = new SignedSimulationGateway(provider, Object.freeze({
    maxComputeUnits: 300_000n, maxFeePayerLamportDebit: 10_000n,
  }));

  const evidence = await gateway.simulate(Object.freeze({
    payloadVersion: 1,
    persisted: fixture.persisted,
    snapshotSlot: 123n,
    accountAddresses: Object.freeze([
      fixture.walletPublicKey, fixture.baseAccount, fixture.quoteAccount,
    ] as const),
    amountInRaw: 100n,
    protectedAmountOutRaw: 90n,
    unsignedSimulation: unsignedEvidence(
      fixture.artifact.messageHash, fixture.artifact.blockhash,
    ),
  }), new AbortController().signal);

  assert.equal(evidence.artifactId, fixture.artifact.artifactId);
  assert.equal(evidence.signedTransactionHash, fixture.artifact.signedTransactionHash);
  assert.equal(evidence.baseDeltaRaw, 95n);
  assert.equal(evidence.quoteDeltaRaw, -100n);
  assert.match(evidence.evidenceFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(provider.calls, 1);
  assert.deepEqual(provider.request, Object.freeze({
    payloadVersion: 1,
    transactionBase64: Buffer.from(fixture.artifact.signedTransactionBytes).toString('base64'),
    snapshotSlot: 123n,
    accountAddresses: Object.freeze([
      fixture.walletPublicKey, fixture.baseAccount, fixture.quoteAccount,
    ] as const),
    commitment: 'confirmed', sigVerify: true, replaceRecentBlockhash: false,
  }));
  assert.equal(provider.sendCalls, 0);
});

void test('rejects tampering before RPC and a signed result that is less conservative', async () => {
  const fixture = signedFixture();
  const invalidBytes = [...fixture.artifact.signedTransactionBytes];
  invalidBytes[invalidBytes.length - 1] = ((invalidBytes.at(-1) ?? 0) + 1) % 256;
  const tampered = Object.freeze({
    ...fixture.persisted,
    artifact: Object.freeze({ ...fixture.artifact, signedTransactionBytes: Object.freeze(invalidBytes) }),
  }) as AuthenticatedPersistedSignedTransactionV1;
  const provider = new StubLiveGateway(Object.freeze({
    payloadVersion: 1, providerId: 'primary', contextSlot: 125n,
    failureKind: null, unitsConsumed: 25_000n, feePayerLamportDebit: 5_000n,
    baseDeltaRaw: 101n, quoteDeltaRaw: -100n,
    logsFingerprint: 'd'.repeat(64), logsLineCount: 1,
  }));
  const gateway = new SignedSimulationGateway(provider, Object.freeze({
    maxComputeUnits: 300_000n, maxFeePayerLamportDebit: 10_000n,
  }));
  const request = (persisted: AuthenticatedPersistedSignedTransactionV1) => Object.freeze({
    payloadVersion: 1 as const, persisted, snapshotSlot: 123n,
    accountAddresses: Object.freeze([
      fixture.walletPublicKey, fixture.baseAccount, fixture.quoteAccount,
    ] as const),
    amountInRaw: 100n, protectedAmountOutRaw: 90n,
    unsignedSimulation: unsignedEvidence(
      fixture.artifact.messageHash, fixture.artifact.blockhash,
    ),
  });

  await assert.rejects(
    gateway.simulate(request(tampered), new AbortController().signal),
    (error: unknown) => error instanceof SignedSimulationGatewayError
      && error.code === 'SIGNED_TRANSACTION_INVALID',
  );
  assert.equal(provider.calls, 0);
  await assert.rejects(
    gateway.simulate(request(fixture.persisted), new AbortController().signal),
    (error: unknown) => error instanceof SignedSimulationGatewayError
      && error.code === 'SIGNED_SIMULATION_INCONSISTENT',
  );
  assert.equal(provider.calls, 1);
  assert.equal(provider.sendCalls, 0);
});

class StubLiveGateway implements ExecutionLiveGateway {
  public calls = 0;
  public sendCalls = 0;
  public request: ExecutionSignedSimulationRequestV1 | null = null;
  public constructor(private readonly result: ExecutionSignedSimulationResultV1) {}
  public simulateSignedTransaction(request: ExecutionSignedSimulationRequestV1): Promise<ExecutionSignedSimulationResultV1> {
    this.calls += 1;
    this.request = request;
    return Promise.resolve(this.result);
  }
}

function signedFixture() {
  const signer = Keypair.generate();
  const base = Keypair.generate().publicKey;
  const quote = Keypair.generate().publicKey;
  const instruction = SystemProgram.transfer({
    fromPubkey: signer.publicKey, toPubkey: quote, lamports: 1,
  });
  const normalized = Object.freeze([Object.freeze({
    programId: instruction.programId.toBase58(),
    accounts: Object.freeze(instruction.keys.map((account) => Object.freeze({
      address: account.pubkey.toBase58(), isSigner: account.isSigner,
      isWritable: account.isWritable,
    }))),
    dataBase64: Buffer.from(instruction.data).toString('base64'),
  })]);
  const blockhash = Keypair.generate().publicKey.toBase58();
  const compiled = compileInspectedV0Message(Object.freeze({
    feePayer: signer.publicKey.toBase58(), instructions: normalized,
    recentBlockhash: blockhash, maximumTransactionBytes: 1_232,
  }));
  const transaction = VersionedTransaction.deserialize(
    Uint8Array.from(compiled.unsignedTransactionBytes),
  );
  transaction.sign([signer]);
  const bytes = transaction.serialize();
  const signature = requiredSignature(transaction);
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1,
    intentId: `execution_intent_${'1'.repeat(64)}`, attemptNumber: 1,
    generationId: `execution_wallet_generation_${'2'.repeat(64)}`,
    armamentId: `execution_activation_armament_${'3'.repeat(64)}`,
    exitAuthorizationId: null, providerId: 'primary',
    walletPublicKey: signer.publicKey.toBase58(), side: 'BUY', effectiveVenue: 'PUMP_FUN',
    messageHash: compiled.messageHash, buildFingerprint: '4'.repeat(64),
    snapshotFingerprint: '5'.repeat(64), quoteFingerprint: '6'.repeat(64),
    blockhash, lastValidBlockHeight: 500n, signature: bs58.encode(signature),
    signedTransactionBytes: bytes, signedAtMs: 1_786_699_000_000,
  });
  const persisted: AuthenticatedPersistedSignedTransactionV1 = Object.freeze({
    payloadVersion: 1, artifact, state: 'PERSISTED', stateRevision: 0n,
  });
  return Object.freeze({
    artifact, persisted, walletPublicKey: signer.publicKey.toBase58(),
    baseAccount: base.toBase58(), quoteAccount: quote.toBase58(),
  });
}

function unsignedEvidence(messageHash: string, blockhash: string) {
  return Object.freeze({
    outcome: 'SUCCESS' as const, snapshotFingerprint: '5'.repeat(64),
    buildFingerprint: '4'.repeat(64), messageHash,
    blockhash, lastValidBlockHeight: 500n,
    blockhashContextSlot: 124n, feeContextSlot: 124n, estimatedFeeLamports: 5_000n,
    simulationSlot: 125n, simulatedFeePayerLamportDebit: 5_000n,
    unitsConsumed: 25_000n, simulatedBaseDeltaRaw: 100n,
    simulatedQuoteDeltaRaw: -100n, logsFingerprint: '7'.repeat(64), logsLineCount: 1,
  });
}

function requiredSignature(transaction: VersionedTransaction): Uint8Array {
  const signature = transaction.signatures[0];
  assert.ok(signature);
  return signature;
}
