import { isProxy } from 'node:util/types';
import type {
  ExecutionVenuePool,
  ExecutionVenueRepository,
  ExecutionVenueTokenProgram,
} from '../ports/execution-venue-repository.js';
import { getDatabasePool } from './database.js';

type Row = Readonly<Record<string, unknown>>;

interface QueryResult {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

interface ExecutionVenueClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(error?: boolean): void;
}

export interface ExecutionVenuePoolConnection {
  connect(): Promise<ExecutionVenueClient>;
}

export type ExecutionVenueRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_DATA'
  | 'DATABASE_FAILURE';

export class ExecutionVenueRepositoryError extends Error {
  public constructor(public readonly code: ExecutionVenueRepositoryErrorCode) {
    super('Execution venue repository operation failed.');
    this.name = 'ExecutionVenueRepositoryError';
  }
}

const INTERNAL_REPOSITORY_ERRORS = new WeakSet<ExecutionVenueRepositoryError>();

export function isInternalExecutionVenueRepositoryError(
  error: unknown,
  code?: ExecutionVenueRepositoryErrorCode,
): error is ExecutionVenueRepositoryError {
  if (typeof error !== 'object'
    || error === null
    || !INTERNAL_REPOSITORY_ERRORS.has(error as ExecutionVenueRepositoryError)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor !== undefined
    && 'value' in descriptor
    && (code === undefined || descriptor.value === code);
}

const ROW_KEYS = Object.freeze([
  'migration_id',
  'migration_instruction',
  'migration_confirmation_status',
  'pool_address',
  'market',
  'program_id',
  'pool_index',
  'creator',
  'base_mint',
  'quote_mint',
  'quote_decimals',
  'base_token_program',
  'quote_token_program',
  'base_vault',
  'quote_vault',
  'lp_mint',
  'pool_confirmation_status',
  'activated_slot',
  'transaction_index',
  'instruction_index',
  'inner_instruction_index',
] as const);
const INT32_MAX = 2_147_483_647;
const INT64_MAX = 9_223_372_036_854_775_807n;

const FIND_FINALIZED_CANONICAL_POOL_SQL = `
  SELECT
    migration.migration_id,
    migration.instruction_kind AS migration_instruction,
    migration.confirmation_status AS migration_confirmation_status,
    pool.pool_address,
    pool.market,
    pool.program_id,
    pool.pool_index,
    pool.creator,
    pool.base_mint,
    pool.quote_mint,
    pool.quote_decimals,
    pool.base_token_program,
    pool.quote_token_program,
    pool.base_vault,
    pool.quote_vault,
    pool.lp_mint,
    pool.confirmation_status AS pool_confirmation_status,
    pool.slot::TEXT AS activated_slot,
    pool.transaction_index,
    pool.instruction_index,
    pool.inner_instruction_index
  FROM migrations AS migration
  JOIN market_pools AS pool ON pool.migration_id = migration.migration_id
  WHERE migration.mint = $1
    AND migration.quote_mint = $2
    AND migration.announced_pool = pool.pool_address
    AND migration.base_token_program = pool.base_token_program
    AND migration.quote_token_program = pool.quote_token_program
    AND migration.quote_decimals = pool.quote_decimals
    AND migration.confirmation_status = 'finalized'
    AND pool.base_mint = $1
    AND pool.quote_mint = $2
    AND pool.market = 'pumpswap'
    AND pool.pool_index = 0
    AND pool.pool_state = 'active'
    AND pool.confirmation_status = 'finalized'
  ORDER BY pool.slot, pool.transaction_index, pool.instruction_index,
    COALESCE(pool.inner_instruction_index, -1), pool.pool_address`;

export class PostgresExecutionVenueRepository implements ExecutionVenueRepository {
  private readonly pool: ExecutionVenuePoolConnection;

  public constructor(pool?: ExecutionVenuePoolConnection) {
    this.pool = pool ?? getDatabasePool();
  }

  public async findFinalizedCanonicalPumpSwapPool(inputValue: Readonly<{
    readonly mint: string;
    readonly quoteMint: string;
  }>): Promise<ExecutionVenuePool | null> {
    const input = decodeInput(inputValue);
    try {
      return await this.find(input);
    } catch (error) {
      if (isInternalExecutionVenueRepositoryError(error)) throw error;
      throw repositoryError('DATABASE_FAILURE');
    }
  }

  private async find(input: Readonly<{
    readonly mint: string;
    readonly quoteMint: string;
  }>): Promise<ExecutionVenuePool | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(FIND_FINALIZED_CANONICAL_POOL_SQL, [
        input.mint,
        input.quoteMint,
      ]);
      if (result.rowCount === 0 && result.rows.length === 0) return null;
      if (result.rowCount !== 1 || result.rows.length !== 1) invalidData();
      return decodeRow(requiredRow(result.rows[0]));
    } finally {
      client.release();
    }
  }
}

function decodeInput(value: unknown): Readonly<{ readonly mint: string; readonly quoteMint: string }> {
  const record = closedDataRecord(value, ['mint', 'quoteMint'], invalidInput);
  return Object.freeze({
    mint: boundedText(record.mint, 'input'),
    quoteMint: boundedText(record.quoteMint, 'input'),
  });
}

function decodeRow(row: Row): ExecutionVenuePool {
  const record = closedDataRecord(row, ROW_KEYS, invalidData);
  const migrationInstruction = record.migration_instruction;
  const baseTokenProgram = tokenProgram(record.base_token_program);
  const quoteTokenProgram = tokenProgram(record.quote_token_program);
  if (migrationInstruction !== 'MIGRATE' && migrationInstruction !== 'MIGRATE_V2') invalidData();
  if (record.migration_confirmation_status !== 'finalized'
    || record.pool_confirmation_status !== 'finalized'
    || record.market !== 'pumpswap'
    || record.pool_index !== 0) invalidData();
  return Object.freeze({
    migrationId: boundedText(record.migration_id, 'row'),
    migrationInstruction,
    migrationConfirmationStatus: 'finalized',
    poolAddress: boundedText(record.pool_address, 'row'),
    market: 'pumpswap',
    programId: boundedText(record.program_id, 'row'),
    poolIndex: 0,
    creator: boundedText(record.creator, 'row'),
    baseMint: boundedText(record.base_mint, 'row'),
    quoteMint: boundedText(record.quote_mint, 'row'),
    quoteDecimals: integer(record.quote_decimals, 255),
    baseTokenProgram,
    quoteTokenProgram,
    baseVault: boundedText(record.base_vault, 'row'),
    quoteVault: boundedText(record.quote_vault, 'row'),
    lpMint: boundedText(record.lp_mint, 'row'),
    poolConfirmationStatus: 'finalized',
    activatedSlot: decimalBigint(record.activated_slot),
    transactionIndex: integer(record.transaction_index, INT32_MAX),
    instructionIndex: integer(record.instruction_index, INT32_MAX),
    innerInstructionIndex: record.inner_instruction_index === null
      ? null
      : integer(record.inner_instruction_index, INT32_MAX),
  });
}

function tokenProgram(value: unknown): ExecutionVenueTokenProgram {
  if (value !== 'SPL_TOKEN' && value !== 'TOKEN_2022') invalidData();
  return value;
}

function decimalBigint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) invalidData();
  const parsed = BigInt(value);
  if (parsed > INT64_MAX) invalidData();
  return parsed;
}

function integer(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0 || value > maximum) {
    invalidData();
  }
  return value;
}

function boundedText(value: unknown, source: 'input' | 'row'): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > 256) {
    if (source === 'input') invalidInput();
    invalidData();
  }
  return value;
}

function requiredRow(value: Row | undefined): Row {
  if (value === undefined) invalidData();
  return value;
}

function closedDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  fail: () => never,
): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) fail();
  const actual = (keys as string[]).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) fail();
  const decoded: Record<string, unknown> = {};
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) fail();
    decoded[key] = descriptor.value;
  }
  return decoded;
}

function invalidInput(): never {
  throw repositoryError('INVALID_INPUT');
}

function invalidData(): never {
  throw repositoryError('INVALID_DATA');
}

function repositoryError(
  code: ExecutionVenueRepositoryErrorCode,
): ExecutionVenueRepositoryError {
  const error = new ExecutionVenueRepositoryError(code);
  INTERNAL_REPOSITORY_ERRORS.add(error);
  return Object.freeze(error);
}
