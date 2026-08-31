import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { WSOL_MINT } from '../src/launchpads/pumpfun/constants.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { bondingCurvePda } from '../src/launchpads/pumpfun/official-sdk.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import {
  poolPda,
  pumpPoolAuthorityPda,
} from '../src/markets/pumpswap/official-sdk.js';
import type {
  ExecutionVenuePool,
  ExecutionVenueRepository,
} from '../src/ports/execution-venue-repository.js';
import {
  ExecutionVenueRouter,
  ExecutionVenueRoutingError,
} from '../src/executor-simulation/venue-router.js';
import {
  ExecutionVenueRepositoryError,
  PostgresExecutionVenueRepository,
} from '../src/storage/execution-venue.repository.js';

const MINT = publicKey(1);
const CREATOR = pumpPoolAuthorityPda(new PublicKey(MINT)).toBase58();
const POOL = poolPda(
  0,
  new PublicKey(CREATOR),
  new PublicKey(MINT),
  new PublicKey(WSOL_MINT),
).toBase58();

void test('routes BUY only to an active Pump.fun bonding curve without a database lookup', async () => {
  const repository = new FakeRepository(null);
  const router = new ExecutionVenueRouter(repository);
  const result = await router.route(request('BUY', 'PUMP_FUN_ONLY'), curve(false));
  assert.deepEqual(result, { venue: 'PUMP_FUN', pool: null });
  assert.equal(repository.calls, 0);

  await assert.rejects(
    router.route(request('BUY', 'PUMP_FUN_ONLY'), curve(true)),
    (error: unknown) => routeError(error, 'VENUE_UNAVAILABLE'),
  );
});

void test('routes SELL to Pump.fun while the canonical curve remains active', async () => {
  const repository = new FakeRepository(pool());
  const result = await new ExecutionVenueRouter(repository).route(
    request('SELL', 'CANONICAL_EXIT'),
    curve(false),
  );
  assert.deepEqual(result, { venue: 'PUMP_FUN', pool: null });
  assert.equal(repository.calls, 0);
});

void test('routes SELL to a durable finalized canonical PumpSwap pool after completion', async () => {
  const proof = pool();
  const repository = new FakeRepository(proof);
  const result = await new ExecutionVenueRouter(repository).route(
    request('SELL', 'CANONICAL_EXIT'),
    curve(true),
  );
  assert.deepEqual(result, { venue: 'PUMP_SWAP', pool: proof });
  assert.equal(repository.calls, 1);
  assert.deepEqual(repository.lastInput, { mint: MINT, quoteMint: WSOL_MINT });
});

void test('fails closed without a finalized proof or with a noncanonical pool', async () => {
  for (const proof of [
    null,
    pool({ poolAddress: publicKey(30) }),
    pool({ programId: publicKey(31) }),
    pool({ creator: publicKey(32) }),
    pool({ migrationConfirmationStatus: 'confirmed' as 'finalized' }),
    pool({ poolConfirmationStatus: 'orphaned' as 'finalized' }),
  ]) {
    await assert.rejects(
      new ExecutionVenueRouter(new FakeRepository(proof)).route(
        request('SELL', 'CANONICAL_EXIT'),
        curve(true),
      ),
      (error: unknown) => routeError(error, 'VENUE_UNAVAILABLE'),
    );
  }
});

void test('enforces the V1 WSOL/SPL/9 allowlist and side-policy pairing', async () => {
  const router = new ExecutionVenueRouter(new FakeRepository(pool()));
  for (const invalid of [
    request('BUY', 'CANONICAL_EXIT'),
    request('SELL', 'PUMP_FUN_ONLY'),
    { ...request('BUY', 'PUMP_FUN_ONLY'), quoteMint: publicKey(40) },
    { ...request('BUY', 'PUMP_FUN_ONLY'), quoteTokenProgram: 'TOKEN_2022' as const },
    { ...request('BUY', 'PUMP_FUN_ONLY'), quoteDecimals: 6 },
  ]) {
    await assert.rejects(
      router.route(invalid, curve(false)),
      (error: unknown) => routeError(
        error,
        invalid.quoteMint === WSOL_MINT
          && invalid.quoteTokenProgram === 'SPL_TOKEN'
          && invalid.quoteDecimals === 9
          ? 'EXECUTION_EVIDENCE_INVALID'
          : 'QUOTE_MINT_NOT_ALLOWED',
      ),
    );
  }
});

void test('rejects proxy, accessor and symbol route evidence without invoking traps', async () => {
  type RouteRequest = Parameters<ExecutionVenueRouter['route']>[0];
  let touched = false;
  const proxy = new Proxy(request('BUY', 'PUMP_FUN_ONLY'), {
    ownKeys: () => {
      touched = true;
      throw new Error('trap');
    },
  });
  const accessor = { ...request('BUY', 'PUMP_FUN_ONLY') };
  Object.defineProperty(accessor, 'mint', {
    enumerable: true,
    get: () => {
      touched = true;
      return MINT;
    },
  });
  const symbol = { ...request('BUY', 'PUMP_FUN_ONLY'), [Symbol('secret')]: true };
  const router = new ExecutionVenueRouter(new FakeRepository(null));
  for (const hostile of [proxy, accessor, symbol]) {
    await assert.rejects(
      router.route(hostile as RouteRequest, curve(false)),
      (error: unknown) => routeError(error, 'EXECUTION_EVIDENCE_INVALID'),
    );
  }

  const poolProxy = new Proxy(pool(), {
    ownKeys: () => {
      touched = true;
      throw new Error('pool trap');
    },
  });
  await assert.rejects(
    new ExecutionVenueRouter(new FakeRepository(poolProxy)).route(
      request('SELL', 'CANONICAL_EXIT'),
      curve(true),
    ),
    (error: unknown) => routeError(error, 'VENUE_UNAVAILABLE'),
  );
  assert.equal(touched, false);
});

void test('requires an existing canonical Pump.fun curve owned by the official program', async () => {
  const router = new ExecutionVenueRouter(new FakeRepository(null));
  for (const invalid of [
    curve(false, { exists: false }),
    curve(false, { bondingCurveAddress: publicKey(50) }),
    curve(false, { ownerProgramId: publicKey(51) }),
  ]) {
    await assert.rejects(
      router.route(request('BUY', 'PUMP_FUN_ONLY'), invalid),
      (error: unknown) => routeError(error, 'EXECUTION_EVIDENCE_INVALID'),
    );
  }
});

void test('maps an authenticated duplicate durable candidate to venue unavailable', async () => {
  const repository = postgresRepository({ rows: [{}, {}], rowCount: 2 });
  await assert.rejects(
    new ExecutionVenueRouter(repository).route(
      request('SELL', 'CANONICAL_EXIT'),
      curve(true),
    ),
    (error: unknown) => routeError(error, 'VENUE_UNAVAILABLE'),
  );
});

void test('propagates a real database failure instead of classifying it as venue unavailable', async () => {
  const repository = postgresRepository(new Error('database unavailable'));
  await assert.rejects(
    new ExecutionVenueRouter(repository).route(
      request('SELL', 'CANONICAL_EXIT'),
      curve(true),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ExecutionVenueRepositoryError);
      assert.equal(error.code, 'DATABASE_FAILURE');
      assert.equal(error instanceof ExecutionVenueRoutingError, false);
      return true;
    },
  );
});

void test('does not classify a forged repository error as durable ambiguity', async () => {
  const forged = new ExecutionVenueRepositoryError('INVALID_DATA');
  const repository: ExecutionVenueRepository = {
    findFinalizedCanonicalPumpSwapPool: async () => { throw forged; },
  };
  await assert.rejects(
    new ExecutionVenueRouter(repository).route(
      request('SELL', 'CANONICAL_EXIT'),
      curve(true),
    ),
    (error: unknown) => {
      assert.equal(error, forged);
      assert.equal(error instanceof ExecutionVenueRoutingError, false);
      return true;
    },
  );
});

void test('rejects nested coercible pool addresses without invoking conversion traps', async () => {
  let conversionTrapCalled = false;
  const coercible = Object.defineProperties({}, {
    toString: {
      get: () => {
        conversionTrapCalled = true;
        throw new Error('toString credential trap');
      },
    },
    [Symbol.toPrimitive]: {
      get: () => {
        conversionTrapCalled = true;
        throw new Error('primitive credential trap');
      },
    },
  });
  const nestedProxy = new Proxy({}, {
    get: () => {
      conversionTrapCalled = true;
      throw new Error('nested credential trap');
    },
  });
  for (const [field, value] of [
    ['poolAddress', coercible],
    ['creator', nestedProxy],
    ['baseVault', coercible],
    ['quoteVault', nestedProxy],
    ['lpMint', coercible],
  ] as const) {
    const hostile = pool({ [field]: value } as Partial<ExecutionVenuePool>);
    await assert.rejects(
      new ExecutionVenueRouter(new FakeRepository(hostile)).route(
        request('SELL', 'CANONICAL_EXIT'),
        curve(true),
      ),
      (error: unknown) => routeError(error, 'VENUE_UNAVAILABLE'),
    );
  }
  assert.equal(conversionTrapCalled, false);
});

function request(
  side: 'BUY' | 'SELL',
  venuePolicy: 'PUMP_FUN_ONLY' | 'CANONICAL_EXIT',
) {
  return Object.freeze({
    side,
    venuePolicy,
    mint: MINT,
    quoteMint: WSOL_MINT,
    quoteTokenProgram: 'SPL_TOKEN' as const,
    quoteDecimals: 9,
  });
}

function curve(complete: boolean, overrides: Readonly<Record<string, unknown>> = {}) {
  return Object.freeze({
    mint: MINT,
    normalizedQuoteMint: WSOL_MINT,
    complete,
    exists: true,
    bondingCurveAddress: bondingCurvePda(new PublicKey(MINT)).toBase58(),
    ownerProgramId: PUMP_PROGRAM_ID,
    ...overrides,
  });
}

function pool(overrides: Partial<ExecutionVenuePool> = {}): ExecutionVenuePool {
  return Object.freeze({
    migrationId: 'migration-1',
    migrationInstruction: 'MIGRATE_V2',
    migrationConfirmationStatus: 'finalized',
    poolAddress: POOL,
    market: 'pumpswap',
    programId: PUMPSWAP_PROGRAM_ID,
    poolIndex: 0,
    creator: CREATOR,
    baseMint: MINT,
    quoteMint: WSOL_MINT,
    quoteDecimals: 9,
    baseTokenProgram: 'SPL_TOKEN',
    quoteTokenProgram: 'SPL_TOKEN',
    baseVault: publicKey(3),
    quoteVault: publicKey(4),
    lpMint: publicKey(5),
    poolConfirmationStatus: 'finalized',
    activatedSlot: 123n,
    transactionIndex: 0,
    instructionIndex: 1,
    innerInstructionIndex: null,
    ...overrides,
  });
}

class FakeRepository implements ExecutionVenueRepository {
  public calls = 0;
  public lastInput: Readonly<{ readonly mint: string; readonly quoteMint: string }> | null = null;

  public constructor(private readonly result: ExecutionVenuePool | null) {}

  public async findFinalizedCanonicalPumpSwapPool(
    input: Readonly<{ readonly mint: string; readonly quoteMint: string }>,
  ): Promise<ExecutionVenuePool | null> {
    this.calls += 1;
    this.lastInput = input;
    return this.result;
  }
}

function postgresRepository(
  outcome: Error | Readonly<{
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly rowCount: number;
  }>,
) {
  return new (class extends PostgresExecutionVenueRepository {})({
    connect: async () => ({
      query: async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      release: () => undefined,
    }),
  });
}

function routeError(error: unknown, code: string): true {
  assert.ok(error instanceof ExecutionVenueRoutingError);
  assert.equal(error.code, code);
  return true;
}

function publicKey(seed: number): string {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256)).toBase58();
}
