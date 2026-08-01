import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PublicKey,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import {
  BlockUnavailableError,
  MAX_BLOCK_SIGNATURE_COUNT,
  MAX_TRANSACTION_SIGNATURE_LENGTH,
  RpcTransientError,
  TransactionIndexNotFoundError,
  TransactionLocator,
  TransactionNormalizationError,
  TransactionUnavailableError,
  type TransactionLocatorRpc,
  type TransactionLocationTarget,
} from '../src/solana/rpc/transaction-locator.js';

const PAYER = new PublicKey('11111111111111111111111111111111');
const PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const LOADED = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

function target(signature: string, slot = 42n): TransactionLocationTarget {
  return Object.freeze({ signature, slot, confirmationStatus: 'CONFIRMED' });
}

function response(
  signature: string,
  slot = 42,
  options: { readonly rich?: boolean; readonly error?: unknown } = {},
): VersionedTransactionResponse {
  const staticKeys = [PAYER, PROGRAM];
  const allKeys = options.rich === true ? [...staticKeys, LOADED] : staticKeys;
  return {
    slot,
    blockTime: options.rich === true ? 1_725_000_000 : null,
    version: options.rich === true ? 0 : 'legacy',
    transaction: {
      signatures: [signature],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1,
        },
        compiledInstructions: [{
          programIdIndex: 1,
          accountKeyIndexes: options.rich === true ? [2] : [],
          data: new Uint8Array([1, 2, 3]),
        }],
        getAccountKeys: (args?: unknown) => {
          if (options.rich === true) assert.notEqual(args, undefined);
          return {
            length: allKeys.length,
            get: (index: number) => allKeys[index],
          };
        },
      },
    },
    meta: {
      err: options.error ?? null,
      fee: 5_000,
      preBalances: [10_000, 0, 0],
      postBalances: [5_000, 0, 0],
      innerInstructions: options.rich === true ? [{
        index: 0,
        instructions: [{
          programIdIndex: 1,
          accounts: [2],
          data: '',
          stackHeight: 3,
        }],
      }] : [],
      preTokenBalances: options.rich === true ? [{
        accountIndex: 2,
        mint: LOADED.toBase58(),
        owner: PAYER.toBase58(),
        programId: TOKEN_2022,
        uiTokenAmount: { amount: '9007199254740993', decimals: 9, uiAmount: null, uiAmountString: '9007199.254740993' },
      }] : [],
      postTokenBalances: options.rich === true ? [{
        accountIndex: 2,
        mint: LOADED.toBase58(),
        owner: PAYER.toBase58(),
        programId: TOKEN_2022,
        uiTokenAmount: { amount: '9007199254740994', decimals: 9, uiAmount: null, uiAmountString: '9007199.254740994' },
      }] : [],
      loadedAddresses: options.rich === true
        ? { writable: [LOADED], readonly: [] }
        : { writable: [], readonly: [] },
      logMessages: options.rich === true ? ['Program log: preserved'] : [],
      rewards: [],
      computeUnitsConsumed: options.rich === true ? 123_456 : undefined,
    },
  } as unknown as VersionedTransactionResponse;
}

function rpc(
  transaction: VersionedTransactionResponse | null,
  signatures: readonly string[] | null,
): TransactionLocatorRpc {
  return {
    getTransaction: async () => transaction,
    getBlockSignatures: async () => signatures,
  };
}

void test('uses position zero only when the target is actually first in its block', async () => {
  const located = await new TransactionLocator(rpc(response('pump'), ['pump', 'other']))
    .locate(target('pump'));
  assert.equal(located.transactionIndex, 0);
});

void test('locates Pump and PumpSwap signatures independently in the same slot', async () => {
  const signatures = ['other', 'pump', 'swap'];
  const locator = new TransactionLocator({
    getTransaction: async (signature) => response(signature),
    getBlockSignatures: async () => signatures,
  });

  assert.equal((await locator.locate(target('pump'))).transactionIndex, 1);
  assert.equal((await locator.locate(target('swap'))).transactionIndex, 2);
});

void test('classifies a null transaction as retryable and exposes no target details', async () => {
  await assert.rejects(
    new TransactionLocator(rpc(null, ['secret-signature'])).locate(target('secret-signature')),
    (error: unknown) => {
      assert.ok(error instanceof TransactionUnavailableError);
      assert.equal(error.code, 'TRANSACTION_NOT_AVAILABLE');
      assert.equal(error.retryable, true);
      assert.doesNotMatch(String(error), /secret-signature|42/u);
      return true;
    },
  );
});

void test('classifies a null block signature list as retryable block unavailability', async () => {
  await assert.rejects(
    new TransactionLocator(rpc(response('pump'), null)).locate(target('pump')),
    (error: unknown) => error instanceof BlockUnavailableError
      && error.code === 'BLOCK_NOT_AVAILABLE'
      && error.retryable,
  );
});

void test('rejects a transaction returned from a different slot', async () => {
  await assert.rejects(
    new TransactionLocator(rpc(response('pump', 43), ['pump'])).locate(target('pump')),
    (error: unknown) => error instanceof TransactionIndexNotFoundError
      && error.code === 'TRANSACTION_INDEX_NOT_FOUND'
      && !error.retryable,
  );
});

void test('rejects a fetched transaction whose normalized primary signature differs', async () => {
  await assert.rejects(
    new TransactionLocator(rpc(response('different'), ['pump'])).locate(target('pump')),
    TransactionIndexNotFoundError,
  );
});

void test('rejects a stateful raw slot without invoking its accessor', async () => {
  const stateful = response('pump');
  let reads = 0;
  Object.defineProperty(stateful, 'slot', {
    get: () => {
      reads += 1;
      return reads === 1 ? 42 : 43;
    },
  });

  await assert.rejects(
    new TransactionLocator(rpc(stateful, ['pump'])).locate(target('pump')),
    TransactionNormalizationError,
  );
  assert.equal(reads, 0);
});

void test('rejects an unsafe rounded RPC slot even when its bigint conversion matches the target', async () => {
  const unsafeSlot = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(
    new TransactionLocator(rpc(response('pump', unsafeSlot), ['pump'])).locate(
      target('pump', 9_007_199_254_740_992n),
    ),
    TransactionNormalizationError,
  );
});

void test('rejects negative, fractional, non-enumerable and inherited raw slots', async () => {
  const negative = response('pump', -1);
  const fractional = response('pump', 42.5);
  const nonEnumerable = response('pump');
  Object.defineProperty(nonEnumerable, 'slot', { value: 42, enumerable: false });
  const inherited = response('pump');
  Reflect.deleteProperty(inherited, 'slot');
  Object.setPrototypeOf(inherited, { slot: 42 });

  const cases: readonly [VersionedTransactionResponse, bigint][] = [
    [negative, -1n],
    [fractional, 42n],
    [nonEnumerable, 42n],
    [inherited, 42n],
  ];
  for (const [transaction, slot] of cases) {
    await assert.rejects(
      new TransactionLocator(rpc(transaction, ['pump'])).locate(target('pump', slot)),
      TransactionNormalizationError,
    );
  }
});

void test('rejects missing and duplicate block signature membership without inventing an index', async () => {
  for (const signatures of [['other'], ['pump', 'other', 'pump']]) {
    await assert.rejects(
      new TransactionLocator(rpc(response('pump'), signatures)).locate(target('pump')),
      TransactionIndexNotFoundError,
    );
  }
});

void test('redacts ordinary and hostile RPC rejections', async () => {
  const hostile = new Error();
  Object.defineProperties(hostile, {
    message: { get: () => { throw new Error('message getter invoked'); } },
    name: { get: () => { throw new Error('name getter invoked'); } },
    toString: { value: () => 'https://rpc.invalid/private-key' },
  });
  for (const cause of [new Error('https://rpc.invalid/private-key'), hostile]) {
    const locator = new TransactionLocator({
      getTransaction: () => Promise.reject(cause),
      getBlockSignatures: async () => ['pump'],
    });
    await assert.rejects(locator.locate(target('pump')), (error: unknown) => {
      assert.ok(error instanceof RpcTransientError);
      assert.equal(error.code, 'RPC_TRANSIENT');
      assert.equal(error.retryable, true);
      assert.doesNotMatch(String(error), /rpc\.invalid|private-key|getter/u);
      assert.equal('cause' in error, false);
      return true;
    });
  }
});

void test('maps block RPC rejection to the same redacted transient contract', async () => {
  const locator = new TransactionLocator({
    getTransaction: async () => response('pump'),
    getBlockSignatures: async () => { throw new Error('https://rpc.invalid/token'); },
  });
  await assert.rejects(locator.locate(target('pump')), (error: unknown) => {
    assert.ok(error instanceof RpcTransientError);
    assert.doesNotMatch(JSON.stringify(error), /rpc\.invalid|token/u);
    return true;
  });
});

void test('contains hostile accessors returned by the RPC port', async () => {
  const hostileTransaction = response('pump');
  Object.defineProperty(hostileTransaction, 'slot', {
    get: () => { throw new Error('https://rpc.invalid/slot-secret'); },
  });
  await assert.rejects(
    new TransactionLocator(rpc(hostileTransaction, ['pump'])).locate(target('pump')),
    (error: unknown) => error instanceof TransactionNormalizationError
      && !String(error).includes('slot-secret'),
  );

  const hostileSignatures = new Proxy(['pump'], {
    get: () => { throw new Error('https://rpc.invalid/block-secret'); },
  });
  await assert.rejects(
    new TransactionLocator(rpc(response('pump'), hostileSignatures)).locate(target('pump')),
    (error: unknown) => error instanceof RpcTransientError
      && !String(error).includes('block-secret'),
  );
});

void test('rejects sparse, non-array and globally duplicate block signatures', async () => {
  const sparse = new Array<string>(2);
  sparse[1] = 'pump';
  for (const signatures of [
    sparse,
    { 0: 'pump', length: 1 } as unknown as readonly string[],
    ['pump', 'other', 'other'],
  ]) {
    await assert.rejects(
      new TransactionLocator(rpc(response('pump'), signatures)).locate(target('pump')),
      BlockUnavailableError,
    );
  }
});

void test('rejects block signature accessors without invoking them', async () => {
  let entryReads = 0;
  const accessorEntry = ['other', 'pump'];
  Object.defineProperty(accessorEntry, '0', {
    enumerable: true,
    configurable: true,
    get: () => { entryReads += 1; return 'other'; },
  });
  let lengthReads = 0;
  const accessorLength = Object.create(Array.prototype) as Record<string, unknown>;
  Object.defineProperty(accessorLength, 'length', {
    get: () => { lengthReads += 1; return 1; },
  });

  for (const signatures of [
    accessorEntry,
    accessorLength as unknown as readonly string[],
  ]) {
    await assert.rejects(
      new TransactionLocator(rpc(response('pump'), signatures)).locate(target('pump')),
      BlockUnavailableError,
    );
  }
  assert.equal(entryReads, 0);
  assert.equal(lengthReads, 0);
});

void test('contains a proxy Infinity length trap with bounded reads', async () => {
  let valueReads = 0;
  const proxy = new Proxy(['pump'], {
    get: (value, property, receiver) => {
      valueReads += 1;
      if (property === 'length') return Infinity;
      if (property === '2') throw new Error('https://rpc.invalid/infinity-secret');
      const result: unknown = Reflect.get(value, property, receiver);
      return result;
    },
  });

  await assert.rejects(
    new TransactionLocator(rpc(response('pump'), proxy)).locate(target('pump')),
    BlockUnavailableError,
  );
  assert.ok(valueReads > 0 && valueReads <= 4);
});

void test('bounds block signature count, signature bytes and unexpected own keys', async () => {
  const oversizedCount = new Array<string>(MAX_BLOCK_SIGNATURE_COUNT + 1).fill('other');
  oversizedCount[0] = 'pump';
  const oversizedSignature = 'x'.repeat(MAX_TRANSACTION_SIGNATURE_LENGTH + 1);
  const extraKey = ['pump'];
  Object.defineProperty(extraKey, Symbol('hostile'), { value: 'secret' });

  for (const signatures of [oversizedCount, ['pump', oversizedSignature], extraKey]) {
    await assert.rejects(
      new TransactionLocator(rpc(response('pump'), signatures)).locate(target('pump')),
      BlockUnavailableError,
    );
  }
});

void test('accepts exact bounded dense block signatures without losing the canonical index', async () => {
  const signatures = Array.from(
    { length: MAX_BLOCK_SIGNATURE_COUNT },
    (_unused, index) => `signature-${index}`,
  );
  const exactLengthTarget = 'p'.repeat(MAX_TRANSACTION_SIGNATURE_LENGTH);
  signatures[MAX_BLOCK_SIGNATURE_COUNT - 1] = exactLengthTarget;

  const located = await new TransactionLocator(rpc(
    response(exactLengthTarget),
    signatures,
  )).locate(target(exactLengthTarget));
  assert.equal(located.transactionIndex, MAX_BLOCK_SIGNATURE_COUNT - 1);
});

void test('preserves v0 lookups, inner stack heights, Token-2022 balances, failure and finality', async () => {
  const transactionError = Object.freeze({ InstructionError: [0, 'Custom'] });
  const located = await new TransactionLocator(rpc(
    response('swap', 42, { rich: true, error: transactionError }),
    ['other', 'swap'],
  )).locate(target('swap'));

  assert.equal(located.transactionIndex, 1);
  assert.equal(located.version, 0);
  assert.deepEqual(located.accountKeys, [PAYER, PROGRAM, LOADED].map((key) => key.toBase58()));
  assert.equal(located.instructions[0]?.stackHeight, 1);
  assert.equal(located.instructions[1]?.innerInstructionIndex, 0);
  assert.equal(located.instructions[1]?.parentInstructionIndex, 0);
  assert.equal(located.instructions[1]?.stackHeight, 3);
  assert.equal(located.preTokenBalances[0]?.tokenProgram, TOKEN_2022);
  assert.equal(located.preTokenBalances[0]?.amountRaw, 9_007_199_254_740_993n);
  assert.equal(located.postTokenBalances[0]?.amountRaw, 9_007_199_254_740_994n);
  assert.equal(located.blockTimeMs, 1_725_000_000_000);
  assert.equal(located.confirmationStatus, 'CONFIRMED');
  assert.equal(located.error, transactionError);
});

void test('maps normalization failures without leaking their messages', async () => {
  const invalid = response('pump');
  invalid.transaction.signatures.length = 0;
  await assert.rejects(
    new TransactionLocator(rpc(invalid, ['pump'])).locate(target('pump')),
    (error: unknown) => {
      assert.ok(error instanceof TransactionNormalizationError);
      assert.equal(error.code, 'NORMALIZATION_FAILED');
      assert.equal(error.retryable, false);
      assert.doesNotMatch(String(error), /sans signature/u);
      return true;
    },
  );
});

void test('compares observed slots as bigint at the maximum safe RPC precision', async () => {
  const slot = BigInt(Number.MAX_SAFE_INTEGER);
  const located = await new TransactionLocator(rpc(
    response('pump', Number.MAX_SAFE_INTEGER),
    ['other', 'pump'],
  )).locate(target('pump', slot));

  assert.equal(located.slot, 9_007_199_254_740_991n);
  assert.equal(located.transactionIndex, 1);
});
