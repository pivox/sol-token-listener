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
      && isDirectCpiChild(migrationInstruction, creation.action.instruction));
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
): boolean {
  return parent.stackHeight !== null
    && child.stackHeight === parent.stackHeight + 1
    && child.instructionIndex === parent.instructionIndex
    && child.innerInstructionIndex !== null
    && (
      parent.innerInstructionIndex === null
      || child.innerInstructionIndex > parent.innerInstructionIndex
    );
}
