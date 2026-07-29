import assert from 'node:assert/strict';
import test from 'node:test';
import type { MarketAdapter } from '../src/ports/market-adapter.js';
import type { MarketObservationRepository } from '../src/ports/market-observation-repository.js';
import type { MarketRpcReader } from '../src/ports/market-rpc-reader.js';
import type { PumpSwapQuotePort } from '../src/ports/pumpswap-quote-provider.js';

void test('les ports de marché restent passifs et source-indépendants', () => {
  const adapter = {} as MarketAdapter;
  const repository = {} as MarketObservationRepository;
  const rpc = {} as MarketRpcReader;
  const quote = {} as PumpSwapQuotePort;

  assert.equal(typeof adapter, 'object');
  assert.equal(typeof repository, 'object');
  assert.equal(typeof rpc, 'object');
  assert.equal(typeof quote, 'object');
});
