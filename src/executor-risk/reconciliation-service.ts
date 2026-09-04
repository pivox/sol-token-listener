import { isProxy } from 'node:util/types';
import { evaluateExecutionReconciliation } from '../domain/execution-reconciliation.js';
import type { ExecutionReconciliationGateway, WalletDeltaRequestV1 } from '../ports/execution-reconciliation-gateway.js';
import type {
  ExecutionReconciliationCommitResultV1,
  ExecutionRiskRepository,
} from '../ports/execution-risk-repository.js';

const INPUT_KEYS = Object.freeze(['payloadVersion', 'expected', 'walletDeltaRequest'] as const);
const EXPECTED_KEYS = Object.freeze([
  'intentId', 'attemptNumber', 'walletGeneration', 'providerId', 'side',
  'signature', 'blockhash', 'lastValidBlockHeight', 'messageHash',
  'buildFingerprint', 'snapshotFingerprint', 'maximumFeeLamports',
  'maximumFeePayerLamportDebit',
] as const);
const WALLET_REQUEST_KEYS = Object.freeze([
  'signature', 'walletPublicKey', 'mint', 'quoteMint', 'side',
] as const);

export interface ExecutionReconciliationRequestV1 {
  readonly payloadVersion: 1;
  readonly expected: Readonly<{
    readonly intentId: string;
    readonly attemptNumber: number;
    readonly walletGeneration: number;
    readonly providerId: string;
    readonly side: 'BUY' | 'SELL';
    readonly signature: string;
    readonly blockhash: string;
    readonly lastValidBlockHeight: bigint;
    readonly messageHash: string;
    readonly buildFingerprint: string;
    readonly snapshotFingerprint: string;
    readonly maximumFeeLamports: bigint;
    readonly maximumFeePayerLamportDebit: bigint;
  }>;
  readonly walletDeltaRequest: WalletDeltaRequestV1;
}

export type ExecutionReconciliationServiceErrorCode =
  | 'INVALID_INPUT'
  | 'READ_FAILED'
  | 'INVALID_EVIDENCE';

export class ExecutionReconciliationServiceError extends Error {
  public constructor(
    public readonly code: ExecutionReconciliationServiceErrorCode,
    public readonly sourceCode: string | null = null,
  ) {
    super('Execution reconciliation service operation failed.');
    this.name = 'ExecutionReconciliationServiceError';
  }
}

export class ExecutionReconciliationService {
  public constructor(
    private readonly gateway: ExecutionReconciliationGateway,
    private readonly repository: Pick<ExecutionRiskRepository, 'reconcile'>,
  ) {}

  public async reconcile(
    inputValue: unknown,
    signal: AbortSignal,
  ): Promise<ExecutionReconciliationCommitResultV1> {
    const input = requestFrom(inputValue);
    if (!(signal instanceof AbortSignal) || signal.aborted) throw serviceFailure('INVALID_INPUT');
    let finalizedBlockHeight: bigint;
    let signatureHistory: 'PRESENT' | 'ABSENT' | 'UNKNOWN';
    let transactionObservation: Awaited<ReturnType<
      ExecutionReconciliationGateway['readNormalizedTransaction']
    >>;
    let deltas: Awaited<ReturnType<ExecutionReconciliationGateway['readFinalizedWalletDeltas']>>;
    try {
      [finalizedBlockHeight, signatureHistory, transactionObservation, deltas] = await Promise.all([
        this.gateway.readFinalizedBlockHeight(signal),
        this.gateway.readSignatureHistory(input.expected.signature, signal),
        this.gateway.readNormalizedTransaction(input.expected.signature, signal),
        this.gateway.readFinalizedWalletDeltas(input.walletDeltaRequest, signal),
      ]);
    } catch (error) {
      throw serviceFailure('READ_FAILED', ownStringDataProperty(error, 'code'));
    }
    const transaction = bindDurableLineage(transactionObservation, input.expected);
    let evidence;
    try {
      evidence = evaluateExecutionReconciliation({
        expected: input.expected,
        observed: Object.freeze({
          signatureHistory,
          confirmationStatus: deltas.confirmationStatus,
          finalizedBlockHeight,
          observedSlot: deltas.observedSlot,
          transaction,
          feeLamports: deltas.feeLamports,
          walletLamportDelta: deltas.walletLamportDelta,
          baseDeltaRaw: deltas.baseDeltaRaw,
          quoteDeltaRaw: deltas.quoteDeltaRaw,
          unexpectedResidualTokenBalanceRaw: deltas.unexpectedResidualTokenBalanceRaw,
          observedAtMs: deltas.observedAtMs,
          finalizedAtMs: deltas.finalizedAtMs,
        }),
      });
    } catch {
      throw serviceFailure('INVALID_EVIDENCE');
    }
    return this.repository.reconcile(Object.freeze({ payloadVersion: 1, evidence }));
  }
}

function bindDurableLineage(
  observation: Awaited<ReturnType<ExecutionReconciliationGateway['readNormalizedTransaction']>>,
  expected: ExecutionReconciliationRequestV1['expected'],
): Readonly<{
  readonly signature: string;
  readonly blockhash: string;
  readonly messageHash: string;
  readonly buildFingerprint: string;
  readonly snapshotFingerprint: string;
}> | null {
  if (observation === null) return null;
  return Object.freeze({
    signature: observation.signature,
    blockhash: observation.blockhash,
    messageHash: observation.messageHash,
    // These two values are durable pre-submission lineage, not RPC observations.
    buildFingerprint: expected.buildFingerprint,
    snapshotFingerprint: expected.snapshotFingerprint,
  });
}

function requestFrom(value: unknown): ExecutionReconciliationRequestV1 {
  try {
    const row = exactRecord(value, INPUT_KEYS);
    if (row.payloadVersion !== 1) throw new TypeError();
    const expected = exactRecord(row.expected, EXPECTED_KEYS);
    const walletDeltaRequest = exactRecord(row.walletDeltaRequest, WALLET_REQUEST_KEYS);
    if (expected.signature !== walletDeltaRequest.signature
      || expected.side !== walletDeltaRequest.side
      || !base58(walletDeltaRequest.signature, 32, 128)
      || !base58(walletDeltaRequest.walletPublicKey, 32, 44)
      || !base58(walletDeltaRequest.mint, 32, 44)
      || !base58(walletDeltaRequest.quoteMint, 32, 44)
      || !['BUY', 'SELL'].includes(String(walletDeltaRequest.side))) throw new TypeError();
    evaluateExecutionReconciliation({
      expected: Object.freeze(expected),
      observed: Object.freeze({
        signatureHistory: 'UNKNOWN', confirmationStatus: 'NOT_FOUND',
        finalizedBlockHeight: 0n, observedSlot: null, transaction: null,
        feeLamports: 0n, walletLamportDelta: 0n, baseDeltaRaw: 0n,
        quoteDeltaRaw: 0n, unexpectedResidualTokenBalanceRaw: 0n,
        observedAtMs: 0, finalizedAtMs: null,
      }),
    });
    return Object.freeze({
      payloadVersion: 1,
      expected: Object.freeze(expected) as unknown as ExecutionReconciliationRequestV1['expected'],
      walletDeltaRequest: Object.freeze(walletDeltaRequest) as unknown as WalletDeltaRequestV1,
    });
  } catch {
    throw serviceFailure('INVALID_INPUT');
  }
}

function base58(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
    && /^[1-9A-HJ-NP-Za-km-z]+$/u.test(value);
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string'
    || !keys.includes(key))) throw new TypeError();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function serviceFailure(
  code: ExecutionReconciliationServiceErrorCode,
  sourceCode: string | null = null,
): ExecutionReconciliationServiceError {
  return new ExecutionReconciliationServiceError(code, sourceCode);
}

function ownStringDataProperty(value: unknown, key: string): string | null {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}
