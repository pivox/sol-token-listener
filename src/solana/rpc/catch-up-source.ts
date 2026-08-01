import { PublicKey, type Commitment } from '@solana/web3.js';
import type { ChainConfirmationStatus } from '../../domain/types.js';

export const MAX_CATCH_UP_PAGE_SIZE = 1_000;
export const MAX_CATCH_UP_SIGNATURE_LENGTH = 128;

export type CatchUpSourceStage = 'request' | 'response' | 'pagination';
export type CatchUpConfirmationStatus = Exclude<ChainConfirmationStatus, 'orphaned'>;

export interface CatchUpSignature {
  readonly signature: string;
  readonly slot: bigint;
  readonly confirmationStatus: CatchUpConfirmationStatus;
  readonly blockTimeMs: number | null;
}

export interface SignaturesForAddressRpc {
  getSignaturesForAddress(
    address: PublicKey,
    options: { readonly before: string | undefined; readonly limit: number },
    commitment: Commitment,
  ): Promise<unknown>;
}

const trustedCatchUpSourceErrors = new WeakSet();

export class CatchUpSourceError extends Error {
  public constructor(
    public readonly stage: CatchUpSourceStage,
    public readonly program: 'launchpad' | 'market' | null = null,
  ) {
    super('Catch-up RPC source failed.');
    this.name = 'CatchUpSourceError';
    trustedCatchUpSourceErrors.add(this);
    Object.freeze(this);
  }
}

export function trustedCatchUpSourceErrorStage(value: unknown): CatchUpSourceStage | null {
  if (typeof value !== 'object' || value === null || !trustedCatchUpSourceErrors.has(value)) {
    return null;
  }
  return (value as CatchUpSourceError).stage;
}

export class SolanaCatchUpSource {
  public constructor(
    private readonly rpc: SignaturesForAddressRpc,
    private readonly commitment: Commitment,
  ) {
    if (!isCommitment(commitment)) throw new CatchUpSourceError('request');
  }

  public async list(
    programId: string,
    before: string | undefined,
    limit: number,
  ): Promise<readonly CatchUpSignature[]> {
    if (!validProgramId(programId) || !validCursor(before) || !validLimit(limit)) {
      throw new CatchUpSourceError('request');
    }
    let response: unknown;
    try {
      response = await this.rpc.getSignaturesForAddress(
        new PublicKey(programId),
        { before, limit },
        this.commitment,
      );
    } catch {
      throw new CatchUpSourceError('request');
    }
    const page = snapshotCatchUpPage(response, limit);
    if (page.some((row) => !statusSatisfiesCommitment(row.confirmationStatus, this.commitment))) {
      throw new CatchUpSourceError('response');
    }
    return page;
  }
}

export function snapshotCatchUpPage(value: unknown, limit: number): readonly CatchUpSignature[] {
  return snapshotArray(value, limit, snapshotRow);
}

export function snapshotCatchUpSignatures(
  value: unknown,
  limit: number,
): readonly CatchUpSignature[] {
  return snapshotArray(value, limit, snapshotTrustedRow);
}

function snapshotArray(
  value: unknown,
  limit: number,
  snapshot: (value: unknown) => CatchUpSignature,
): readonly CatchUpSignature[] {
  if (!validLimit(limit)) throw new CatchUpSourceError('response');
  try {
    if (!Array.isArray(value)) throw new CatchUpSourceError('response');
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
      throw new CatchUpSourceError('response');
    }
    const length: unknown = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > limit) {
      throw new CatchUpSourceError('response');
    }
    const rows: CatchUpSignature[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw new CatchUpSourceError('response');
      }
      rows.push(snapshot(descriptor.value));
    }
    return Object.freeze(rows);
  } catch {
    throw new CatchUpSourceError('response');
  }
}

function snapshotRow(value: unknown): CatchUpSignature {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CatchUpSourceError('response');
  }
  const signature = dataProperty(value, 'signature');
  const slot = dataProperty(value, 'slot');
  const confirmationStatus = dataProperty(value, 'confirmationStatus');
  const blockTime = dataProperty(value, 'blockTime');
  if (!validSignature(signature)) {
    throw new CatchUpSourceError('response');
  }
  if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0 || Object.is(slot, -0)) {
    throw new CatchUpSourceError('response');
  }
  if (!isConfirmationStatus(confirmationStatus)) throw new CatchUpSourceError('response');
  const blockTimeMs = milliseconds(blockTime);
  return Object.freeze({
    signature,
    slot: BigInt(slot),
    confirmationStatus,
    blockTimeMs,
  });
}

function snapshotTrustedRow(value: unknown): CatchUpSignature {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CatchUpSourceError('response');
  }
  const signature = dataProperty(value, 'signature');
  const slot = dataProperty(value, 'slot');
  const confirmationStatus = dataProperty(value, 'confirmationStatus');
  const blockTimeMs = dataProperty(value, 'blockTimeMs');
  if (!validSignature(signature)) {
    throw new CatchUpSourceError('response');
  }
  if (typeof slot !== 'bigint' || slot < 0n) throw new CatchUpSourceError('response');
  if (!isConfirmationStatus(confirmationStatus)) throw new CatchUpSourceError('response');
  if (blockTimeMs !== null && (
    typeof blockTimeMs !== 'number'
    || !Number.isSafeInteger(blockTimeMs)
    || blockTimeMs < 0
    || Object.is(blockTimeMs, -0)
  )) throw new CatchUpSourceError('response');
  return Object.freeze({ signature, slot, confirmationStatus, blockTimeMs });
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    throw new CatchUpSourceError('response');
  }
  return descriptor.value;
}

function milliseconds(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new CatchUpSourceError('response');
  }
  const result = value * 1_000;
  if (!Number.isSafeInteger(result)) throw new CatchUpSourceError('response');
  return result;
}

function isConfirmationStatus(value: unknown): value is CatchUpConfirmationStatus {
  return value === 'processed' || value === 'confirmed' || value === 'finalized';
}

function isCommitment(value: Commitment): boolean {
  return value === 'processed' || value === 'confirmed' || value === 'finalized';
}

function statusSatisfiesCommitment(
  status: CatchUpConfirmationStatus,
  commitment: Commitment,
): boolean {
  if (commitment === 'processed') return true;
  if (commitment === 'confirmed') return status === 'confirmed' || status === 'finalized';
  return status === 'finalized';
}

function validCursor(value: unknown): value is string | undefined {
  return value === undefined
    || validSignature(value);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validProgramId(value: unknown): value is string {
  return validText(value) && value.length <= 64;
}

function validSignature(value: unknown): value is string {
  return validText(value)
    && value.length <= MAX_CATCH_UP_SIGNATURE_LENGTH
    && Buffer.byteLength(value, 'utf8') <= MAX_CATCH_UP_SIGNATURE_LENGTH;
}

function validLimit(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_CATCH_UP_PAGE_SIZE;
}
