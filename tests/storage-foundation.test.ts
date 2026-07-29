import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepositoryId } from '../src/storage/repositories.js';
import {
  MAX_SERIALIZED_BIGINT_DIGITS,
  parseJson,
  stringifyJson,
  toJsonValue,
} from '../src/utils/json.js';

void test('sérialise et restaure exactement les bigint imbriqués', () => {
  const source = {
    lamports: 9_007_199_254_740_993n,
    nested: [{ reserves: -42n }, { basisPoints: 1_500n }],
    ordinaryString: '123',
  };

  const restored: unknown = parseJson(stringifyJson(source));

  assert.deepEqual(restored, source);
});

void test('borne les bigint sérialisés à 78 chiffres signés canoniques', () => {
  assert.equal(MAX_SERIALIZED_BIGINT_DIGITS, 78);
  const positive = BigInt('9'.repeat(78));
  const negative = -positive;

  assert.deepEqual(parseJson(stringifyJson({ positive, negative, zero: 0n })), {
    positive,
    negative,
    zero: 0n,
  });
  assert.throws(
    () => stringifyJson({ oversized: BigInt('1'.repeat(79)) }),
    /Serialized bigint exceeds 78 decimal digits\./u,
  );
});

void test('réserve le singleton exact du marqueur bigint avant sérialisation', () => {
  const reserved = { $solTokenListenerBigInt: '42' };

  assert.throws(
    () => stringifyJson(reserved),
    /The \$solTokenListenerBigInt singleton object is reserved for bigint serialization\./u,
  );
  assert.throws(
    () => stringifyJson({ nested: [{ reserved }] }),
    /The \$solTokenListenerBigInt singleton object is reserved for bigint serialization\./u,
  );
  assert.throws(
    () => stringifyJson({ $solTokenListenerBigInt: 42 }),
    /The \$solTokenListenerBigInt singleton object is reserved for bigint serialization\./u,
  );
});

void test('conserve comme donnée métier un marqueur accompagné d’une autre clé', () => {
  const value = {
    direct: { $solTokenListenerBigInt: '42', meaning: 'business-data' },
    nested: [{ $solTokenListenerBigInt: '01', extra: true }],
  };

  assert.deepEqual(parseJson(stringifyJson(value)), value);
});

void test('autorise la recomposition de marqueurs créés par le même encodeur', () => {
  const encoded = toJsonValue({ amount: 42n });

  assert.deepEqual(toJsonValue({ nested: encoded }), {
    nested: { amount: { $solTokenListenerBigInt: '42' } },
  });
});

void test('invalide la confiance d’un marqueur encodé s’il est ensuite muté', () => {
  const encoded = toJsonValue({ amount: 42n }) as {
    amount: { $solTokenListenerBigInt: string };
  };

  assert.throws(
    () => { encoded.amount.$solTokenListenerBigInt = '9'.repeat(79); },
    TypeError,
  );
  assert.equal(stringifyJson(encoded), '{"amount":{"$solTokenListenerBigInt":"42"}}');
});

void test('verrouille le marqueur contre un getter à état entre validation et sérialisation', () => {
  const encoded = toJsonValue({ amount: 42n }) as {
    amount: { $solTokenListenerBigInt: string };
  };
  let reads = 0;

  assert.throws(
    () => Object.defineProperty(encoded.amount, '$solTokenListenerBigInt', {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads <= 3 ? '42' : '99';
      },
    }),
    TypeError,
  );
  assert.equal(stringifyJson(encoded), '{"amount":{"$solTokenListenerBigInt":"42"}}');
  assert.equal(reads, 0);
});

void test('ne permet pas de forger la confiance en copiant les symboles internes', () => {
  const encoded = toJsonValue({ amount: 42n }) as {
    amount: { $solTokenListenerBigInt: string };
  };
  const forged = { $solTokenListenerBigInt: '42' };
  for (const symbol of Object.getOwnPropertySymbols(encoded.amount)) {
    const descriptor = Object.getOwnPropertyDescriptor(encoded.amount, symbol);
    assert.ok(descriptor);
    Object.defineProperty(forged, symbol, descriptor);
  }

  assert.throws(
    () => stringifyJson(forged),
    /The \$solTokenListenerBigInt singleton object is reserved for bigint serialization\./u,
  );
});

void test('les identifiants de repository sont déterministes et non ambigus', () => {
  const first = createRepositoryId('raw-chain-event', ['ab', 'c']);
  const same = createRepositoryId('raw-chain-event', ['ab', 'c']);
  const ambiguousWithoutLengths = createRepositoryId('raw-chain-event', ['a', 'bc']);

  assert.equal(first, same);
  assert.match(first, /^raw-chain-event_[a-f0-9]{64}$/u);
  assert.notEqual(first, ambiguousWithoutLengths);
});
