import type { TransactionNotification } from '../domain/transaction-ingestion.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import type { TransactionInboxRepository } from '../ports/transaction-inbox-repository.js';
import {
  CatchUpSourceError,
  MAX_CATCH_UP_PAGE_SIZE,
  type CatchUpSignature,
} from '../solana/rpc/catch-up-source.js';
import type { PoolSignatureCursor } from '../solana/rpc/pool-signature-source.js';
import type { PoolCheckpoint, PoolCheckpointPosition } from '../storage/market-pool-tracking.repository.js';
import { MAX_CATCH_UP_PAGES } from './catch-up-scanner.js';

export interface PoolSignaturePageSource {
  list(poolAddress: string, cursor: PoolSignatureCursor, limit: number): Promise<readonly CatchUpSignature[]>;
}

export interface PoolCatchUpRepository {
  readCheckpoint(poolAddress: string): Promise<PoolCheckpoint | null>;
  storeCheckpoint(poolAddress: string, next: PoolCheckpointPosition, nowMs: number): Promise<void>;
}

export interface PoolCatchUpScannerOptions {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly now?: () => number;
}

export interface PoolSweepResult {
  readonly poolAddress: string;
  readonly checkpointSlotBefore: string;
  readonly checkpointSlotAfter: string;
  readonly pageCount: number;
  readonly probeCount: number;
  readonly signaturesRead: number;
  readonly signaturesEnqueued: number;
  readonly newestSlot: string | null;
  readonly oldestSlot: string | null;
}

export class PoolCheckpointMissingError extends Error {
  public readonly code = 'POOL_CHECKPOINT_MISSING' as const;

  public constructor(public readonly poolAddress: string) {
    super('Pool catch-up requires a durable checkpoint.');
    this.name = 'PoolCheckpointMissingError';
  }
}

// The RPC could not confirm that the checkpoint signature is the next older finalized row: either
// the node's history no longer reaches it, or it is not finalized yet (activation checkpoints may be
// seeded from a processed signature). Retryable; the checkpoint is never moved past an unconfirmed
// boundary.
export class PoolCheckpointNotFoundError extends Error {
  public readonly code = 'POOL_CHECKPOINT_NOT_FOUND' as const;

  public constructor(
    public readonly poolAddress: string,
    public readonly pageCount: number,
    public readonly signaturesRead: number,
  ) {
    super('Pool catch-up could not confirm the checkpoint boundary.');
    this.name = 'PoolCheckpointNotFoundError';
  }
}

export class PoolCatchUpWindowExceededError extends Error {
  public readonly code = 'CATCH_UP_WINDOW_EXCEEDED' as const;
  public readonly stage = 'window' as const;

  public constructor(
    public readonly poolAddress: string,
    public readonly pageCount: number,
    public readonly signaturesRead: number,
  ) {
    super('Pool catch-up window was exceeded.');
    this.name = 'PoolCatchUpWindowExceededError';
  }
}

export class PoolCatchUpScanner {
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly now: () => number;

  public constructor(
    private readonly source: PoolSignaturePageSource,
    private readonly inbox: Pick<TransactionInboxRepository, 'enqueue'>,
    private readonly repository: PoolCatchUpRepository,
    options: PoolCatchUpScannerOptions,
  ) {
    if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > MAX_CATCH_UP_PAGE_SIZE
      || !Number.isSafeInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > MAX_CATCH_UP_PAGES) {
      throw new TypeError('Pool catch-up bounds are invalid.');
    }
    this.pageSize = options.pageSize;
    this.maxPages = options.maxPages;
    this.now = options.now ?? Date.now;
  }

  public async scanPool(poolAddress: string): Promise<PoolSweepResult> {
    const stored: unknown = await this.repository.readCheckpoint(poolAddress);
    if (stored === null) throw new PoolCheckpointMissingError(poolAddress);
    const checkpoint = validCheckpoint(stored, poolAddress);

    const rows: CatchUpSignature[] = [];
    const signatures = new Set<string>();
    const cursors = new Set<string>();
    let before: string | undefined;
    let pageCount = 0;
    let previousSlot: bigint | null = null;
    let reachedUntil = false;
    while (pageCount < this.maxPages) {
      const page = await this.source.list(poolAddress, { before, until: checkpoint.signature }, this.pageSize);
      pageCount += 1;
      for (const row of page) {
        if (previousSlot !== null && row.slot > previousSlot) throw new CatchUpSourceError('response');
        previousSlot = row.slot;
        // `until` is exclusive: the checkpoint itself or anything older means the RPC ignored it.
        if (row.slot < checkpoint.slot || row.signature === checkpoint.signature) {
          throw new CatchUpSourceError('response');
        }
        if (signatures.has(row.signature)) throw new CatchUpSourceError('pagination');
        signatures.add(row.signature);
        rows.push(row);
      }
      if (page.length < this.pageSize) {
        reachedUntil = true;
        break;
      }
      const cursor = page.at(-1)?.signature;
      if (cursor === undefined || cursor === before || cursors.has(cursor)) {
        throw new CatchUpSourceError('pagination');
      }
      cursors.add(cursor);
      before = cursor;
    }

    // A short page is ambiguous (checkpoint reached vs. history exhausted / checkpoint not yet
    // finalized), and a full final page may sit exactly on the boundary. Confirm it explicitly: the
    // next older finalized row must be the checkpoint itself.
    const probe = await this.source.list(
      poolAddress,
      { before: rows.at(-1)?.signature, until: undefined },
      1,
    );
    const probeCount = 1;
    const boundary = probe[0];
    const confirmed = probe.length === 1
      && boundary?.signature === checkpoint.signature
      && boundary.slot === checkpoint.slot;
    if (!confirmed) {
      if (reachedUntil) throw new PoolCheckpointNotFoundError(poolAddress, pageCount, rows.length);
      throw new PoolCatchUpWindowExceededError(poolAddress, pageCount, rows.length);
    }

    const observedAtMs = this.now();
    for (const row of rows) {
      const notification: TransactionNotification = Object.freeze({
        signature: row.signature,
        slot: row.slot,
        source: 'CATCH_UP',
        programIds: Object.freeze([PUMPSWAP_PROGRAM_ID]),
        confirmationStatus: row.confirmationStatus,
        observedAtMs,
      });
      await this.inbox.enqueue(notification);
    }

    const newest = rows[0];
    if (newest !== undefined) {
      await this.repository.storeCheckpoint(
        poolAddress,
        { slot: newest.slot, signature: newest.signature },
        observedAtMs,
      );
    }
    return Object.freeze({
      poolAddress,
      checkpointSlotBefore: checkpoint.slot.toString(),
      checkpointSlotAfter: (newest?.slot ?? checkpoint.slot).toString(),
      pageCount,
      probeCount,
      signaturesRead: rows.length,
      signaturesEnqueued: rows.length,
      newestSlot: newest?.slot.toString() ?? null,
      oldestSlot: rows.at(-1)?.slot.toString() ?? null,
    });
  }
}

function validCheckpoint(value: unknown, poolAddress: string): PoolCheckpoint {
  if (typeof value !== 'object' || value === null) throw new TypeError('Pool checkpoint is invalid.');
  const { poolAddress: address, slot, signature } = value as Partial<Record<keyof PoolCheckpoint, unknown>>;
  if (address !== poolAddress
    || typeof slot !== 'bigint' || slot < 0n
    || typeof signature !== 'string' || signature.length === 0) {
    throw new TypeError('Pool checkpoint is invalid.');
  }
  return Object.freeze({ poolAddress: address, slot, signature });
}
