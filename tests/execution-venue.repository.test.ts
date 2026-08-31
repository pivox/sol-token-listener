import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutionVenueRepositoryError,
  PostgresExecutionVenueRepository,
} from '../src/storage/execution-venue.repository.js';
import type { ExecutionVenuePool } from '../src/ports/execution-venue-repository.js';

const MINT = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4n4kLKi';
const WSOL = 'So11111111111111111111111111111111111111112';

void test('loads only an active finalized canonical PumpSwap migration without JSON payloads', async () => {
  const database = new VenueDatabase([row()]);
  const repository = new PostgresExecutionVenueRepository(database.pool);
  const result = await repository.findFinalizedCanonicalPumpSwapPool({
    mint: MINT,
    quoteMint: WSOL,
  });

  assert.deepEqual(result, expected());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(database.calls.length, 1);
  const call = database.calls[0];
  assert.ok(call !== undefined);
  assert.deepEqual(call.values, [MINT, WSOL]);
  assert.match(call.text, /migration\.confirmation_status\s*=\s*'finalized'/iu);
  assert.match(call.text, /pool\.confirmation_status\s*=\s*'finalized'/iu);
  assert.match(call.text, /pool\.pool_state\s*=\s*'active'/iu);
  assert.match(call.text, /pool\.pool_index\s*=\s*0/iu);
  assert.match(call.text, /pool\.market\s*=\s*'pumpswap'/iu);
  assert.match(call.text, /migration\.announced_pool\s*=\s*pool\.pool_address/iu);
  assert.doesNotMatch(call.text, /payload|json/iu);
  assert.equal(database.releases, 1);
});

void test('returns null without proof and rejects duplicate or hostile rows', async () => {
  assert.equal(await new PostgresExecutionVenueRepository(
    new VenueDatabase([]).pool,
  ).findFinalizedCanonicalPumpSwapPool({ mint: MINT, quoteMint: WSOL }), null);

  for (const rows of [
    [row(), row({ pool_address: key(12) })],
    [row({ pool_index: 1 })],
    [row({ migration_confirmation_status: 'confirmed' })],
    [{ ...row(), unexpected: 'field' }],
  ]) {
    await assert.rejects(
      new PostgresExecutionVenueRepository(new VenueDatabase(rows).pool)
        .findFinalizedCanonicalPumpSwapPool({ mint: MINT, quoteMint: WSOL }),
      (error: unknown) => repositoryError(error, 'INVALID_DATA'),
    );
  }
});

void test('validates closed input and normalizes database failures', async () => {
  const repository = new PostgresExecutionVenueRepository(new VenueDatabase([], true).pool);
  await assert.rejects(
    repository.findFinalizedCanonicalPumpSwapPool({ mint: '', quoteMint: WSOL }),
    (error: unknown) => repositoryError(error, 'INVALID_INPUT'),
  );
  await assert.rejects(
    repository.findFinalizedCanonicalPumpSwapPool({ mint: MINT, quoteMint: WSOL }),
    (error: unknown) => {
      repositoryError(error, 'DATABASE_FAILURE');
      assert.equal((error as Error).cause, undefined);
      return true;
    },
  );
});

void test('rejects proxy, accessor and symbol inputs or rows without invoking traps', async () => {
  type Input = Parameters<PostgresExecutionVenueRepository['findFinalizedCanonicalPumpSwapPool']>[0];
  let touched = false;
  const proxy = new Proxy({ mint: MINT, quoteMint: WSOL }, {
    ownKeys: () => {
      touched = true;
      throw new Error('trap');
    },
  });
  const accessor = { quoteMint: WSOL } as { mint: string; quoteMint: string };
  Object.defineProperty(accessor, 'mint', {
    enumerable: true,
    get: () => {
      touched = true;
      return MINT;
    },
  });
  const symbol = { mint: MINT, quoteMint: WSOL, [Symbol('secret')]: true };
  for (const input of [proxy, accessor, symbol]) {
    await assert.rejects(
      new PostgresExecutionVenueRepository(new VenueDatabase([]).pool)
        .findFinalizedCanonicalPumpSwapPool(input as Input),
      (error: unknown) => repositoryError(error, 'INVALID_INPUT'),
    );
  }

  const accessorRow = { ...row() };
  Object.defineProperty(accessorRow, 'pool_address', {
    enumerable: true,
    get: () => {
      touched = true;
      return key(1);
    },
  });
  const proxyRow = new Proxy(row(), {
    ownKeys: () => {
      touched = true;
      throw new Error('row trap');
    },
  });
  for (const hostile of [accessorRow, proxyRow, { ...row(), [Symbol('row')]: true }]) {
    await assert.rejects(
      new PostgresExecutionVenueRepository(new VenueDatabase([hostile]).pool)
        .findFinalizedCanonicalPumpSwapPool({ mint: MINT, quoteMint: WSOL }),
      (error: unknown) => repositoryError(error, 'INVALID_DATA'),
    );
  }
  assert.equal(touched, false);
});

void test('does not trust typed, forged or proxied errors thrown by the database dependency', async () => {
  let proxyTrapCalled = false;
  const typed = new ExecutionVenueRepositoryError('INVALID_DATA');
  const forged = Object.assign(
    Object.create(ExecutionVenueRepositoryError.prototype) as ExecutionVenueRepositoryError,
    { code: 'INVALID_INPUT' as const },
  );
  const proxied = new Proxy(new ExecutionVenueRepositoryError('INVALID_DATA'), {
    getPrototypeOf: () => {
      proxyTrapCalled = true;
      throw new Error('prototype trap');
    },
  });
  for (const dependencyError of [typed, forged, proxied]) {
    const repository = new PostgresExecutionVenueRepository({
      connect: async () => ({
        query: async () => { throw dependencyError; },
        release: () => undefined,
      }),
    });
    await assert.rejects(
      repository.findFinalizedCanonicalPumpSwapPool({ mint: MINT, quoteMint: WSOL }),
      (error: unknown) => repositoryError(error, 'DATABASE_FAILURE'),
    );
  }
  assert.equal(proxyTrapCalled, false);
});

void test('authenticates dependency errors before traversing a hostile proxy prototype chain', async () => {
  let prototypeTrapCalled = false;
  const hostilePrototype = new Proxy({}, {
    getPrototypeOf: () => {
      prototypeTrapCalled = true;
      throw new Error('credential prototype trap');
    },
  });
  const hostileError = new Error('credential dependency error');
  Object.setPrototypeOf(hostileError, hostilePrototype);
  const repository = new PostgresExecutionVenueRepository({
    connect: async () => ({
      query: async () => { throw hostileError; },
      release: () => undefined,
    }),
  });
  await assert.rejects(
    repository.findFinalizedCanonicalPumpSwapPool({ mint: MINT, quoteMint: WSOL }),
    (error: unknown) => {
      repositoryError(error, 'DATABASE_FAILURE');
      assert.equal((error as Error).cause, undefined);
      assert.doesNotMatch((error as Error).message, /credential|prototype|trap/iu);
      return true;
    },
  );
  assert.equal(prototypeTrapCalled, false);
});

function expected(): ExecutionVenuePool {
  return Object.freeze({
    migrationId: 'migration-1',
    migrationInstruction: 'MIGRATE_V2',
    migrationConfirmationStatus: 'finalized',
    poolAddress: key(1),
    market: 'pumpswap',
    programId: key(2),
    poolIndex: 0,
    creator: key(3),
    baseMint: MINT,
    quoteMint: WSOL,
    quoteDecimals: 9,
    baseTokenProgram: 'SPL_TOKEN',
    quoteTokenProgram: 'SPL_TOKEN',
    baseVault: key(4),
    quoteVault: key(5),
    lpMint: key(6),
    poolConfirmationStatus: 'finalized',
    activatedSlot: 9_007_199_254_740_999n,
    transactionIndex: 2,
    instructionIndex: 3,
    innerInstructionIndex: null,
  });
}

function row(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    migration_id: 'migration-1',
    migration_instruction: 'MIGRATE_V2',
    migration_confirmation_status: 'finalized',
    pool_address: key(1),
    market: 'pumpswap',
    program_id: key(2),
    pool_index: 0,
    creator: key(3),
    base_mint: MINT,
    quote_mint: WSOL,
    quote_decimals: 9,
    base_token_program: 'SPL_TOKEN',
    quote_token_program: 'SPL_TOKEN',
    base_vault: key(4),
    quote_vault: key(5),
    lp_mint: key(6),
    pool_confirmation_status: 'finalized',
    activated_slot: '9007199254740999',
    transaction_index: 2,
    instruction_index: 3,
    inner_instruction_index: null,
    ...overrides,
  };
}

function repositoryError(error: unknown, code: string): true {
  assert.ok(error instanceof ExecutionVenueRepositoryError);
  assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /postgres|select|credential/iu);
  return true;
}

class VenueDatabase {
  public readonly calls: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  public releases = 0;

  public constructor(
    private readonly rows: readonly Readonly<Record<string, unknown>>[],
    private readonly fail = false,
  ) {}

  public readonly pool = {
    connect: async () => ({
      query: async (text: string, values: readonly unknown[] = []) => {
        this.calls.push({ text, values });
        if (this.fail) throw new Error('credential postgres select');
        return { rows: this.rows, rowCount: this.rows.length };
      },
      release: () => { this.releases += 1; },
    }),
  };
}

function key(seed: number): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return Array.from({ length: 44 }, (_, index) => alphabet[(seed + index) % alphabet.length]).join('');
}
