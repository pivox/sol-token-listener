import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { parseLivePositionOperatorArgs } from '../src/cli/live-position-operator.js';

void test('operator status is a read-only position query and recheck requires explicit position, wallet and bounded budget', () => {
  const wallet = PublicKey.default.toBase58();
  assert.deepEqual(parseLivePositionOperatorArgs(['status','--position','position-1','--wallet',wallet]),
    { kind:'status',positionId:'position-1',wallet });
  assert.deepEqual(parseLivePositionOperatorArgs(['recheck','--position','position-1','--wallet',wallet,'--additional-checks','3']),
    { kind:'recheck',positionId:'position-1',wallet,additionalChecks:3 });
  assert.throws(() => parseLivePositionOperatorArgs(['recheck','--position','position-1','--wallet',wallet]), /requires --additional-checks/u);
  assert.throws(() => parseLivePositionOperatorArgs(['recheck','--position','position-1','--wallet',wallet,'--additional-checks','0']), /between 1 and 20/u);
});
