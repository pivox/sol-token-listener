import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';

export const EXECUTION_LIVE_REASON_CODES = Object.freeze([
  'KEYPAIR_UNAVAILABLE',
  'KEYPAIR_PERMISSIONS_INVALID',
  'SIGNED_SIMULATION_FAILED',
  'SIGNED_SIMULATION_SUCCEEDED',
  'PRE_SUBMISSION_REVOKED_NO_SEND',
  'SUBMISSION_SIGNATURE_MISMATCH',
  'SUBMISSION_STARTED',
  'MAXIMUM_HOLDING_REACHED',
  'EXIT_AUTHORIZATION_INVALID',
  'CANARY_RECONCILED',
] as const);

export type ExecutionLiveReasonCode = (typeof EXECUTION_LIVE_REASON_CODES)[number];
export type SignedTransactionState =
  | 'PERSISTED'
  | 'SIGNED_SIMULATED'
  | 'SUBMISSION_STARTED'
  | 'ACCEPTED'
  | 'AMBIGUOUS'
  | 'CONFIRMED'
  | 'RECONCILED'
  | 'REVOKED_NO_SEND';
export type ExecutionLivePositionState = 'OPEN' | 'EXIT_PENDING' | 'CLOSED' | 'UNKNOWN';
export type ExecutionExitAuthorizationState = 'ACTIVE' | 'LOCKED' | 'CONSUMED' | 'REVOKED';

export interface SignedTransactionArtifactV1 {
  readonly artifactId: string;
  readonly payloadVersion: 1;
  readonly specificationVersion: 1;
  readonly intentId: string;
  readonly attemptNumber: number;
  readonly generationId: string;
  readonly armamentId: string | null;
  readonly reservationId: string | null;
  readonly exitAuthorizationId: string | null;
  readonly providerId: string;
  readonly walletPublicKey: string;
  readonly side: 'BUY' | 'SELL';
  readonly effectiveVenue: 'PUMP_FUN' | 'PUMP_SWAP';
  readonly messageHash: string;
  readonly buildFingerprint: string;
  readonly snapshotFingerprint: string;
  readonly quoteFingerprint: string;
  readonly quoteObservedAtMs: number;
  readonly quoteExpiresAtMs: number;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly signature: string;
  readonly signedTransactionBytes: readonly number[];
  readonly signedTransactionHash: string;
  readonly state: 'PERSISTED';
  readonly stateRevision: 0n;
  readonly signedAtMs: number;
}

export interface ExecutionLivePositionV1 {
  readonly payloadVersion: 1;
  readonly positionId: string;
  readonly buyIntentId: string;
  readonly generationId: string;
  readonly armamentId: string;
  readonly walletPublicKey: string;
  readonly mint: string;
  readonly quoteMint: string;
  readonly entryVenue: 'PUMP_FUN';
  readonly quoteCostRaw: bigint;
  readonly baseAmountRaw: bigint;
  readonly feeLamports: bigint;
  readonly maximumHoldingMs: number;
  readonly openedAtMs: number;
  readonly exitDeadlineAtMs: number;
  readonly entryReconciliationFingerprint: string;
  readonly state: ExecutionLivePositionState;
  readonly stateRevision: bigint;
}

export interface ExecutionExitAuthorizationV1 {
  readonly payloadVersion: 1;
  readonly authorizationId: string;
  readonly positionId: string;
  readonly generationId: string;
  readonly walletPublicKey: string;
  readonly mint: string;
  readonly quoteMint: string;
  readonly maximumBaseAmountRaw: bigint;
  readonly createdAtMs: number;
  readonly state: ExecutionExitAuthorizationState;
  readonly stateRevision: bigint;
}

const SIGNED_INPUT_KEYS = Object.freeze([
  'payloadVersion', 'specificationVersion', 'intentId', 'attemptNumber',
  'generationId', 'armamentId', 'reservationId', 'exitAuthorizationId', 'providerId',
  'walletPublicKey', 'side', 'effectiveVenue', 'messageHash', 'buildFingerprint',
  'snapshotFingerprint', 'quoteFingerprint', 'quoteObservedAtMs', 'quoteExpiresAtMs', 'blockhash',
  'lastValidBlockHeight', 'signature', 'signedTransactionBytes', 'signedAtMs',
] as const);
const POSITION_INPUT_KEYS = Object.freeze([
  'payloadVersion', 'positionId', 'buyIntentId', 'generationId', 'armamentId',
  'walletPublicKey', 'mint', 'quoteMint', 'entryVenue', 'quoteCostRaw',
  'baseAmountRaw', 'feeLamports', 'maximumHoldingMs', 'openedAtMs',
  'entryReconciliationFingerprint',
] as const);
const AUTHORIZATION_INPUT_KEYS = Object.freeze([
  'payloadVersion', 'authorizationId', 'positionId', 'generationId',
  'walletPublicKey', 'mint', 'quoteMint', 'maximumBaseAmountRaw', 'createdAtMs',
] as const);
const U64_MAX = (1n << 64n) - 1n;

export function createSignedTransactionArtifact(value: unknown): SignedTransactionArtifactV1 {
  try {
    const input = dataRecord(value, SIGNED_INPUT_KEYS);
    if (input.payloadVersion !== 1 || input.specificationVersion !== 1) rejectSigned();
    const intentId = patternedText(input.intentId, /^execution_intent_[0-9a-f]{64}$/u);
    const attemptNumber = positiveInt32(input.attemptNumber);
    const generationId = patternedText(
      input.generationId, /^execution_wallet_generation_[0-9a-f]{64}$/u,
    );
    const side = enumValue(input.side, ['BUY', 'SELL'] as const);
    const armamentId = nullablePatternedText(
      input.armamentId, /^execution_activation_armament_[0-9a-f]{64}$/u,
    );
    const reservationId = nullablePatternedText(
      input.reservationId, /^execution_exposure_reservation_[0-9a-f]{64}$/u,
    );
    const exitAuthorizationId = nullablePatternedText(
      input.exitAuthorizationId, /^execution_exit_authorization_[0-9a-f]{64}$/u,
    );
    if ((side === 'BUY') !== (armamentId !== null)
      || (side === 'BUY') !== (reservationId !== null)
      || (side === 'SELL') !== (exitAuthorizationId !== null)) rejectSigned();
    const bytes = byteArray(input.signedTransactionBytes, 1, 1_232);
    const signedTransactionHash = sha256(Buffer.from(bytes));
    const quoteObservedAtMs = timestamp(input.quoteObservedAtMs);
    const quoteExpiresAtMs = timestamp(input.quoteExpiresAtMs);
    const signedAtMs = timestamp(input.signedAtMs);
    if (quoteObservedAtMs > signedAtMs || signedAtMs >= quoteExpiresAtMs) rejectSigned();
    const normalized = {
      artifactId: '',
      payloadVersion: 1 as const,
      specificationVersion: 1 as const,
      intentId,
      attemptNumber,
      generationId,
      armamentId,
      reservationId,
      exitAuthorizationId,
      providerId: boundedText(input.providerId, 1, 64, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
      walletPublicKey: publicKey(input.walletPublicKey),
      side,
      effectiveVenue: enumValue(input.effectiveVenue, ['PUMP_FUN', 'PUMP_SWAP'] as const),
      messageHash: fingerprint(input.messageHash),
      buildFingerprint: fingerprint(input.buildFingerprint),
      snapshotFingerprint: fingerprint(input.snapshotFingerprint),
      quoteFingerprint: fingerprint(input.quoteFingerprint),
      quoteObservedAtMs,
      quoteExpiresAtMs,
      blockhash: base58Bytes(input.blockhash, 32),
      lastValidBlockHeight: u64(input.lastValidBlockHeight),
      signature: base58Bytes(input.signature, 64),
      signedTransactionBytes: bytes,
      signedTransactionHash,
      state: 'PERSISTED' as const,
      stateRevision: 0n as const,
      signedAtMs,
    };
    const artifactId = createSignedTransactionArtifactId(normalized);
    return Object.freeze({ ...normalized, artifactId });
  } catch (error) {
    if (error instanceof SignedTransactionArtifactValidationError) throw error;
    throw new SignedTransactionArtifactValidationError();
  }
}

export function createSignedTransactionArtifactId(value: unknown): string {
  try {
    const input = looseRecord(value);
    const segments = [
      'execution-signed-transaction-id-v1',
      patternedText(input.intentId, /^execution_intent_[0-9a-f]{64}$/u),
      String(positiveInt32(input.attemptNumber)),
      patternedText(input.generationId, /^execution_wallet_generation_[0-9a-f]{64}$/u),
      nullablePatternedText(
        input.reservationId, /^execution_exposure_reservation_[0-9a-f]{64}$/u,
      ) ?? 'NO_RESERVATION',
      fingerprint(input.messageHash),
      String(timestamp(input.quoteObservedAtMs)),
      String(timestamp(input.quoteExpiresAtMs)),
      base58Bytes(input.signature, 64),
    ];
    return `execution_signed_transaction_${sha256(lengthPrefixedUtf8(segments))}`;
  } catch (error) {
    if (error instanceof SignedTransactionArtifactValidationError) throw error;
    throw new SignedTransactionArtifactValidationError();
  }
}

export function createExecutionLivePosition(value: unknown): ExecutionLivePositionV1 {
  try {
    const input = dataRecord(value, POSITION_INPUT_KEYS);
    if (input.payloadVersion !== 1 || input.entryVenue !== 'PUMP_FUN') rejectPosition();
    const openedAtMs = timestamp(input.openedAtMs);
    const maximumHoldingMs = boundedInteger(input.maximumHoldingMs, 30_000, 900_000);
    const exitDeadlineAtMs = openedAtMs + maximumHoldingMs;
    if (!Number.isSafeInteger(exitDeadlineAtMs)) rejectPosition();
    return Object.freeze({
      payloadVersion: 1,
      positionId: patternedText(input.positionId, /^execution_live_position_[0-9a-f]{64}$/u),
      buyIntentId: patternedText(input.buyIntentId, /^execution_intent_[0-9a-f]{64}$/u),
      generationId: patternedText(
        input.generationId, /^execution_wallet_generation_[0-9a-f]{64}$/u,
      ),
      armamentId: patternedText(
        input.armamentId, /^execution_activation_armament_[0-9a-f]{64}$/u,
      ),
      walletPublicKey: publicKey(input.walletPublicKey),
      mint: publicKey(input.mint),
      quoteMint: publicKey(input.quoteMint),
      entryVenue: 'PUMP_FUN',
      quoteCostRaw: positiveU64(input.quoteCostRaw),
      baseAmountRaw: positiveU64(input.baseAmountRaw),
      feeLamports: u64(input.feeLamports),
      maximumHoldingMs,
      openedAtMs,
      exitDeadlineAtMs,
      entryReconciliationFingerprint: fingerprint(input.entryReconciliationFingerprint),
      state: 'OPEN',
      stateRevision: 0n,
    });
  } catch (error) {
    if (error instanceof ExecutionLivePositionValidationError) throw error;
    throw new ExecutionLivePositionValidationError();
  }
}

export function createExecutionExitAuthorization(
  value: unknown,
): ExecutionExitAuthorizationV1 {
  try {
    const input = dataRecord(value, AUTHORIZATION_INPUT_KEYS);
    if (input.payloadVersion !== 1) rejectAuthorization();
    return Object.freeze({
      payloadVersion: 1,
      authorizationId: patternedText(
        input.authorizationId, /^execution_exit_authorization_[0-9a-f]{64}$/u,
      ),
      positionId: patternedText(
        input.positionId, /^execution_live_position_[0-9a-f]{64}$/u,
      ),
      generationId: patternedText(
        input.generationId, /^execution_wallet_generation_[0-9a-f]{64}$/u,
      ),
      walletPublicKey: publicKey(input.walletPublicKey),
      mint: publicKey(input.mint),
      quoteMint: publicKey(input.quoteMint),
      maximumBaseAmountRaw: positiveU64(input.maximumBaseAmountRaw),
      createdAtMs: timestamp(input.createdAtMs),
      state: 'ACTIVE',
      stateRevision: 0n,
    });
  } catch (error) {
    if (error instanceof ExecutionExitAuthorizationValidationError) throw error;
    throw new ExecutionExitAuthorizationValidationError();
  }
}

export class SignedTransactionArtifactValidationError extends TypeError {
  public constructor() {
    super('Invalid signed transaction artifact.');
    this.name = 'SignedTransactionArtifactValidationError';
  }
}

export class ExecutionLivePositionValidationError extends TypeError {
  public constructor() {
    super('Invalid live position.');
    this.name = 'ExecutionLivePositionValidationError';
  }
}

export class ExecutionExitAuthorizationValidationError extends TypeError {
  public constructor() {
    super('Invalid exit authorization.');
    this.name = 'ExecutionExitAuthorizationValidationError';
  }
}

function rejectSigned(): never { throw new SignedTransactionArtifactValidationError(); }
function rejectPosition(): never { throw new ExecutionLivePositionValidationError(); }
function rejectAuthorization(): never { throw new ExecutionExitAuthorizationValidationError(); }

function dataRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const result = looseRecord(value);
  const actual = Reflect.ownKeys(value as object);
  if (actual.some((key) => typeof key !== 'string') || actual.length !== keys.length
    || [...actual as string[]].sort().some((key, index) => key !== [...keys].sort()[index])) {
    throw new TypeError();
  }
  return result;
}

function looseRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) throw new TypeError();
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError();
    }
    output[key] = descriptor.value;
  }
  return output;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError();
  return value;
}

function boundedText(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
  pattern?: RegExp,
): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < minimumBytes
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || value.trim() !== value || (pattern !== undefined && !pattern.test(value))) {
    throw new TypeError();
  }
  return value;
}

function patternedText(value: unknown, pattern: RegExp): string {
  return boundedText(value, 1, 256, pattern);
}

function nullablePatternedText(value: unknown, pattern: RegExp): string | null {
  return value === null ? null : patternedText(value, pattern);
}

function fingerprint(value: unknown): string {
  return patternedText(value, /^[0-9a-f]{64}$/u);
}

function publicKey(value: unknown): string {
  const encoded = boundedText(value, 32, 44, /^[1-9A-HJ-NP-Za-km-z]+$/u);
  const decoded = new PublicKey(encoded);
  if (decoded.toBase58() !== encoded) throw new TypeError();
  return encoded;
}

function base58Bytes(value: unknown, expectedLength: number): string {
  const encoded = boundedText(value, 1, 128, /^[1-9A-HJ-NP-Za-km-z]+$/u);
  const bytes = bs58.decode(encoded);
  if (bytes.length !== expectedLength || bs58.encode(bytes) !== encoded) throw new TypeError();
  return encoded;
}

function byteArray(value: unknown, minimum: number, maximum: number): readonly number[] {
  if (!(value instanceof Uint8Array) || isProxy(value)
    || value.byteLength < minimum || value.byteLength > maximum) throw new TypeError();
  return Object.freeze(Array.from(value));
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < minimum || value > maximum) throw new TypeError();
  return value;
}

function positiveInt32(value: unknown): number {
  return boundedInteger(value, 1, 2_147_483_647);
}

function timestamp(value: unknown): number {
  return boundedInteger(value, 0, 8_640_000_000_000_000);
}

function u64(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw new TypeError();
  return value;
}

function positiveU64(value: unknown): bigint {
  const result = u64(value);
  if (result === 0n) throw new TypeError();
  return result;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function lengthPrefixedUtf8(values: readonly string[]): Buffer {
  return Buffer.concat(values.flatMap((value) => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return [length, bytes];
  }));
}
