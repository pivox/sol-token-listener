import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import {
  bondingCurvePda,
  PUMP_PROGRAM_ID,
} from '../src/launchpads/pumpfun/official-sdk.js';
import {
  buildPumpFunPlan,
  PumpFunBuildPolicyError,
  type PumpFunBuildRequestV1,
} from '../src/executor-simulation/pumpfun-adapter.js';

const FEE_DOMAIN = 'execution-pumpfun-fee-recipient-v1';
const BUYBACK_DOMAIN = 'execution-pumpfun-buyback-recipient-v1';
const BUY_DISCRIMINATOR = 'b817ee6167c5d33d';
const SELL_DISCRIMINATOR = '5df6823ce7e940b2';
const U64_MAX = (1n << 64n) - 1n;

void test('builds an exact deterministic official Pump.fun BUY V2 plan above 2^53', async () => {
  const input = request({
    quote: Object.freeze({
      ...quote('BUY', '0'.repeat(64), 'SPL_TOKEN'),
      amountInRaw: 9_007_199_254_740_995n,
      expectedAmountOutRaw: 9_007_199_254_740_994n,
      protectedAmountOutRaw: 9_007_199_254_740_993n,
    }),
  });
  const random = Math.random;
  Math.random = (): never => { throw new Error('random selection is forbidden'); };
  try {
    const plan = await buildPumpFunPlan(input);
    const swap = plan.instructions[0];
    assert.ok(swap);
    assert.equal(plan.payloadVersion, 1);
    assert.equal(plan.venue, 'PUMP_FUN');
    assert.equal(plan.side, 'BUY');
    assert.equal(plan.feePayer, input.user);
    assert.deepEqual(plan.identity, Object.freeze({
      mint: input.quote.mint,
      quoteMint: NATIVE_MINT.toBase58(),
      baseTokenProgram: 'SPL_TOKEN',
      quoteTokenProgram: 'SPL_TOKEN',
      quoteDecimals: 9,
      snapshotSlot: input.quote.snapshotSlot,
      quoteFingerprint: input.quote.quoteFingerprint,
    }));
    assert.deepEqual(plan.amounts, Object.freeze({
      amountInRaw: input.quote.amountInRaw,
      expectedAmountOutRaw: input.quote.expectedAmountOutRaw,
      protectedAmountOutRaw: input.quote.protectedAmountOutRaw,
    }));
    assert.equal(plan.instructions.length, 1);
    assert.equal(swap.programId, PUMP_PROGRAM_ID.toBase58());
    assert.equal(swap.accounts.length, 27);
    const data = Buffer.from(swap.dataBase64, 'base64');
    assert.equal(data.toString('hex', 0, 8), BUY_DISCRIMINATOR);
    assert.equal(data.readBigUInt64LE(8), input.quote.protectedAmountOutRaw);
    assert.equal(data.readBigUInt64LE(16), input.quote.amountInRaw);
    assert.equal(swap.accounts[1]?.address, input.quote.mint);
    assert.equal(swap.accounts[2]?.address, input.quote.quoteMint);
    assert.equal(swap.accounts[3]?.address, TOKEN_PROGRAM_ID.toBase58());
    assert.equal(swap.accounts[4]?.address, TOKEN_PROGRAM_ID.toBase58());
    assert.equal(swap.accounts[13]?.address, input.user);
    assert.deepEqual(swap.accounts.map(({ isSigner }) => isSigner), [
      false, false, false, false, false, false, false, false, false,
      false, false, false, false, true, false, false, false, false,
      false, false, false, false, false, false, false, false, false,
    ]);
    assert.deepEqual(swap.accounts.map(({ isWritable }) => isWritable), [
      false, false, false, false, false, false, true, true, true, true,
      true, true, true, true, true, true, true, true, false, false,
      true, true, false, false, false, false, false,
    ]);

    const expectedFee = selected(FEE_DOMAIN, input.quote.quoteFingerprint, [
      input.recipients.feeRecipient, ...input.recipients.feeRecipients,
    ]);
    const expectedBuyback = selected(
      BUYBACK_DOMAIN,
      input.quote.quoteFingerprint,
      input.recipients.buybackFeeRecipients,
    );
    assert.deepEqual(plan.recipientSelections, Object.freeze([
      Object.freeze({
        role: 'FEE', domain: FEE_DOMAIN, listKind: 'NORMAL',
        candidates: Object.freeze([
          input.recipients.feeRecipient, ...input.recipients.feeRecipients,
        ]),
        selectionHash: expectedFee.hash,
        selectedIndex: expectedFee.index,
        selectedAddress: expectedFee.address,
      }),
      Object.freeze({
        role: 'BUYBACK_FEE', domain: BUYBACK_DOMAIN, listKind: 'BUYBACK',
        candidates: input.recipients.buybackFeeRecipients,
        selectionHash: expectedBuyback.hash,
        selectedIndex: expectedBuyback.index,
        selectedAddress: expectedBuyback.address,
      }),
    ]));
    assert.equal(swap.accounts[6]?.address, expectedFee.address);
    assert.equal(swap.accounts[8]?.address, expectedBuyback.address);
    assert.deepEqual(plan.expectedAccounts, Object.freeze([
      Object.freeze({ role: 'BONDING_CURVE', address: input.curve.address }),
      Object.freeze({ role: 'USER_BASE_ATA', address: input.userBaseTokenAccount.address }),
    ]));
    assertPlainDeepFrozen(plan);
  } finally {
    Math.random = random;
  }
});

void test('uses the reserved fee list in mayhem mode and remains stable across builds', async () => {
  const input = request({
    quote: quote('BUY', '1'.repeat(64), 'TOKEN_2022'),
    curve: Object.freeze({ ...curve('TOKEN_2022'), isMayhemMode: true }),
    userBaseTokenAccount: userAta('TOKEN_2022', true),
  });
  const first = await buildPumpFunPlan(input);
  const second = await buildPumpFunPlan(input);
  const expectedFee = selected(FEE_DOMAIN, input.quote.quoteFingerprint, [
    input.recipients.reservedFeeRecipient,
    ...input.recipients.reservedFeeRecipients,
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.recipientSelections[0]?.listKind, 'RESERVED');
  assert.equal(first.recipientSelections[0]?.selectedAddress, expectedFee.address);
  assert.equal(first.instructions.at(-1)?.accounts[3]?.address, TOKEN_2022_PROGRAM_ID.toBase58());
});

void test('prepends exactly one canonical idempotent base ATA creation for BUY only when absent', async () => {
  const input = request({ userBaseTokenAccount: userAta('SPL_TOKEN', false) });
  const plan = await buildPumpFunPlan(input);
  const setup = plan.instructions[0];
  const swap = plan.instructions[1];
  assert.ok(setup);
  assert.ok(swap);
  assert.equal(plan.instructions.length, 2);
  assert.equal(setup.programId, ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(setup.dataBase64, Buffer.from([1]).toString('base64'));
  assert.deepEqual(setup.accounts.map(({ address }) => address), [
    input.user,
    input.userBaseTokenAccount.address,
    input.user,
    input.quote.mint,
    '11111111111111111111111111111111',
    TOKEN_PROGRAM_ID.toBase58(),
  ]);
  assert.equal(swap.accounts.length, 27);
  assert.equal(swap.programId, PUMP_PROGRAM_ID.toBase58());
});

void test('builds exact official SELL V2 arguments and rejects a missing base ATA', async () => {
  const input = request({
    quote: Object.freeze({
      ...quote('SELL', '2'.repeat(64), 'TOKEN_2022'),
      amountInRaw: U64_MAX,
      expectedAmountOutRaw: 9_007_199_254_740_995n,
      protectedAmountOutRaw: 9_007_199_254_740_993n,
    }),
    curve: curve('TOKEN_2022'),
    userBaseTokenAccount: userAta('TOKEN_2022', true),
  });
  const plan = await buildPumpFunPlan(input);
  const swap = plan.instructions[0];
  assert.ok(swap);
  assert.equal(plan.instructions.length, 1);
  assert.equal(swap.accounts.length, 26);
  assert.equal(swap.accounts[3]?.address, TOKEN_2022_PROGRAM_ID.toBase58());
  const data = Buffer.from(swap.dataBase64, 'base64');
  assert.equal(data.toString('hex', 0, 8), SELL_DISCRIMINATOR);
  assert.equal(data.readBigUInt64LE(8), input.quote.amountInRaw);
  assert.equal(data.readBigUInt64LE(16), input.quote.protectedAmountOutRaw);

  await rejectsPolicy(request({
    quote: quote('SELL', '2'.repeat(64), 'TOKEN_2022'),
    curve: curve('TOKEN_2022'),
    userBaseTokenAccount: userAta('TOKEN_2022', false),
  }));
});

void test('requires the exact pinned Global recipient cardinalities', async () => {
  const valid = request();
  const cases = [
    Object.freeze({ ...valid.recipients, feeRecipients: frozenKeys(101, 6) }),
    Object.freeze({ ...valid.recipients, feeRecipients: frozenKeys(101, 8) }),
    Object.freeze({ ...valid.recipients, reservedFeeRecipients: frozenKeys(111, 6) }),
    Object.freeze({ ...valid.recipients, reservedFeeRecipients: frozenKeys(111, 8) }),
    Object.freeze({ ...valid.recipients, buybackFeeRecipients: frozenKeys(120, 7) }),
    Object.freeze({ ...valid.recipients, buybackFeeRecipients: frozenKeys(120, 9) }),
  ];
  for (const recipients of cases) {
    await rejectsPolicy(Object.freeze({ ...valid, recipients }));
  }
});

void test('bounds hostile recipient arrays and public-key text before expensive work', async () => {
  const valid = request();
  const oversizedArray = new Array<string>(1_000_000);
  Object.freeze(oversizedArray);
  const originalOwnKeys = Reflect.ownKeys;
  let oversizedOwnKeysCalls = 0;
  Reflect.ownKeys = (target: object): (string | symbol)[] => {
    if (target === oversizedArray) oversizedOwnKeysCalls += 1;
    return originalOwnKeys(target);
  };
  try {
    await rejectsPolicy(Object.freeze({
      ...valid,
      recipients: Object.freeze({
        ...valid.recipients,
        feeRecipients: oversizedArray,
      }),
    }));
  } finally {
    Reflect.ownKeys = originalOwnKeys;
  }
  assert.equal(oversizedOwnKeysCalls, 0);

  const originalToBase58 = PublicKey.prototype.toBase58;
  let shortKeyNormalizations = 0;
  PublicKey.prototype.toBase58 = function toBase58(): string {
    const normalized = originalToBase58.call(this);
    if (normalized === '11111111111111111111111111111111') {
      shortKeyNormalizations += 1;
    }
    return normalized;
  };
  try {
    await rejectsPolicy(Object.freeze({ ...valid, user: '1'.repeat(31) }));
  } finally {
    PublicKey.prototype.toBase58 = originalToBase58;
  }
  assert.equal(shortKeyNormalizations, 0);
  await rejectsPolicy(Object.freeze({ ...valid, user: '1'.repeat(1_000_000) }));
  await rejectsPolicy(Object.freeze({ ...valid, user: 123 }));
});

void test('rejects noncanonical and hostile frozen build evidence with one sanitized error', async () => {
  const valid = request();
  const wrongAta = Object.freeze({ ...valid.userBaseTokenAccount, address: key(240) });
  const duplicateRecipients = Object.freeze({
    ...valid.recipients,
    feeRecipients: Object.freeze([valid.recipients.feeRecipient]),
  });
  const arraySubclass = new RecipientArray(key(103));
  Object.freeze(arraySubclass);
  const cases: unknown[] = [
    { ...valid },
    Object.freeze({ ...valid, extra: true }),
    Object.freeze({ ...valid, quote: Object.freeze({ ...valid.quote, venue: 'PUMP_SWAP' }) }),
    Object.freeze({ ...valid, quote: Object.freeze({ ...valid.quote, quoteFingerprint: 'A'.repeat(64) }) }),
    Object.freeze({ ...valid, quote: Object.freeze({ ...valid.quote, quoteMint: key(230) }) }),
    Object.freeze({ ...valid, quote: Object.freeze({ ...valid.quote, quoteDecimals: 6 }) }),
    Object.freeze({ ...valid, quote: Object.freeze({ ...valid.quote, amountInRaw: 0n }) }),
    Object.freeze({ ...valid, quote: Object.freeze({ ...valid.quote, expectedAmountOutRaw: U64_MAX + 1n }) }),
    Object.freeze({ ...valid, quote: Object.freeze({ ...valid.quote, protectedAmountOutRaw: valid.quote.expectedAmountOutRaw + 1n }) }),
    Object.freeze({ ...valid, curve: Object.freeze({ ...valid.curve, exists: false }) }),
    Object.freeze({ ...valid, curve: Object.freeze({ ...valid.curve, complete: true }) }),
    Object.freeze({ ...valid, curve: Object.freeze({ ...valid.curve, address: key(231) }) }),
    Object.freeze({ ...valid, curve: Object.freeze({ ...valid.curve, ownerProgramId: key(232) }) }),
    Object.freeze({ ...valid, user: '11111111111111111111111111111111' }),
    Object.freeze({ ...valid, userBaseTokenAccount: wrongAta }),
    Object.freeze({ ...valid, recipients: duplicateRecipients }),
    Object.freeze({ ...valid, recipients: Object.freeze({
      ...valid.recipients, buybackFeeRecipients: Object.freeze([]),
    }) }),
    Object.freeze({ ...valid, recipients: Object.freeze({
      ...valid.recipients, reservedFeeRecipient: '11111111111111111111111111111111',
    }) }),
    Object.freeze({ ...valid, recipients: Object.freeze({
      ...valid.recipients, feeRecipients: Object.freeze([123]),
    }) }),
    Object.freeze({ ...valid, recipients: Object.freeze({
      ...valid.recipients, feeRecipients: arraySubclass,
    }) }),
    new Proxy(valid, {}),
  ];
  let getterCalls = 0;
  const accessor = Object.freeze(Object.defineProperty({ ...valid }, 'user', {
    enumerable: true,
    get(): string { getterCalls += 1; return valid.user; },
  }));
  cases.push(accessor);

  for (const candidate of cases) await rejectsPolicy(candidate);
  assert.equal(getterCalls, 0);
});

function request(
  overrides: Partial<PumpFunBuildRequestV1> = {},
): PumpFunBuildRequestV1 {
  return Object.freeze({
    quote: quote('BUY', '0'.repeat(64), 'SPL_TOKEN'),
    user: key(10),
    curve: curve('SPL_TOKEN'),
    userBaseTokenAccount: userAta('SPL_TOKEN', true),
    recipients: Object.freeze({
      feeRecipient: key(100),
      feeRecipients: frozenKeys(101, 7),
      reservedFeeRecipient: key(110),
      reservedFeeRecipients: frozenKeys(111, 7),
      buybackFeeRecipients: frozenKeys(120, 8),
    }),
    ...overrides,
  });
}

function quote(
  side: 'BUY' | 'SELL',
  quoteFingerprint: string,
  baseTokenProgram: 'SPL_TOKEN' | 'TOKEN_2022',
): PumpFunBuildRequestV1['quote'] {
  return Object.freeze({
    payloadVersion: 1,
    venue: 'PUMP_FUN',
    side,
    mint: key(20),
    quoteMint: NATIVE_MINT.toBase58(),
    baseTokenProgram,
    quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9,
    amountInRaw: 1_000_000n,
    expectedAmountOutRaw: 900_000n,
    protectedAmountOutRaw: 850_000n,
    snapshotSlot: 9_007_199_254_740_993n,
    quoteFingerprint,
  });
}

function curve(
  baseTokenProgram: 'SPL_TOKEN' | 'TOKEN_2022',
): PumpFunBuildRequestV1['curve'] {
  const mint = new PublicKey(key(20));
  void baseTokenProgram;
  return Object.freeze({
    mint: mint.toBase58(),
    address: bondingCurvePda(mint).toBase58(),
    ownerProgramId: PUMP_PROGRAM_ID.toBase58(),
    exists: true,
    complete: false,
    creator: key(30),
    isMayhemMode: false,
  });
}

function userAta(
  baseTokenProgram: 'SPL_TOKEN' | 'TOKEN_2022',
  exists: boolean,
): PumpFunBuildRequestV1['userBaseTokenAccount'] {
  const tokenProgram = baseTokenProgram === 'SPL_TOKEN'
    ? TOKEN_PROGRAM_ID
    : TOKEN_2022_PROGRAM_ID;
  return Object.freeze({
    address: getAssociatedTokenAddressSync(
      new PublicKey(key(20)),
      new PublicKey(key(10)),
      true,
      tokenProgram,
    ).toBase58(),
    exists,
  });
}

function selected(
  domain: string,
  fingerprint: string,
  candidates: readonly string[],
): { readonly hash: string; readonly index: number; readonly address: string } {
  const encoded = candidatesForHash([domain, fingerprint]);
  const hash = createHash('sha256').update(encoded).digest('hex');
  const index = Number(BigInt(`0x${hash}`) % BigInt(candidates.length));
  const address = candidates[index];
  assert.ok(address);
  return { hash, index, address };
}

function candidatesForHash(values: readonly string[]): Buffer {
  return Buffer.concat(values.flatMap((value) => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return [length, bytes];
  }));
}

async function rejectsPolicy(value: unknown): Promise<void> {
  await assert.rejects(
    buildPumpFunPlan(value as PumpFunBuildRequestV1),
    (error: unknown) => error instanceof PumpFunBuildPolicyError
      && error.code === 'BUILD_POLICY_REJECTED'
      && error.message === 'Pump.fun build policy rejected.',
  );
}

function key(seed: number): string {
  return new PublicKey(Uint8Array.from(
    { length: 32 },
    (_, index) => (seed + index) % 256,
  )).toBase58();
}

function frozenKeys(seed: number, length: number): readonly string[] {
  return Object.freeze(Array.from({ length }, (_, index) => key(seed + index)));
}

function assertPlainDeepFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  assert.equal(Object.isFrozen(value), true);
  assert.ok(Array.isArray(value)
    || Object.getPrototypeOf(value) === Object.prototype
    || Object.getPrototypeOf(value) === null);
  for (const child of Object.values(value)) assertPlainDeepFrozen(child);
}

class RecipientArray extends Array<string> {}
