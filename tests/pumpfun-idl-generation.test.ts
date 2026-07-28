import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  OFFICIAL_PUMP_IDL_REVISION,
  OFFICIAL_PUMP_IDL_SHA256,
  renderPumpIdlModule,
} from '../scripts/generate-pumpfun-idl.js';
import {
  PUMP_EVENTS,
  PUMP_IDL_REVISION,
  PUMP_IDL_SHA256,
  PUMP_INSTRUCTIONS,
} from '../src/launchpads/pumpfun/generated/pump-idl.js';

const SNAPSHOT = new URL(
  '../vendor/pumpfun/idl/pump-9c82f61.json',
  import.meta.url,
);
const GENERATED = new URL(
  '../src/launchpads/pumpfun/generated/pump-idl.ts',
  import.meta.url,
);

void test('épingle et régénère exactement le sous-ensemble IDL Pump officiel', async () => {
  const idl = await readFile(SNAPSHOT, 'utf8');
  const generated = await readFile(GENERATED, 'utf8');

  assert.equal(PUMP_IDL_REVISION, OFFICIAL_PUMP_IDL_REVISION);
  assert.equal(PUMP_IDL_SHA256, OFFICIAL_PUMP_IDL_SHA256);
  assert.equal(renderPumpIdlModule(idl), generated);
  assert.deepEqual(Object.keys(PUMP_INSTRUCTIONS), [
    'buy',
    'buy_exact_quote_in_v2',
    'buy_exact_sol_in',
    'buy_v2',
    'create',
    'create_v2',
    'sell',
    'sell_v2',
  ]);
  assert.deepEqual(Object.keys(PUMP_EVENTS), ['CreateEvent', 'TradeEvent']);
});
