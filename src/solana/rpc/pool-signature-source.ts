import { PublicKey } from '@solana/web3.js';
import {
  CatchUpSourceError,
  MAX_CATCH_UP_PAGE_SIZE,
  MAX_CATCH_UP_SIGNATURE_LENGTH,
  snapshotCatchUpPage,
  type CatchUpSignature,
} from './catch-up-source.js';

export interface PoolSignaturesRpc {
  getSignaturesForAddress(
    address: PublicKey,
    options: { readonly before: string | undefined; readonly until: string | undefined; readonly limit: number },
    commitment: 'finalized',
  ): Promise<unknown>;
}

export interface PoolSignatureCursor {
  readonly before: string | undefined;
  readonly until: string | undefined;
}

// Finalized reads only. `until` is exclusive and silently ignored by the RPC when the node does not
// know that signature, so callers must confirm the boundary themselves (see PoolCatchUpScanner).
// Real-time coverage comes from the processed WebSocket feed.
export class PoolSignatureSource {
  public constructor(private readonly rpc: PoolSignaturesRpc) {}

  public async list(
    poolAddress: string,
    cursor: PoolSignatureCursor,
    limit: number,
  ): Promise<readonly CatchUpSignature[]> {
    if (!validLimit(limit) || !validCursor(cursor.before) || !validCursor(cursor.until)) {
      throw new CatchUpSourceError('request');
    }
    let address: PublicKey;
    try {
      address = new PublicKey(poolAddress);
    } catch {
      throw new CatchUpSourceError('request');
    }
    let response: unknown;
    try {
      response = await this.rpc.getSignaturesForAddress(
        address,
        { before: cursor.before, until: cursor.until, limit },
        'finalized',
      );
    } catch {
      throw new CatchUpSourceError('request');
    }
    const page = snapshotCatchUpPage(response, limit);
    if (page.some((row) => row.confirmationStatus !== 'finalized')) {
      throw new CatchUpSourceError('response');
    }
    return page;
  }
}

function validCursor(value: unknown): value is string | undefined {
  return value === undefined || (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CATCH_UP_SIGNATURE_LENGTH
    && Buffer.byteLength(value, 'utf8') <= MAX_CATCH_UP_SIGNATURE_LENGTH
  );
}

function validLimit(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_CATCH_UP_PAGE_SIZE;
}
