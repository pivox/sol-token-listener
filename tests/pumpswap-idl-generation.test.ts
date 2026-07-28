import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  OFFICIAL_PUMP_AMM_IDL_REVISION,
  OFFICIAL_PUMP_AMM_IDL_SHA256,
  renderPumpSwapIdlModule,
} from '../scripts/generate-pumpswap-idl.js';
import {
  PUMPSWAP_ACCOUNTS,
  PUMPSWAP_EVENTS,
  PUMPSWAP_IDL_REVISION,
  PUMPSWAP_IDL_SHA256,
  PUMPSWAP_INSTRUCTIONS,
  PUMPSWAP_TYPES,
} from '../src/markets/pumpswap/generated/pumpswap-idl.js';

const SNAPSHOT = new URL(
  '../vendor/pumpfun/idl/pump-amm-9c82f61.json',
  import.meta.url,
);
const GENERATED = new URL(
  '../src/markets/pumpswap/generated/pumpswap-idl.ts',
  import.meta.url,
);

void test('épingle et régénère le sous-ensemble IDL PumpSwap officiel', async () => {
  const idl = await readFile(SNAPSHOT, 'utf8');
  const generated = await readFile(GENERATED, 'utf8');

  assert.equal(
    OFFICIAL_PUMP_AMM_IDL_REVISION,
    '9c82f61cb711b044a17f770ab8ce9f9bdf78f333',
  );
  assert.equal(
    OFFICIAL_PUMP_AMM_IDL_SHA256,
    '6b5c7ec4e5ef9742fa99dc57b0d75b1031b379bba02a7e1b3c5a4cad68d77e56',
  );
  assert.equal(PUMPSWAP_IDL_REVISION, OFFICIAL_PUMP_AMM_IDL_REVISION);
  assert.equal(PUMPSWAP_IDL_SHA256, OFFICIAL_PUMP_AMM_IDL_SHA256);
  assert.equal(renderPumpSwapIdlModule(idl), generated);
  assert.deepEqual(Object.keys(PUMPSWAP_INSTRUCTIONS), [
    'buy',
    'buy_exact_quote_in',
    'create_pool',
    'sell',
  ]);
  assert.deepEqual(Object.keys(PUMPSWAP_EVENTS), [
    'BuyEvent',
    'CreatePoolEvent',
    'SellEvent',
  ]);
  assert.deepEqual(Object.keys(PUMPSWAP_ACCOUNTS), [
    'FeeConfig',
    'GlobalConfig',
    'Pool',
  ]);
  assert.deepEqual(Object.keys(PUMPSWAP_TYPES), [
    'BuyEvent',
    'CreatePoolEvent',
    'FeeConfig',
    'FeeTier',
    'Fees',
    'OptionBool',
    'Pool',
    'SellEvent',
  ]);
});
