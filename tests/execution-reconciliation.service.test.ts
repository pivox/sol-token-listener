import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutionReconciliationService,
  ExecutionReconciliationServiceError,
} from '../src/executor-risk/reconciliation-service.js';
import type { ExecutionReconciliationGateway } from '../src/ports/execution-reconciliation-gateway.js';
import type {
  ExecutionReconciliationCommitV1,
  ExecutionRiskRepository,
} from '../src/ports/execution-risk-repository.js';

const signature = '3'.repeat(88);
const blockhash = '11111111111111111111111111111111';
const wallet = '11111111111111111111111111111111';
const hash = 'a'.repeat(64);

void test('reconciliation service performs four read-only observations and one atomic commit', async () => {
  const calls: string[] = [];
  const committed: ExecutionReconciliationCommitV1[] = [];
  const gateway: ExecutionReconciliationGateway = {
    async readFinalizedBlockHeight() { calls.push('height'); return 1_001n; },
    async readSignatureHistory(received) {
      calls.push(`history:${received}`); return 'PRESENT';
    },
    async readNormalizedTransaction(received) {
      calls.push(`transaction:${received}`);
      return Object.freeze({
        signature, blockhash, messageHash: hash,
      });
    },
    async readFinalizedWalletDeltas(request) {
      calls.push(`deltas:${request.signature}`);
      return Object.freeze({
        confirmationStatus: 'FINALIZED', observedSlot: 500n, feeLamports: 5n,
        walletLamportDelta: -105n, baseDeltaRaw: 500n, quoteDeltaRaw: -100n,
        unexpectedResidualTokenBalanceRaw: 0n, observedAtMs: 1_900, finalizedAtMs: 2_000,
      });
    },
  };
  const repository = repositoryStub(async (input) => {
    committed.push(input);
    return Object.freeze({
      payloadVersion: 1, result: input.evidence.result, evidenceId: input.evidence.evidenceId,
    });
  });
  const result = await new ExecutionReconciliationService(gateway, repository)
    .reconcile(request(), new AbortController().signal);

  assert.equal(result.result, 'MATCHED');
  assert.equal(committed[0]?.evidence.result, 'MATCHED');
  assert.deepEqual(calls.sort(), [
    'deltas:'.concat(signature), 'height', `history:${signature}`, `transaction:${signature}`,
  ].sort());
  assert.deepEqual(Object.keys(gateway).sort(), [
    'readFinalizedBlockHeight', 'readFinalizedWalletDeltas',
    'readNormalizedTransaction', 'readSignatureHistory',
  ]);
  assert.equal(Object.keys(gateway).some((key) => /^(?:send|sign|submit)/u.test(key)), false);
});

void test('reconciliation service converts gateway and evidence failures to fixed errors', async () => {
  const repository = repositoryStub(async () => { throw new Error('must not commit'); });
  const brokenGateway: ExecutionReconciliationGateway = {
    async readFinalizedBlockHeight() { throw new Error('rpc secret'); },
    async readSignatureHistory() { return 'UNKNOWN'; },
    async readNormalizedTransaction() { return null; },
    async readFinalizedWalletDeltas() {
      return Object.freeze({
        confirmationStatus: 'NOT_FOUND', observedSlot: null, feeLamports: 0n,
        walletLamportDelta: 0n, baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
        unexpectedResidualTokenBalanceRaw: 0n, observedAtMs: 1_900, finalizedAtMs: null,
      });
    },
  };
  await assert.rejects(
    new ExecutionReconciliationService(brokenGateway, repository)
      .reconcile(request(), new AbortController().signal),
    (error) => error instanceof Error
      && error.message === 'Execution reconciliation service operation failed.'
      && !String(error).includes('secret'),
  );
});

void test('reconciliation service retains only a typed RPC read error code', async () => {
  const repository = repositoryStub(async () => { throw new Error('must not commit'); });
  for (const code of ['RPC_RATE_LIMITED', 'RPC_TIMEOUT', 'CALL_BUDGET_EXCEEDED'] as const) {
    const gateway: ExecutionReconciliationGateway = {
      async readFinalizedBlockHeight() {
        const error = new Error('https://credential@rpc.private.test');
        Object.defineProperty(error, 'code', { value: code, enumerable: true });
        throw error;
      },
      async readSignatureHistory() { return 'UNKNOWN'; },
      async readNormalizedTransaction() { return null; },
      async readFinalizedWalletDeltas() {
        return Object.freeze({
          confirmationStatus: 'NOT_FOUND' as const, observedSlot: null, feeLamports: 0n,
          walletLamportDelta: 0n, baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
          unexpectedResidualTokenBalanceRaw: 0n, observedAtMs: 1_900, finalizedAtMs: null,
        });
      },
    };
    await assert.rejects(
      new ExecutionReconciliationService(gateway, repository)
        .reconcile(request(), new AbortController().signal),
      (error: unknown) => error instanceof ExecutionReconciliationServiceError
        && error.code === 'READ_FAILED'
        && error.sourceCode === code
        && !error.message.includes('credential'),
    );
  }
});

void test('reconciliation service does not retain a hostile gateway code accessor', async () => {
  const repository = repositoryStub(async () => { throw new Error('must not commit'); });
  const gateway: ExecutionReconciliationGateway = {
    async readFinalizedBlockHeight() {
      const error = new Error('secret getter') as Error & { readonly code?: string };
      Object.defineProperty(error, 'code', {
        enumerable: true,
        get: () => { throw new Error('secret getter'); },
      });
      throw error;
    },
    async readSignatureHistory() { return 'UNKNOWN'; },
    async readNormalizedTransaction() { return null; },
    async readFinalizedWalletDeltas() {
      return Object.freeze({
        confirmationStatus: 'NOT_FOUND' as const, observedSlot: null, feeLamports: 0n,
        walletLamportDelta: 0n, baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
        unexpectedResidualTokenBalanceRaw: 0n, observedAtMs: 1_900, finalizedAtMs: null,
      });
    },
  };
  await assert.rejects(
    new ExecutionReconciliationService(gateway, repository)
      .reconcile(request(), new AbortController().signal),
    (error: unknown) => error instanceof ExecutionReconciliationServiceError
      && error.code === 'READ_FAILED' && error.sourceCode === null,
  );
});

function request() {
  return Object.freeze({
    payloadVersion: 1,
    expected: Object.freeze({
      intentId: `execution_intent_${'b'.repeat(64)}`,
      attemptNumber: 1,
      walletGeneration: 1,
      providerId: 'rpc-primary',
      side: 'BUY' as const,
      signature,
      blockhash,
      lastValidBlockHeight: 1_000n,
      messageHash: hash,
      buildFingerprint: hash,
      snapshotFingerprint: hash,
      maximumFeeLamports: 10n,
      maximumFeePayerLamportDebit: 1_000n,
    }),
    walletDeltaRequest: Object.freeze({
      signature,
      walletPublicKey: wallet,
      mint: wallet,
      quoteMint: 'So11111111111111111111111111111111111111112',
      side: 'BUY' as const,
    }),
  });
}

function repositoryStub(
  reconcile: ExecutionRiskRepository['reconcile'],
): ExecutionRiskRepository {
  const unavailable = async (): Promise<never> => { throw new Error('unavailable'); };
  return {
    registerWalletGeneration: unavailable,
    appendWalletSnapshot: unavailable,
    appendProviderUsage: unavailable,
    recordProviderOperation: unavailable,
    recordRateLimit: unavailable,
    admitBuy: unavailable,
    recordFault: unavailable,
    recordReconciledSuccess: unavailable,
    reconcile,
  };
}
