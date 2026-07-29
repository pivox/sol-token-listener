import assert from 'node:assert/strict';
import test from 'node:test';
import { PumpSwapDecodingError } from '../src/markets/pumpswap/errors.js';
import { decodePumpSwapTransaction } from '../src/markets/pumpswap/transaction-decoder.js';
import type {
  DecodedPumpSwapCpiEvent,
  DecodedPumpSwapInstruction,
} from '../src/markets/pumpswap/types.js';
import type {
  NormalizedInstruction,
  NormalizedTransaction,
} from '../src/solana/rpc/types.js';

void test('apparie BUY et SELL dans leur portée CPI sans delta global', () => {
  const buyAction = instruction(2, 0, 2, 1);
  const buyEvent = instruction(2, 1, 3, 2);
  const sellAction = instruction(2, 2, 2, 3);
  const sellEvent = instruction(2, 3, 3, 4);
  const decoded = decodePumpSwapTransaction(
    transaction([buyAction, buyEvent, sellAction, sellEvent]),
    (ix) => {
      if (ix === buyAction) return action(ix, 'BUY');
      if (ix === sellAction) return action(ix, 'SELL');
      return null;
    },
    (ix) => {
      if (ix === buyEvent) return event(ix, 'BUY');
      if (ix === sellEvent) return event(ix, 'SELL');
      return null;
    },
  );

  assert.equal(decoded.trades.length, 2);
  assert.equal(decoded.trades[0]?.kind, 'BUY');
  assert.equal(decoded.trades[0]?.baseAmountRaw, 100n);
  assert.equal(decoded.trades[0]?.quoteAmountRaw, 55n);
  assert.equal(decoded.trades[1]?.kind, 'SELL');
  assert.equal(decoded.trades[1]?.quoteAmountRaw, 45n);
});

void test('isole un événement PumpSwap orphelin ou ambigu', () => {
  const actionIx = instruction(2, 0, 2, 1);
  const eventA = instruction(2, 1, 3, 2);
  const eventB = instruction(2, 2, 3, 3);
  const orphaned = decodePumpSwapTransaction(
      transaction([eventA]),
      () => null,
      () => event(eventA, 'BUY'),
    );
  assert.equal(orphaned.issues.some(isCode('PUMPSWAP_EVENT_ORPHANED')), true);
  const ambiguous = decodePumpSwapTransaction(
      transaction([actionIx, eventA, eventB]),
      (ix) => ix === actionIx ? action(ix, 'BUY') : null,
      (ix) => ix === eventA || ix === eventB ? event(ix, 'BUY') : null,
    );
  assert.equal(ambiguous.issues.some(isCode('PUMPSWAP_EVENT_AMBIGUOUS')), true);
  assert.equal(ambiguous.trades.length, 0);
});

void test('conserve les trades valides lorsqu’une autre action locale échoue', () => {
  const badAction = instruction(1, 0, 2, 1);
  const sellAction = instruction(2, 0, 2, 2);
  const sellEvent = instruction(2, 1, 3, 3);
  const decoded = decodePumpSwapTransaction(
    transaction([badAction, sellAction, sellEvent]),
    (ix) => {
      if (ix === badAction) return action(ix, 'BUY');
      if (ix === sellAction) return action(ix, 'SELL');
      return null;
    },
    (ix) => ix === sellEvent ? event(ix, 'SELL') : null,
  );
  assert.equal(decoded.trades.length, 1);
  assert.equal(decoded.trades[0]?.kind, 'SELL');
  assert.equal(decoded.issues.some(isCode('PUMPSWAP_EVENT_MISSING')), true);
  assert.deepEqual(decoded.issues[0]?.cursor, {
    slot: 1n,
    transactionIndex: 0,
    instructionIndex: 1,
    innerInstructionIndex: 0,
  });
});

function action(
  instructionValue: NormalizedInstruction,
  family: 'BUY' | 'SELL',
): DecodedPumpSwapInstruction {
  return {
    name: family === 'BUY' ? 'buy_exact_quote_in' : 'sell',
    family,
    instruction: instructionValue,
    accounts: {
      pool: 'pool',
      user: 'user',
      base_mint: 'base',
      quote_mint: 'quote',
    },
    args: {},
  };
}

function event(
  instructionValue: NormalizedInstruction,
  kind: 'BUY' | 'SELL',
): DecodedPumpSwapCpiEvent {
  return {
    kind,
    instruction: instructionValue,
    trailingDataHex: '',
    fields: kind === 'BUY'
      ? {
        pool: 'pool', user: 'user', base_amount_out: 100n,
        quote_amount_in: 50n, user_quote_amount_in: 55n,
        ix_name: 'buy_exact_quote_in',
      }
      : {
        pool: 'pool', user: 'user', base_amount_in: 100n,
        quote_amount_out: 50n, user_quote_amount_out: 45n,
      },
  };
}

function instruction(
  instructionIndex: number,
  innerInstructionIndex: number,
  stackHeight: number,
  marker: number,
): NormalizedInstruction {
  return {
    programId: 'program',
    accounts: [],
    data: Uint8Array.of(marker),
    instructionIndex,
    innerInstructionIndex,
    parentInstructionIndex: instructionIndex,
    stackHeight,
  };
}

function transaction(
  instructions: readonly NormalizedInstruction[],
): NormalizedTransaction {
  return {
    signature: 'signature',
    slot: 1n,
    transactionIndex: 0,
    confirmationStatus: 'CONFIRMED',
    version: 0,
    blockTimeMs: 1_000,
    accountKeys: [],
    signerKeys: [],
    instructions,
    preTokenBalances: [],
    postTokenBalances: [],
    preBalancesLamports: [],
    postBalancesLamports: [],
    feeLamports: 0n,
    computeUnits: null,
    logs: [],
    error: null,
  };
}

function isCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof PumpSwapDecodingError && error.code === code;
}
