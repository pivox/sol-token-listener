import { isProxy } from 'node:util/types';
import { PublicKey } from '@solana/web3.js';
import {
  PUMP_PROGRAM_ID,
  WSOL_MINT,
} from '../launchpads/pumpfun/constants.js';
import { bondingCurvePda } from '../launchpads/pumpfun/official-sdk.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import {
  poolPda,
  pumpPoolAuthorityPda,
} from '../markets/pumpswap/official-sdk.js';
import type {
  ExecutionVenuePool,
  ExecutionVenueRepository,
} from '../ports/execution-venue-repository.js';
import { isInternalExecutionVenueRepositoryError } from '../storage/execution-venue.repository.js';

export type ExecutionVenueRoutingErrorCode =
  | 'QUOTE_MINT_NOT_ALLOWED'
  | 'VENUE_UNAVAILABLE'
  | 'EXECUTION_EVIDENCE_INVALID';

export class ExecutionVenueRoutingError extends Error {
  public constructor(public readonly code: ExecutionVenueRoutingErrorCode) {
    super('Execution venue routing failed.');
    this.name = 'ExecutionVenueRoutingError';
  }
}

export interface ExecutionVenueRouteRequest {
  readonly side: 'BUY' | 'SELL';
  readonly venuePolicy: 'PUMP_FUN_ONLY' | 'CANONICAL_EXIT';
  readonly mint: string;
  readonly quoteMint: string;
  readonly quoteTokenProgram: 'SPL_TOKEN' | 'TOKEN_2022';
  readonly quoteDecimals: number;
}

export interface ExecutionBondingCurveRouteState {
  readonly mint: string;
  readonly normalizedQuoteMint: string;
  readonly complete: boolean;
  readonly exists: true;
  readonly bondingCurveAddress: string;
  readonly ownerProgramId: string;
}

export type ExecutionVenueRoute = Readonly<
  | { readonly venue: 'PUMP_FUN'; readonly pool: null }
  | { readonly venue: 'PUMP_SWAP'; readonly pool: ExecutionVenuePool }
>;

export class ExecutionVenueRouter {
  public constructor(private readonly repository: ExecutionVenueRepository) {}

  public async route(
    request: ExecutionVenueRouteRequest,
    curve: ExecutionBondingCurveRouteState,
  ): Promise<ExecutionVenueRoute> {
    validateRequest(request, curve);
    if (!curve.complete) return Object.freeze({ venue: 'PUMP_FUN', pool: null });
    if (request.side === 'BUY') unavailable();
    let pool: ExecutionVenuePool | null;
    try {
      pool = await this.repository.findFinalizedCanonicalPumpSwapPool({
        mint: request.mint,
        quoteMint: request.quoteMint,
      });
    } catch (error) {
      if (isInternalExecutionVenueRepositoryError(error, 'INVALID_DATA')) unavailable();
      throw error;
    }
    if (pool === null || !isCanonicalPool(pool, request)) unavailable();
    return Object.freeze({ venue: 'PUMP_SWAP', pool });
  }
}

function validateRequest(
  requestValue: unknown,
  curveValue: unknown,
): void {
  const request = closedDataRecord(requestValue, [
    'side', 'venuePolicy', 'mint', 'quoteMint', 'quoteTokenProgram', 'quoteDecimals',
  ]);
  const curve = closedDataRecord(curveValue, [
    'mint', 'normalizedQuoteMint', 'complete', 'exists', 'bondingCurveAddress',
    'ownerProgramId',
  ]);
  if (request === null || curve === null
    || (request.side !== 'BUY' && request.side !== 'SELL')
    || (request.venuePolicy !== 'PUMP_FUN_ONLY' && request.venuePolicy !== 'CANONICAL_EXIT')
    || typeof request.mint !== 'string'
    || typeof request.quoteMint !== 'string'
    || typeof request.quoteTokenProgram !== 'string'
    || typeof request.quoteDecimals !== 'number'
    || typeof curve.mint !== 'string'
    || typeof curve.normalizedQuoteMint !== 'string'
    || typeof curve.complete !== 'boolean'
    || curve.exists !== true
    || typeof curve.bondingCurveAddress !== 'string'
    || typeof curve.ownerProgramId !== 'string') {
    throw new ExecutionVenueRoutingError('EXECUTION_EVIDENCE_INVALID');
  }
  if (request.quoteMint !== WSOL_MINT
    || request.quoteTokenProgram !== 'SPL_TOKEN'
    || request.quoteDecimals !== 9) {
    throw new ExecutionVenueRoutingError('QUOTE_MINT_NOT_ALLOWED');
  }
  if ((request.side === 'BUY' && request.venuePolicy !== 'PUMP_FUN_ONLY')
    || (request.side === 'SELL' && request.venuePolicy !== 'CANONICAL_EXIT')
    || request.mint !== curve.mint
    || request.quoteMint !== curve.normalizedQuoteMint) {
    throw new ExecutionVenueRoutingError('EXECUTION_EVIDENCE_INVALID');
  }
  try {
    const mint = new PublicKey(request.mint);
    new PublicKey(request.quoteMint);
    if (curve.ownerProgramId !== PUMP_PROGRAM_ID
      || curve.bondingCurveAddress !== bondingCurvePda(mint).toBase58()) {
      throw new ExecutionVenueRoutingError('EXECUTION_EVIDENCE_INVALID');
    }
  } catch {
    throw new ExecutionVenueRoutingError('EXECUTION_EVIDENCE_INVALID');
  }
}

function isCanonicalPool(
  poolValue: unknown,
  request: ExecutionVenueRouteRequest,
): boolean {
  const pool = closedDataRecord(poolValue, [
    'migrationId', 'migrationInstruction', 'migrationConfirmationStatus',
    'poolAddress', 'market', 'programId', 'poolIndex', 'creator', 'baseMint',
    'quoteMint', 'quoteDecimals', 'baseTokenProgram', 'quoteTokenProgram',
    'baseVault', 'quoteVault', 'lpMint', 'poolConfirmationStatus',
    'activatedSlot', 'transactionIndex', 'instructionIndex', 'innerInstructionIndex',
  ]);
  if (pool === null) return false;
  if (pool.migrationConfirmationStatus !== 'finalized'
    || pool.poolConfirmationStatus !== 'finalized'
    || (pool.migrationInstruction !== 'MIGRATE'
      && pool.migrationInstruction !== 'MIGRATE_V2')
    || pool.market !== 'pumpswap'
    || pool.programId !== PUMPSWAP_PROGRAM_ID
    || pool.poolIndex !== 0
    || typeof pool.poolAddress !== 'string'
    || typeof pool.creator !== 'string'
    || typeof pool.baseMint !== 'string'
    || typeof pool.quoteMint !== 'string'
    || typeof pool.baseVault !== 'string'
    || typeof pool.quoteVault !== 'string'
    || typeof pool.lpMint !== 'string'
    || pool.baseMint !== request.mint
    || pool.quoteMint !== request.quoteMint
    || pool.quoteDecimals !== request.quoteDecimals
    || pool.quoteTokenProgram !== request.quoteTokenProgram
    || (pool.baseTokenProgram !== 'SPL_TOKEN' && pool.baseTokenProgram !== 'TOKEN_2022')
    || typeof pool.migrationId !== 'string'
    || pool.migrationId.length === 0
    || typeof pool.activatedSlot !== 'bigint'
    || pool.activatedSlot < 0n
    || !nonNegativeInteger(pool.transactionIndex)
    || !nonNegativeInteger(pool.instructionIndex)
    || (pool.innerInstructionIndex !== null
      && !nonNegativeInteger(pool.innerInstructionIndex))) return false;
  try {
    const baseMint = new PublicKey(pool.baseMint);
    const quoteMint = new PublicKey(pool.quoteMint);
    const expectedCreator = pumpPoolAuthorityPda(baseMint).toBase58();
    if (pool.creator !== expectedCreator) return false;
    const expected = poolPda(
      0,
      new PublicKey(expectedCreator),
      baseMint,
      quoteMint,
    ).toBase58();
    for (const address of [
      pool.poolAddress,
      pool.baseVault,
      pool.quoteVault,
      pool.lpMint,
    ]) new PublicKey(address);
    return pool.poolAddress === expected;
  } catch {
    return false;
  }
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function closedDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    return null;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) return null;
  const actual = (keys as string[]).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) return null;
  const decoded: Record<string, unknown> = {};
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
    decoded[key] = descriptor.value;
  }
  return decoded;
}

function unavailable(): never {
  throw new ExecutionVenueRoutingError('VENUE_UNAVAILABLE');
}
