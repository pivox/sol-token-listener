import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeCatchUpDiscoveries,
  type CatchUpDiscoveryScan,
} from '../src/application/catch-up-discovery.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { CatchUpSourceError, type CatchUpSignature } from '../src/solana/rpc/catch-up-source.js';

void test('preserves one immutable execution outcome while merging programs', () => {
  const merged = mergeCatchUpDiscoveries(Object.freeze([
    scan('launchpad', PUMP_PROGRAM_ID, row(false)),
    scan('market', PUMPSWAP_PROGRAM_ID, row(false)),
  ]));

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.transactionFailed, false);
  assert.deepEqual(merged[0]?.programIds, [PUMPSWAP_PROGRAM_ID, PUMP_PROGRAM_ID].sort());
  assert.equal(Object.isFrozen(merged), true);
  assert.equal(Object.isFrozen(merged[0]), true);
});

void test('rejects contradictory execution outcomes for the same signature', () => {
  assert.throws(() => mergeCatchUpDiscoveries(Object.freeze([
    scan('launchpad', PUMP_PROGRAM_ID, row(false)),
    scan('market', PUMPSWAP_PROGRAM_ID, row(true)),
  ])), (error: unknown) => {
    assert.ok(error instanceof CatchUpSourceError);
    assert.equal(error.stage, 'response');
    assert.equal(error.program, 'market');
    return true;
  });
});

function scan(
  key: 'launchpad' | 'market',
  id: string,
  value: CatchUpSignature,
): CatchUpDiscoveryScan {
  return Object.freeze({
    program: Object.freeze({ key, id }),
    rows: Object.freeze([value]),
  });
}

function row(transactionFailed: boolean): CatchUpSignature {
  return Object.freeze({
    signature: 'same-signature',
    slot: 42n,
    confirmationStatus: 'confirmed',
    blockTimeMs: 1_000,
    transactionFailed,
  });
}
