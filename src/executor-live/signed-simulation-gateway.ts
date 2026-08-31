import { createHash, createPublicKey, verify } from 'node:crypto';
import { isProxy } from 'node:util/types';
import bs58 from 'bs58';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { ExecutionSimulationEvidenceV1 } from '../ports/execution-simulation-gateway.js';
import type {
  AuthenticatedPersistedSignedTransactionV1,
  ExecutionLiveSignedSimulationEvidenceV1,
} from '../ports/execution-live-repository.js';
import type {
  ExecutionLiveGateway,
  ExecutionSignedSimulationResultV1,
} from '../ports/execution-live-gateway.js';

export type SignedSimulationGatewayErrorCode =
  | 'SIGNED_TRANSACTION_INVALID'
  | 'SIGNED_SIMULATION_FAILED'
  | 'SIGNED_SIMULATION_INCONSISTENT';

export class SignedSimulationGatewayError extends Error {
  public constructor(public readonly code: SignedSimulationGatewayErrorCode) {
    super('Signed transaction simulation failed.');
    this.name = 'SignedSimulationGatewayError';
  }
}

export interface SignedSimulationGatewayInputV1 {
  readonly payloadVersion: 1;
  readonly persisted: AuthenticatedPersistedSignedTransactionV1;
  readonly snapshotSlot: bigint;
  readonly accountAddresses: readonly [string, string, string];
  readonly amountInRaw: bigint;
  readonly protectedAmountOutRaw: bigint;
  readonly unsignedSimulation: ExecutionSimulationEvidenceV1;
}

interface SignedSimulationLimits {
  readonly maxComputeUnits: bigint;
  readonly maxFeePayerLamportDebit: bigint;
}

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const SPKI_ED25519_PUBLIC_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class SignedSimulationGateway {
  private readonly limits: SignedSimulationLimits;

  public constructor(
    private readonly provider: ExecutionLiveGateway,
    limits: SignedSimulationLimits,
    private readonly now: () => number = Date.now,
  ) {
    if (!positiveU64(limits.maxComputeUnits) || !u64(limits.maxFeePayerLamportDebit)) {
      throw new TypeError('Invalid signed simulation limits.');
    }
    this.limits = Object.freeze({ ...limits });
  }

  public async simulate(
    input: SignedSimulationGatewayInputV1,
    signal: AbortSignal,
  ): Promise<ExecutionLiveSignedSimulationEvidenceV1> {
    let validated: ReturnType<typeof validatePersisted>;
    try {
      if (signal.aborted) transactionError();
      validated = validatePersisted(input);
    } catch (error) {
      if (error instanceof SignedSimulationGatewayError) throw error;
      transactionError();
    }
    let result: ExecutionSignedSimulationResultV1;
    try {
      result = await this.provider.simulateSignedTransaction(Object.freeze({
        payloadVersion: 1,
        transactionBase64: Buffer.from(validated.bytes).toString('base64'),
        snapshotSlot: input.snapshotSlot,
        accountAddresses: input.accountAddresses,
        commitment: 'confirmed',
        sigVerify: true,
        replaceRecentBlockhash: false,
      }), signal);
    } catch {
      throw new SignedSimulationGatewayError('SIGNED_SIMULATION_FAILED');
    }
    try {
      validateResult(result, input, this.limits);
      const observedAtMs = timestamp(this.now());
      const evidenceFingerprint = fingerprint([
        'execution-live-signed-simulation-v1',
        input.persisted.artifact.artifactId,
        input.persisted.artifact.signedTransactionHash,
        result.providerId,
        result.contextSlot.toString(10),
        result.unitsConsumed.toString(10),
        result.feePayerLamportDebit.toString(10),
        result.baseDeltaRaw.toString(10),
        result.quoteDeltaRaw.toString(10),
        result.logsFingerprint,
        String(result.logsLineCount),
      ]);
      return Object.freeze({
        payloadVersion: 1,
        artifactId: input.persisted.artifact.artifactId,
        signedTransactionHash: input.persisted.artifact.signedTransactionHash,
        simulationSlot: result.contextSlot,
        unitsConsumed: result.unitsConsumed,
        feePayerLamportDebit: result.feePayerLamportDebit,
        baseDeltaRaw: result.baseDeltaRaw,
        quoteDeltaRaw: result.quoteDeltaRaw,
        evidenceFingerprint,
        observedAtMs,
      });
    } catch (error) {
      if (error instanceof SignedSimulationGatewayError) throw error;
      throw new SignedSimulationGatewayError('SIGNED_SIMULATION_INCONSISTENT');
    }
  }
}

function validatePersisted(inputValue: unknown): Readonly<{
  readonly bytes: Uint8Array;
}> {
  if (!frozenPlainObject(inputValue) || inputValue.payloadVersion !== 1
    || !frozenPlainObject(inputValue.persisted)
    || inputValue.persisted.payloadVersion !== 1
    || !Array.isArray(inputValue.accountAddresses)
    || !Object.isFrozen(inputValue.accountAddresses)
    || inputValue.accountAddresses.length !== 3
    || !frozenPlainObject(inputValue.unsignedSimulation)
    || inputValue.unsignedSimulation.outcome !== 'SUCCESS') transactionError();
  const input = inputValue as unknown as SignedSimulationGatewayInputV1;
  if (input.persisted.state !== 'PERSISTED' || input.persisted.stateRevision !== 0n
    || !positiveU64(input.amountInRaw) || !positiveU64(input.protectedAmountOutRaw)
    || !u64(input.snapshotSlot)
    || input.accountAddresses[0] !== input.persisted.artifact.walletPublicKey) transactionError();
  for (const address of input.accountAddresses) canonicalPublicKey(address);
  const artifact = input.persisted.artifact;
  const bytes = Uint8Array.from(artifact.signedTransactionBytes);
  if (bytes.length < 1 || bytes.length > 1_232
    || sha256(bytes) !== artifact.signedTransactionHash) transactionError();
  const transaction = VersionedTransaction.deserialize(bytes);
  const reserialized = transaction.serialize();
  const messageBytes = transaction.message.serialize();
  const signature = transaction.signatures[0];
  if (!Buffer.from(reserialized).equals(bytes)
    || transaction.version !== 0 || transaction.signatures.length !== 1
    || signature?.length !== 64
    || bs58.encode(signature) !== artifact.signature
    || transaction.message.header.numRequiredSignatures !== 1
    || transaction.message.addressTableLookups.length !== 0
    || transaction.message.staticAccountKeys[0]?.toBase58() !== artifact.walletPublicKey
    || transaction.message.recentBlockhash !== artifact.blockhash
    || sha256(messageBytes) !== artifact.messageHash) transactionError();
  const publicBytes = canonicalPublicKey(artifact.walletPublicKey).toBytes();
  const publicDer = Buffer.concat([SPKI_ED25519_PUBLIC_PREFIX, publicBytes]);
  const key = createPublicKey({ key: publicDer, format: 'der', type: 'spki' });
  if (!verify(null, messageBytes, key, signature)) transactionError();
  const baseline = input.unsignedSimulation;
  if (baseline.messageHash !== artifact.messageHash
    || baseline.blockhash !== artifact.blockhash
    || baseline.lastValidBlockHeight !== artifact.lastValidBlockHeight
    || baseline.buildFingerprint !== artifact.buildFingerprint
    || baseline.snapshotFingerprint !== artifact.snapshotFingerprint
    || artifact.providerId.length < 1) transactionError();
  return Object.freeze({ bytes });
}

function validateResult(
  resultValue: unknown,
  input: SignedSimulationGatewayInputV1,
  limits: SignedSimulationLimits,
): void {
  if (!frozenPlainObject(resultValue) || resultValue.payloadVersion !== 1) inconsistent();
  const result = resultValue as unknown as ExecutionSignedSimulationResultV1;
  const baseline = input.unsignedSimulation;
  const side = input.persisted.artifact.side;
  if (result.providerId !== input.persisted.artifact.providerId
    || !u64(result.contextSlot) || result.contextSlot < input.snapshotSlot
    || result.failureKind !== null || !positiveU64(result.unitsConsumed)
    || result.unitsConsumed < baseline.unitsConsumed
    || result.unitsConsumed > limits.maxComputeUnits
    || !u64(result.feePayerLamportDebit)
    || result.feePayerLamportDebit < baseline.simulatedFeePayerLamportDebit
    || result.feePayerLamportDebit > limits.maxFeePayerLamportDebit
    || !i64(result.baseDeltaRaw) || !i64(result.quoteDeltaRaw)
    || !fingerprintText(result.logsFingerprint)
    || !Number.isSafeInteger(result.logsLineCount)
    || result.logsLineCount < 0 || result.logsLineCount > 256) inconsistent();
  if (side === 'BUY') {
    if (baseline.simulatedBaseDeltaRaw <= 0n || baseline.simulatedQuoteDeltaRaw >= 0n
      || result.baseDeltaRaw < input.protectedAmountOutRaw
      || result.baseDeltaRaw > baseline.simulatedBaseDeltaRaw
      || result.quoteDeltaRaw >= 0n || result.quoteDeltaRaw < -input.amountInRaw
      || result.quoteDeltaRaw > baseline.simulatedQuoteDeltaRaw) inconsistent();
  } else if (baseline.simulatedBaseDeltaRaw >= 0n || baseline.simulatedQuoteDeltaRaw <= 0n
    || result.baseDeltaRaw !== -input.amountInRaw
    || result.quoteDeltaRaw < input.protectedAmountOutRaw
    || result.quoteDeltaRaw > baseline.simulatedQuoteDeltaRaw) inconsistent();
}

function frozenPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && !isProxy(value) && Object.isFrozen(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function canonicalPublicKey(value: unknown): PublicKey {
  if (typeof value !== 'string' || value.length < 32 || value.length > 64) transactionError();
  const key = new PublicKey(value);
  if (key.toBase58() !== value) transactionError();
  return key;
}

function fingerprint(values: readonly string[]): string {
  const hash = createHash('sha256');
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function u64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= U64_MAX;
}
function positiveU64(value: unknown): value is bigint { return u64(value) && value > 0n; }
function i64(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= I64_MIN && value <= I64_MAX;
}
function fingerprintText(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) inconsistent();
  return value;
}
function transactionError(): never {
  throw new SignedSimulationGatewayError('SIGNED_TRANSACTION_INVALID');
}
function inconsistent(): never {
  throw new SignedSimulationGatewayError('SIGNED_SIMULATION_INCONSISTENT');
}
