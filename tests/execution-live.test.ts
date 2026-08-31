import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import bs58 from 'bs58';
import {
  EXECUTION_LIVE_REASON_CODES,
  createExecutionExitAuthorization,
  createExecutionLivePosition,
  createSignedTransactionArtifact,
  createSignedTransactionArtifactId,
} from '../src/domain/execution-live.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const WALLET = '11111111111111111111111111111111';
const MINT = 'So11111111111111111111111111111111111111112';
const SIGNATURE = bs58.encode(new Uint8Array(64).fill(2));
const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(3));
const BYTES = Uint8Array.from({ length: 128 }, (_, index) => index);

void test('creates a deterministic immutable signed transaction capability', () => {
  const input = signedArtifactInput();
  const artifact = createSignedTransactionArtifact(input);
  const expectedBytesHash = createHash('sha256').update(BYTES).digest('hex');

  assert.equal(artifact.artifactId, createSignedTransactionArtifactId(input));
  assert.equal(artifact.signedTransactionHash, expectedBytesHash);
  assert.equal(artifact.state, 'PERSISTED');
  assert.equal(artifact.stateRevision, 0n);
  assert.notStrictEqual(artifact.signedTransactionBytes, BYTES);
  assert.deepEqual([...artifact.signedTransactionBytes], [...BYTES]);
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(Object.isFrozen(artifact.signedTransactionBytes), true);

  BYTES[0] = 255;
  assert.equal(artifact.signedTransactionBytes[0], 0);
  assert.equal(createSignedTransactionArtifact(signedArtifactInput()).artifactId, artifact.artifactId);
});

void test('rejects oversized, malformed and non-u64 signed artifact values', () => {
  for (const overrides of [
    { signedTransactionBytes: new Uint8Array(0) },
    { signedTransactionBytes: new Uint8Array(1_233) },
    { lastValidBlockHeight: -1n },
    { lastValidBlockHeight: 1n << 64n },
    { signature: 'not base58!' },
    { messageHash: 'A'.repeat(64) },
    { attemptNumber: 0 },
    { signedAtMs: -1 },
    { side: 'HOLD' },
    { state: 'ACCEPTED' },
  ]) {
    assert.throws(
      () => createSignedTransactionArtifact({ ...signedArtifactInput(), ...overrides }),
      /Invalid signed transaction artifact/u,
    );
  }
});

void test('creates exact live positions and exit authorizations from reconciled quantities', () => {
  const position = createExecutionLivePosition({
    payloadVersion: 1,
    positionId: `execution_live_position_${HASH_A}`,
    buyIntentId: `execution_intent_${HASH_B}`,
    generationId: `execution_wallet_generation_${HASH_C}`,
    armamentId: `execution_activation_armament_${HASH_D}`,
    walletPublicKey: WALLET,
    mint: MINT,
    quoteMint: MINT,
    entryVenue: 'PUMP_FUN',
    quoteCostRaw: 500n,
    baseAmountRaw: 1_000n,
    feeLamports: 5n,
    maximumHoldingMs: 300_000,
    openedAtMs: 1_000,
    entryReconciliationFingerprint: HASH_A,
  });
  const authorization = createExecutionExitAuthorization({
    payloadVersion: 1,
    authorizationId: `execution_exit_authorization_${HASH_B}`,
    positionId: position.positionId,
    generationId: position.generationId,
    walletPublicKey: WALLET,
    mint: MINT,
    quoteMint: MINT,
    maximumBaseAmountRaw: position.baseAmountRaw,
    createdAtMs: 1_000,
  });

  assert.equal(position.state, 'OPEN');
  assert.equal(position.exitDeadlineAtMs, 301_000);
  assert.equal(authorization.state, 'ACTIVE');
  assert.equal(authorization.maximumBaseAmountRaw, 1_000n);
  assert.equal(Object.isFrozen(position), true);
  assert.equal(Object.isFrozen(authorization), true);
});

void test('rejects live position and exit authorization contradictions', () => {
  const positionInput = {
    payloadVersion: 1,
    positionId: `execution_live_position_${HASH_A}`,
    buyIntentId: `execution_intent_${HASH_B}`,
    generationId: `execution_wallet_generation_${HASH_C}`,
    armamentId: `execution_activation_armament_${HASH_D}`,
    walletPublicKey: WALLET,
    mint: MINT,
    quoteMint: MINT,
    entryVenue: 'PUMP_FUN',
    quoteCostRaw: 500n,
    baseAmountRaw: 1_000n,
    feeLamports: 5n,
    maximumHoldingMs: 300_000,
    openedAtMs: 1_000,
    entryReconciliationFingerprint: HASH_A,
  } as const;
  assert.throws(
    () => createExecutionLivePosition({ ...positionInput, maximumHoldingMs: 29_999 }),
    /Invalid live position/u,
  );
  assert.throws(
    () => createExecutionLivePosition({ ...positionInput, baseAmountRaw: 0n }),
    /Invalid live position/u,
  );
  assert.throws(() => createExecutionExitAuthorization({
    payloadVersion: 1,
    authorizationId: `execution_exit_authorization_${HASH_B}`,
    positionId: positionInput.positionId,
    generationId: positionInput.generationId,
    walletPublicKey: WALLET,
    mint: MINT,
    quoteMint: MINT,
    maximumBaseAmountRaw: 0n,
    createdAtMs: 1_000,
  }), /Invalid exit authorization/u);
});

void test('publishes the append-only live reason code contract', () => {
  assert.deepEqual(EXECUTION_LIVE_REASON_CODES, [
    'KEYPAIR_UNAVAILABLE',
    'KEYPAIR_PERMISSIONS_INVALID',
    'SIGNED_SIMULATION_FAILED',
    'SIGNED_SIMULATION_SUCCEEDED',
    'SUBMISSION_SIGNATURE_MISMATCH',
    'SUBMISSION_STARTED',
    'MAXIMUM_HOLDING_REACHED',
    'EXIT_AUTHORIZATION_INVALID',
    'CANARY_RECONCILED',
  ]);
  assert.equal(Object.isFrozen(EXECUTION_LIVE_REASON_CODES), true);
});

function signedArtifactInput() {
  return {
    payloadVersion: 1 as const,
    specificationVersion: 1 as const,
    intentId: `execution_intent_${HASH_A}`,
    attemptNumber: 1,
    generationId: `execution_wallet_generation_${HASH_B}`,
    armamentId: `execution_activation_armament_${HASH_C}`,
    exitAuthorizationId: null,
    providerId: 'primary',
    walletPublicKey: WALLET,
    side: 'BUY' as const,
    effectiveVenue: 'PUMP_FUN' as const,
    messageHash: HASH_A,
    buildFingerprint: HASH_B,
    snapshotFingerprint: HASH_C,
    quoteFingerprint: HASH_D,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 42n,
    signature: SIGNATURE,
    signedTransactionBytes: BYTES,
    signedAtMs: 1_000,
  };
}
