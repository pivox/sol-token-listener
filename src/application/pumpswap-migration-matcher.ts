import {
  createMigrationObservedEvent,
  createPumpSwapPoolActivatedEvent,
  type MigrationObservedEventV1,
  type PumpSwapPoolActivatedEventV1,
} from '../domain/migration-events.js';
import type {
  CanonicalMarketPool,
  MigrationObservation,
} from '../domain/market.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import { PumpSwapDecodingError } from '../markets/pumpswap/errors.js';
import type {
  DecodedPumpSwapPoolCreation,
  DecodedPumpSwapTransaction,
} from '../markets/pumpswap/types.js';
import type { SolanaObservedTransaction } from '../solana/rpc/observed-transaction.js';
import type { NormalizedInstruction } from '../solana/rpc/types.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

export interface MatchedMigration {
  readonly migrationEvent: MigrationObservedEventV1;
  readonly activationEvent: PumpSwapPoolActivatedEventV1 | null;
}

export function matchPumpSwapMigrations(
  transaction: SolanaObservedTransaction,
  migrations: readonly MigrationObservation[],
  evidence: DecodedPumpSwapTransaction,
  validatedPools: ReadonlyMap<string, CanonicalMarketPool>,
): readonly MatchedMigration[] {
  const consumed = new Set<DecodedPumpSwapPoolCreation>();
  return Object.freeze(migrations.map((migration) => {
    const migrationEvent = createMigrationObservedEvent({
      source: 'pumpfun',
      program: PUMP_PROGRAM_ID,
      transaction,
      migration,
    });
    const migrationInstruction = findInstruction(transaction, migration);
    const candidates = evidence.poolCreations.filter((creation) =>
      !consumed.has(creation)
      && creation.pool === migration.announcedPool
      && creation.baseMint === migration.mint
      && creation.quoteMint === migration.quoteAsset.mint
      && creation.index === 0n
      && isDirectCpiChild(
        migrationInstruction,
        creation.action.instruction,
        transaction.raw.instructions,
      ));
    if (candidates.length > 1) {
      throw new PumpSwapDecodingError(
        'PUMPSWAP_EVENT_AMBIGUOUS',
        `Plusieurs create_pool pour la migration ${migration.mint}.`,
        transaction.signature,
      );
    }
    const creation = candidates[0];
    const pool = creation === undefined
      ? undefined
      : validatedPools.get(creation.pool);
    if (creation === undefined || pool === undefined) {
      return Object.freeze({ migrationEvent, activationEvent: null });
    }
    assertValidatedPool(
      pool,
      creation,
      migration,
      transaction.confirmationStatus,
      transaction.signature,
    );
    consumed.add(creation);
    const activationEvent = createPumpSwapPoolActivatedEvent({
      source: 'pumpswap',
      program: PUMPSWAP_PROGRAM_ID,
      transaction,
      migrationEventId: migrationEvent.id,
      pool,
    });
    return Object.freeze({ migrationEvent, activationEvent });
  }));
}

function assertValidatedPool(
  pool: CanonicalMarketPool,
  creation: DecodedPumpSwapPoolCreation,
  migration: MigrationObservation,
  confirmationStatus: CanonicalMarketPool['confirmationStatus'],
  signature: string,
): void {
  const action = creation.action.accounts;
  const cursor = creation.action.instruction;
  if (
    pool.address !== creation.pool
    || pool.programId !== PUMPSWAP_PROGRAM_ID
    || pool.index !== 0
    || pool.creator !== creation.creator
    || pool.baseMint !== creation.baseMint
    || pool.quoteAsset.mint !== creation.quoteMint
    || pool.baseTokenProgram !== migration.baseTokenProgram
    || pool.quoteAsset.tokenProgram !== migration.quoteAsset.tokenProgram
    || pool.quoteAsset.decimals !== migration.quoteAsset.decimals
    || pool.baseVault !== action.pool_base_token_account
    || pool.quoteVault !== action.pool_quote_token_account
    || pool.lpMint !== action.lp_mint
    || action.base_token_program
      !== tokenProgramAddress(pool.baseTokenProgram)
    || action.quote_token_program
      !== tokenProgramAddress(pool.quoteAsset.tokenProgram)
    || pool.activatedAt.slot !== migration.cursor.slot
    || pool.activatedAt.transactionIndex !== migration.cursor.transactionIndex
    || pool.activatedAt.instructionIndex !== cursor.instructionIndex
    || pool.activatedAt.innerInstructionIndex !== cursor.innerInstructionIndex
    || pool.confirmationStatus !== confirmationStatus
  ) {
    throw new PumpSwapDecodingError(
      'PUMPSWAP_EVENT_MISMATCH',
      `Pool PumpSwap validé contradictoire dans ${signature}.`,
      signature,
    );
  }
}

function tokenProgramAddress(
  kind: CanonicalMarketPool['baseTokenProgram'],
): string {
  return kind === 'TOKEN_2022'
    ? TOKEN_2022_PROGRAM_ID.toBase58()
    : TOKEN_PROGRAM_ID.toBase58();
}

function findInstruction(
  transaction: SolanaObservedTransaction,
  migration: MigrationObservation,
): NormalizedInstruction {
  const found = transaction.raw.instructions.find((instruction) =>
    instruction.instructionIndex === migration.cursor.instructionIndex
    && instruction.innerInstructionIndex === migration.cursor.innerInstructionIndex
    && instruction.programId === PUMP_PROGRAM_ID);
  if (found === undefined) {
    throw new PumpSwapDecodingError(
      'PUMPSWAP_EVENT_MISMATCH',
      'Instruction Pump de migration absente de la transaction.',
      transaction.signature,
    );
  }
  return found;
}

function isDirectCpiChild(
  parent: NormalizedInstruction,
  child: NormalizedInstruction,
  instructions: readonly NormalizedInstruction[],
): boolean {
  if (
    parent.stackHeight === null
    || child.stackHeight !== parent.stackHeight + 1
  ) return false;
  if (
    child.instructionIndex !== parent.instructionIndex
    || child.innerInstructionIndex === null
    || (
      parent.innerInstructionIndex !== null
      && child.innerInstructionIndex <= parent.innerInstructionIndex
    )
  ) return false;
  if (parent.innerInstructionIndex === null) return true;
  const parentInnerInstructionIndex = parent.innerInstructionIndex;
  const parentStackHeight = parent.stackHeight;
  const boundary = instructions.find((candidate) =>
    candidate.instructionIndex === parent.instructionIndex
    && candidate.innerInstructionIndex !== null
    && candidate.innerInstructionIndex > parentInnerInstructionIndex
    && candidate.stackHeight !== null
    && candidate.stackHeight <= parentStackHeight);
  return boundary === undefined
    || child.innerInstructionIndex < requireInnerIndex(boundary);
}

function requireInnerIndex(instruction: NormalizedInstruction): number {
  if (instruction.innerInstructionIndex === null) {
    throw new PumpSwapDecodingError(
      'PUMPSWAP_STACK_HEIGHT_REQUIRED',
      'Index CPI PumpSwap requis.',
    );
  }
  return instruction.innerInstructionIndex;
}
