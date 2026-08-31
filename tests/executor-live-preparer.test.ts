import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import bs58 from 'bs58';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { inspectUnsignedBuildPlan } from '../src/executor-simulation/instruction-inspector.js';
import { compileInspectedV0Message } from '../src/executor-simulation/message-compiler.js';
import {
  LiveTransactionCandidateAuthority,
  LiveTransactionPreparer,
} from '../src/executor-live/transaction-preparer.js';
import type { ExecutionSimulationEvidenceV1, ExecutionSimulationGateway } from '../src/ports/execution-simulation-gateway.js';
import type { ExecutionTransactionSigner } from '../src/ports/execution-transaction-signer.js';
import { loadPumpSwapSellGoldenPlan } from './helpers/executor-simulation-golden.js';

void test('signs the exact successfully simulated message behind a one-shot opaque candidate', async () => {
  const plan = await loadPumpSwapSellGoldenPlan();
  const inspected = inspectUnsignedBuildPlan(plan);
  const blockhash = new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toBase58();
  const compiled = compileInspectedV0Message(Object.freeze({
    feePayer: inspected.feePayer,
    instructions: inspected.instructions,
    recentBlockhash: blockhash,
    maximumTransactionBytes: 1_232,
  }));
  const evidence = simulationEvidence(compiled.messageHash, blockhash, plan.identity.snapshotFingerprint);
  const simulation = new StubSimulationGateway(evidence);
  const signatureBytes = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
  const signer: ExecutionTransactionSigner = Object.freeze({
    publicKey: plan.feePayer,
    signMessage(messageBytes: Uint8Array) {
      assert.deepEqual([...messageBytes], compiled.messageBytes);
      return Promise.resolve(Object.freeze({ signature: signatureBytes }));
    },
    close: () => Promise.resolve(),
  });
  const authority = new LiveTransactionCandidateAuthority();
  const preparer = new LiveTransactionPreparer(simulation, signer, authority, 1_232);
  const request = Object.freeze({
    plan,
    snapshot: Object.freeze({
      providerId: 'primary', slot: plan.identity.snapshotSlot,
      addresses: Object.freeze([]), accounts: Object.freeze([]),
    }),
    receipt: Object.freeze({ payloadVersion: 1 as const }),
  });

  const prepared = await preparer.prepare(request, new AbortController().signal);

  assert.equal(prepared.evidence, evidence);
  assert.deepEqual(Object.keys(prepared).sort(), ['candidate', 'evidence', 'payloadVersion']);
  assert.deepEqual(Object.keys(prepared.candidate), ['payloadVersion']);
  const material = authority.consume(prepared.candidate);
  assert.ok(material);
  assert.equal(authority.consume(prepared.candidate), null);
  assert.equal(material.messageHash, compiled.messageHash);
  assert.equal(material.signedTransactionHash, sha256(material.signedTransactionBytes));
  assert.equal(material.signature, bs58.encode(signatureBytes));
  assert.equal(material.blockhash, blockhash);
  assert.equal(material.lastValidBlockHeight, evidence.lastValidBlockHeight);
  const transaction = VersionedTransaction.deserialize(
    Uint8Array.from(material.signedTransactionBytes),
  );
  assert.deepEqual([...transaction.message.serialize()], compiled.messageBytes);
  assert.deepEqual([...requiredSignature(transaction)], [...signatureBytes]);
  assert.equal(simulation.calls, 1);
});

void test('rejects a signer mismatch and a forged simulation message before signing', async () => {
  const plan = await loadPumpSwapSellGoldenPlan();
  const signer = signerFor(new PublicKey(new Uint8Array(32).fill(7)).toBase58());
  const mismatch = simulationEvidence('a'.repeat(64), new PublicKey(new Uint8Array(32).fill(8)).toBase58(), plan.identity.snapshotFingerprint);
  const request = Object.freeze({
    plan,
    snapshot: Object.freeze({
      providerId: 'primary', slot: plan.identity.snapshotSlot,
      addresses: Object.freeze([]), accounts: Object.freeze([]),
    }),
    receipt: Object.freeze({ payloadVersion: 1 as const }),
  });
  await assert.rejects(
    new LiveTransactionPreparer(
      new StubSimulationGateway(mismatch), signer,
      new LiveTransactionCandidateAuthority(), 1_232,
    ).prepare(request, new AbortController().signal),
    /Live transaction preparation failed/u,
  );
});

class StubSimulationGateway implements ExecutionSimulationGateway {
  public calls = 0;
  public constructor(private readonly result: ExecutionSimulationEvidenceV1) {}
  public simulate(): Promise<ExecutionSimulationEvidenceV1> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

function simulationEvidence(
  messageHash: string,
  blockhash: string,
  snapshotFingerprint: string,
): ExecutionSimulationEvidenceV1 {
  return Object.freeze({
    outcome: 'SUCCESS', snapshotFingerprint, buildFingerprint: 'b'.repeat(64),
    messageHash, blockhash, lastValidBlockHeight: 500n, blockhashContextSlot: 124n,
    feeContextSlot: 124n, estimatedFeeLamports: 5_000n, simulationSlot: 125n,
    simulatedFeePayerLamportDebit: 5_000n, unitsConsumed: 25_000n,
    simulatedBaseDeltaRaw: -100n, simulatedQuoteDeltaRaw: 90n,
    logsFingerprint: 'c'.repeat(64), logsLineCount: 1,
  });
}

function signerFor(publicKey: string): ExecutionTransactionSigner {
  return Object.freeze({
    publicKey,
    signMessage: () => Promise.resolve(Object.freeze({ signature: new Uint8Array(64) })),
    close: () => Promise.resolve(),
  });
}

function requiredSignature(transaction: VersionedTransaction): Uint8Array {
  const signature = transaction.signatures[0];
  assert.ok(signature);
  return signature;
}

function sha256(bytes: readonly number[]): string {
  return createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
}
