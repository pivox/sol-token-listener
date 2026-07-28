import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepositoryId } from '../src/storage/repositories.js';
import { parseJson, stringifyJson } from '../src/utils/json.js';

void test('sérialise et restaure exactement les bigint imbriqués', () => {
  const source = {
    lamports: 9_007_199_254_740_993n,
    nested: [{ reserves: -42n }, { basisPoints: 1_500n }],
    ordinaryString: '123',
  };

  const restored: unknown = parseJson(stringifyJson(source));

  assert.deepEqual(restored, source);
});

void test('les identifiants de repository sont déterministes et non ambigus', () => {
  const first = createRepositoryId('raw-chain-event', ['ab', 'c']);
  const same = createRepositoryId('raw-chain-event', ['ab', 'c']);
  const ambiguousWithoutLengths = createRepositoryId('raw-chain-event', ['a', 'bc']);

  assert.equal(first, same);
  assert.match(first, /^raw-chain-event_[a-f0-9]{64}$/u);
  assert.notEqual(first, ambiguousWithoutLengths);
});
