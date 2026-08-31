import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AccountLayout,
  AccountState,
  AccountType,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getTypeLen,
  MintLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { pack as packTokenMetadata } from '@solana/spl-token-metadata';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  buildPumpSwapPlan,
  PumpSwapBuildPolicyError,
  type PumpSwapBuildRequestV1,
} from '../src/executor-simulation/pumpswap-adapter.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import {
  GLOBAL_CONFIG_PDA,
  OFFLINE_PUMP_AMM_PROGRAM,
  lpMintPda,
  poolPda,
  pumpAmmJson,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_SDK,
  PUMP_FEE_PROGRAM_ID,
  pumpPoolAuthorityPda,
  userVolumeAccumulatorPda,
  poolV2Pda,
} from '../src/markets/pumpswap/official-sdk.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const U64_MAX = (1n << 64n) - 1n;
const BASE_MINT = key(1);
const USER = key(2);
const QUOTE_MINT = NATIVE_MINT.toBase58();
const CREATOR = pumpPoolAuthorityPda(new PublicKey(BASE_MINT)).toBase58();
const POOL = poolPda(
  0,
  new PublicKey(CREATOR),
  new PublicKey(BASE_MINT),
  NATIVE_MINT,
).toBase58();
const BASE_VAULT = getAssociatedTokenAddressSync(
  new PublicKey(BASE_MINT),
  new PublicKey(POOL),
  true,
  TOKEN_PROGRAM_ID,
).toBase58();
const QUOTE_VAULT = getAssociatedTokenAddressSync(
  NATIVE_MINT,
  new PublicKey(POOL),
  true,
  TOKEN_PROGRAM_ID,
).toBase58();
const LP_MINT = lpMintPda(new PublicKey(POOL)).toBase58();
const RAW_GLOBAL_CONFIG = await officialAccountData('globalConfig', {
  admin: new PublicKey(key(30)),
  lpFeeBasisPoints: new BN(20),
  protocolFeeBasisPoints: new BN(5),
  disableFlags: 0,
  protocolFeeRecipients: frozenKeys(40, 8).map((value) => new PublicKey(value)),
  coinCreatorFeeBasisPoints: new BN(5),
  adminSetCoinCreatorAuthority: new PublicKey(key(50)),
  whitelistPda: new PublicKey(key(51)),
  reservedFeeRecipient: new PublicKey(key(52)),
  mayhemModeEnabled: true,
  reservedFeeRecipients: frozenKeys(53, 7).map((value) => new PublicKey(value)),
  isCashbackEnabled: false,
  buybackFeeRecipients: frozenKeys(60, 8).map((value) => new PublicKey(value)),
  buybackBasisPoints: new BN(1),
  boostAuthority: new PublicKey(key(70)),
  boostEnabled: false,
});
const RAW_FEE_CONFIG = await officialAccountData('feeConfig', {
  bump: 0,
  admin: new PublicKey(key(20)),
  flatFees: { lpFeeBps: new BN(20), protocolFeeBps: new BN(5), creatorFeeBps: new BN(5) },
  feeTiers: [{
    marketCapLamportsThreshold: new BN(0),
    fees: { lpFeeBps: new BN(20), protocolFeeBps: new BN(5), creatorFeeBps: new BN(5) },
  }],
  stableFeeTiers: [],
});
const RAW_POOL = Buffer.concat([
  await officialAccountData('pool', {
    poolBump: canonicalPoolBump(),
    index: 0,
    creator: new PublicKey(CREATOR),
    baseMint: new PublicKey(BASE_MINT),
    quoteMint: NATIVE_MINT,
    lpMint: new PublicKey(LP_MINT),
    poolBaseTokenAccount: new PublicKey(BASE_VAULT),
    poolQuoteTokenAccount: new PublicKey(QUOTE_VAULT),
    lpSupply: new BN(1_000_000),
    coinCreator: PublicKey.default,
    isMayhemMode: false,
    isCashbackCoin: false,
    virtualQuoteReserves: new BN(10_000),
  }),
  Buffer.alloc(39),
]);

void test('builds an exact official PumpSwap SELL plan and records actual SDK selections', async () => {
  const input = request({
    quote: Object.freeze({
      ...quote(),
      amountInRaw: U64_MAX,
      expectedAmountOutRaw: 9_007_199_254_740_995n,
      protectedAmountOutRaw: 9_007_199_254_740_993n,
    }),
  });
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const plan = await buildPumpSwapPlan(input);
    assert.equal(plan.venue, 'PUMP_SWAP');
    assert.equal(plan.side, 'SELL');
    assert.equal(plan.feePayer, USER);
    assert.deepEqual(plan.identity, {
      mint: BASE_MINT,
      quoteMint: QUOTE_MINT,
      baseTokenProgram: 'SPL_TOKEN',
      quoteTokenProgram: 'SPL_TOKEN',
      quoteDecimals: 9,
      snapshotSlot: 123n,
      quoteFingerprint: 'a'.repeat(64),
    });
    assert.deepEqual(plan.amounts, {
      amountInRaw: U64_MAX,
      expectedAmountOutRaw: 9_007_199_254_740_995n,
      protectedAmountOutRaw: 9_007_199_254_740_993n,
    });
    assert.equal(plan.instructions.length, 2);
    const sell = plan.instructions[0];
    const close = plan.instructions[1];
    assert.ok(sell);
    assert.ok(close);
    assert.equal(sell.programId, PUMPSWAP_PROGRAM_ID);
    assert.equal(sell.accounts.length, 23);
    const discriminator = officialDiscriminator('sell');
    const data = Buffer.from(sell.dataBase64, 'base64');
    assert.deepEqual(data.subarray(0, 8), discriminator);
    assert.equal(data.readBigUInt64LE(8), U64_MAX);
    assert.equal(data.readBigUInt64LE(16), 9_007_199_254_740_993n);
    assert.equal(sell.accounts[0]?.address, POOL);
    assert.equal(sell.accounts[1]?.address, USER);
    assert.equal(sell.accounts[3]?.address, BASE_MINT);
    assert.equal(sell.accounts[4]?.address, QUOTE_MINT);
    assert.equal(sell.accounts[5]?.address, userAta(BASE_MINT, TOKEN_PROGRAM_ID));
    assert.equal(sell.accounts[6]?.address, userAta(QUOTE_MINT, TOKEN_PROGRAM_ID));
    assert.equal(sell.accounts[7]?.address, BASE_VAULT);
    assert.equal(sell.accounts[8]?.address, QUOTE_VAULT);
    assert.equal(sell.accounts[9]?.address, key(40));
    assert.equal(sell.accounts[21]?.address, key(60));
    assert.equal(sell.accounts[22]?.address, getAssociatedTokenAddressSync(
      NATIVE_MINT,
      new PublicKey(key(60)),
      true,
      TOKEN_PROGRAM_ID,
    ).toBase58());
    assert.deepEqual(plan.recipientSelections, [
      {
        role: 'FEE',
        selectionMethod: 'SDK_RANDOM',
        listKind: 'NORMAL',
        candidates: frozenKeys(40, 8),
        selectedIndex: 0,
        selectedAddress: key(40),
      },
      {
        role: 'BUYBACK_FEE',
        selectionMethod: 'SDK_RANDOM',
        listKind: 'BUYBACK',
        candidates: frozenKeys(60, 8),
        selectedIndex: 0,
        selectedAddress: key(60),
      },
    ]);
    assert.equal(close.programId, TOKEN_PROGRAM_ID.toBase58());
    assert.equal(close.dataBase64, Buffer.from([9]).toString('base64'));
    assert.deepEqual(close.accounts.map(({ address }) => address), [
      userAta(QUOTE_MINT, TOKEN_PROGRAM_ID), USER, USER,
    ]);
    assert.deepEqual(plan.expectedAccounts, [
      { role: 'POOL', address: POOL },
      { role: 'POOL_BASE_VAULT', address: BASE_VAULT },
      { role: 'POOL_QUOTE_VAULT', address: QUOTE_VAULT },
      { role: 'USER_BASE_ATA', address: userAta(BASE_MINT, TOKEN_PROGRAM_ID) },
      { role: 'USER_QUOTE_ATA', address: userAta(QUOTE_MINT, TOKEN_PROGRAM_ID) },
    ]);
    assertPlainDeepFrozen(plan);
  } finally {
    Math.random = originalRandom;
  }
});

void test('derives PumpSwap recipients, flags, and pool identities solely from exact raw accounts', async () => {
  const valid = request();
  const raw = await rawStateRequest(valid);
  const rawGlobal = PUMP_AMM_SDK.decodeGlobalConfig(testAccountInfo(
    PUMPSWAP_PROGRAM_ID, Buffer.from(raw.snapshot.globalConfig.dataBase64, 'base64'),
  ));
  const rawFee = PUMP_AMM_SDK.decodeFeeConfig(testAccountInfo(
    PUMP_FEE_PROGRAM_ID.toBase58(), Buffer.from(raw.snapshot.feeConfig.dataBase64, 'base64'),
  ));
  const rawPool = PUMP_AMM_SDK.decodePool(testAccountInfo(
    PUMPSWAP_PROGRAM_ID, Buffer.from(raw.snapshot.pool.dataBase64, 'base64'),
  ));
  assert.equal(rawGlobal.protocolFeeRecipients[0]?.toBase58(), key(40));
  assert.equal(rawFee.feeTiers.length, 1);
  assert.equal(rawPool.baseMint.toBase58(), BASE_MINT);
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const plan = await buildPumpSwapPlan(raw);
    assert.equal(plan.instructions[0]?.accounts[0]?.address, POOL);
    assert.equal(plan.instructions[0]?.accounts[9]?.address, key(40));
    assert.equal(plan.instructions[0]?.accounts[21]?.address, key(60));
  } finally {
    Math.random = originalRandom;
  }
  for (const key of ['globalConfig', 'feeConfig', 'pool'] as const) {
    await rejectsPolicy(deepFreeze({
      ...raw,
      snapshot: {
        ...raw.snapshot,
        [key]: { ...raw.snapshot[key], decoded: Object.freeze({ fabricated: true }) },
      },
    }));
  }
});

void test('accepts the exact SDK branch for mayhem, cashback, coin creator, extension, missing WSOL ATA and Token-2022', async () => {
  const normal = request();
  const baseProgram = TOKEN_2022_PROGRAM_ID;
  const baseVault = getAssociatedTokenAddressSync(
    new PublicKey(BASE_MINT), new PublicKey(POOL), true, baseProgram,
  ).toBase58();
  const userVolume = userVolumeAccumulatorPda(new PublicKey(USER));
  const coinCreator = key(80);
  const input = deepFreeze({
    ...normal,
    quote: { ...normal.quote, baseTokenProgram: 'TOKEN_2022' },
    poolProof: {
      ...normal.poolProof,
      baseTokenProgram: 'TOKEN_2022',
      baseVault,
    },
    snapshot: {
      ...normal.snapshot,
      pool: await rawPoolSnapshot({
        poolBaseTokenAccount: new PublicKey(baseVault), coinCreator: new PublicKey(coinCreator),
        isMayhemMode: true, isCashbackCoin: true,
      }, 299),
      baseMint: mintSnapshot(
        BASE_MINT,
        baseProgram,
        6,
        1_000_000_000n,
        (mintData) => token2022MintExtensionData(
          mintData,
          ExtensionType.MintCloseAuthority,
          Buffer.alloc(getTypeLen(ExtensionType.MintCloseAuthority)),
        ),
      ),
      baseVault: tokenAccount(baseVault, baseProgram, BASE_MINT, POOL, 500_000n),
      userBaseTokenAccount: tokenAccount(
        userAta(BASE_MINT, baseProgram), baseProgram, BASE_MINT, USER, 10n,
      ),
      userQuoteTokenAccount: optionalAccount(userAta(QUOTE_MINT, TOKEN_PROGRAM_ID), false),
      userVolumeAccumulator: userVolumeAccount(userVolume.toBase58(), USER),
      userVolumeQuoteTokenAccount: tokenAccount(
        getAssociatedTokenAddressSync(NATIVE_MINT, userVolume, true, TOKEN_PROGRAM_ID).toBase58(),
        TOKEN_PROGRAM_ID,
        QUOTE_MINT,
        userVolume.toBase58(),
        1n,
      ),
      poolV2: optionalAccount(poolV2Pda(new PublicKey(BASE_MINT)).toBase58(), true),
    },
  }) as PumpSwapBuildRequestV1;
  const originalRandom = Math.random;
  Math.random = () => 0.999_999_999;
  try {
    const plan = await buildPumpSwapPlan(input);
    assert.equal(plan.instructions.length, 4);
    const [extend, createQuoteAta, sell, close] = plan.instructions;
    assert.equal(extend?.programId, PUMPSWAP_PROGRAM_ID);
    assert.deepEqual(
      Buffer.from(extend?.dataBase64 ?? '', 'base64'),
      officialDiscriminator('extend_account'),
    );
    assert.equal(createQuoteAta?.programId, ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    assert.equal(createQuoteAta?.dataBase64, Buffer.from([1]).toString('base64'));
    assert.equal(sell?.accounts.length, 26);
    assert.equal(sell?.accounts[9]?.address, key(59));
    assert.equal(sell?.accounts[11]?.address, TOKEN_2022_PROGRAM_ID.toBase58());
    assert.equal(sell?.accounts[21]?.address, input.snapshot.userVolumeQuoteTokenAccount.address);
    assert.equal(sell?.accounts[22]?.address, input.snapshot.userVolumeAccumulator.address);
    assert.equal(sell?.accounts[23]?.address, input.snapshot.poolV2.address);
    assert.equal(sell?.accounts[24]?.address, key(67));
    assert.deepEqual(plan.recipientSelections.map((selection) => ({
      selectionMethod: 'selectionMethod' in selection ? selection.selectionMethod : null,
      listKind: selection.listKind,
      selectedIndex: selection.selectedIndex,
    })), [
      { selectionMethod: 'SDK_RANDOM', listKind: 'RESERVED', selectedIndex: 7 },
      { selectionMethod: 'SDK_RANDOM', listKind: 'BUYBACK', selectedIndex: 7 },
    ]);
    assert.equal(close?.programId, TOKEN_PROGRAM_ID.toBase58());
    assertPlainDeepFrozen(plan);
  } finally {
    Math.random = originalRandom;
  }
});

void test('rejects forbidden, unknown, malformed and contradictory raw mint snapshots', async () => {
  const token2022Mint = (
    type: number,
    extensionData: Buffer,
  ): PumpSwapBuildRequestV1['snapshot']['baseMint'] => mintSnapshot(
    BASE_MINT,
    TOKEN_2022_PROGRAM_ID,
    6,
    1_000_000_000n,
    (mintData) => token2022MintExtensionData(mintData, type, extensionData),
  );
  const malformedToken2022Mint = mintSnapshot(
    BASE_MINT,
    TOKEN_2022_PROGRAM_ID,
    6,
    1_000_000_000n,
    (mintData) => {
      const data = Buffer.alloc(AccountLayout.span + 1 + 3);
      mintData.copy(data);
      data[AccountLayout.span] = AccountType.Mint;
      data.writeUInt16LE(ExtensionType.MintCloseAuthority, AccountLayout.span + 1);
      data[AccountLayout.span + 3] = 32;
      return data;
    },
  );
  const noncanonicalToken2022Padding = mintSnapshot(
    BASE_MINT,
    TOKEN_2022_PROGRAM_ID,
    6,
    1_000_000_000n,
    (mintData) => {
      const data = token2022MintExtensionData(
        mintData,
        ExtensionType.MintCloseAuthority,
        Buffer.alloc(getTypeLen(ExtensionType.MintCloseAuthority)),
      );
      data[MintLayout.span] = 1;
      return data;
    },
  );
  const valid = request();
  const decodedMismatch = deepFreeze({
    ...valid,
    snapshot: {
      ...valid.snapshot,
      baseMint: {
        ...valid.snapshot.baseMint,
        decoded: { ...valid.snapshot.baseMint.decoded, supplyRaw: 1_000_000_001n },
      },
    },
  });
  const noncanonicalSpl = deepFreeze({
    ...valid,
    snapshot: {
      ...valid.snapshot,
      baseMint: {
        ...valid.snapshot.baseMint,
        dataBase64: Buffer.concat([
          Buffer.from(valid.snapshot.baseMint.dataBase64, 'base64'),
          Buffer.from([0]),
        ]).toString('base64'),
      },
    },
  });
  const canonicalMetadata = Buffer.from(packTokenMetadata({
    mint: new PublicKey(BASE_MINT), name: 'token', symbol: 'TKN', uri: 'https://example.test/token',
    additionalMetadata: [],
  }));
  const metadataMint = (payload: Buffer) => mintSnapshot(
    BASE_MINT, TOKEN_2022_PROGRAM_ID, 6, 1_000_000_000n,
    (mintData) => token2022MintExtensionData(mintData, ExtensionType.TokenMetadata, payload),
  );
  const validMetadataRequest = await token2022Request(metadataMint(canonicalMetadata));
  const validMetadataPlan = await buildPumpSwapPlan(validMetadataRequest);
  assert.equal(validMetadataPlan.venue, 'PUMP_SWAP');
  const forbiddenToken2022Mints = await Promise.all([
    ExtensionType.TransferFeeConfig,
    ExtensionType.TransferHook,
    ExtensionType.ConfidentialTransferMint,
    ExtensionType.NonTransferable,
    ExtensionType.DefaultAccountState,
    ExtensionType.PermanentDelegate,
  ].map((extensionType) => token2022Request(token2022Mint(
    extensionType,
    Buffer.alloc(getTypeLen(extensionType)),
  ))));
  for (const input of [
    ...forbiddenToken2022Mints,
    await token2022Request(token2022Mint(999, Buffer.alloc(0))),
    await token2022Request(malformedToken2022Mint),
    await token2022Request(noncanonicalToken2022Padding),
    await token2022Request(metadataMint(Buffer.alloc(0))),
    await token2022Request(metadataMint(Buffer.from([1, 2, 3]))),
    await token2022Request(metadataMint(Buffer.concat([canonicalMetadata, Buffer.from([1])]))),
    await token2022Request(metadataMint(Buffer.concat([canonicalMetadata, Buffer.alloc(8)]))),
    decodedMismatch,
    noncanonicalSpl,
  ]) await rejectsPolicy(input);
});

void test('rejects a decoded pool bump that does not identify the canonical pool PDA', async () => {
  const valid = request();
  await rejectsPolicy(deepFreeze({
    ...valid,
    snapshot: {
      ...valid.snapshot,
      pool: await rawPoolSnapshot({ poolBump: 251 }),
    },
  }));
});

void test('rejects noncanonical durable proof, snapshot owners, identities and exact-slot drift', async () => {
  const valid = request();
  const cases: unknown[] = [
    deepFreeze({ ...valid, poolProof: { ...valid.poolProof, programId: key(90) } }),
    deepFreeze({ ...valid, poolProof: { ...valid.poolProof, poolAddress: key(91) } }),
    deepFreeze({ ...valid, poolProof: { ...valid.poolProof, migrationConfirmationStatus: 'confirmed' } }),
    deepFreeze({ ...valid, poolProof: { ...valid.poolProof, poolConfirmationStatus: 'orphaned' } }),
    deepFreeze({ ...valid, snapshot: { ...valid.snapshot, slot: 124n } }),
    deepFreeze({
      ...valid,
      snapshot: {
        ...valid.snapshot,
        pool: { ...valid.snapshot.pool, ownerProgramId: key(92) },
      },
    }),
    deepFreeze({
      ...valid,
      snapshot: {
        ...valid.snapshot,
        globalConfig: { ...valid.snapshot.globalConfig, address: key(93) },
      },
    }),
    deepFreeze({
      ...valid,
      snapshot: {
        ...valid.snapshot,
        feeConfig: { ...valid.snapshot.feeConfig, ownerProgramId: key(94) },
      },
    }),
    deepFreeze({
      ...valid,
      snapshot: {
        ...valid.snapshot,
        pool: await rawPoolSnapshot({ lpMint: new PublicKey(key(95)) }),
      },
    }),
  ];
  for (const input of cases) await rejectsPolicy(input);
});

void test('requires an initialized canonical funded base ATA and validates token account data', async () => {
  const valid = request();
  for (const userBaseTokenAccount of [
    optionalAccount(valid.snapshot.userBaseTokenAccount.address, false),
    tokenAccount(
      valid.snapshot.userBaseTokenAccount.address,
      TOKEN_PROGRAM_ID,
      BASE_MINT,
      USER,
      9n,
    ),
    tokenAccount(
      valid.snapshot.userBaseTokenAccount.address,
      TOKEN_PROGRAM_ID,
      key(96),
      USER,
      10n,
    ),
    tokenAccount(
      valid.snapshot.userBaseTokenAccount.address,
      TOKEN_PROGRAM_ID,
      BASE_MINT,
      key(97),
      10n,
    ),
  ]) {
    await rejectsPolicy(deepFreeze({
      ...valid,
      snapshot: { ...valid.snapshot, userBaseTokenAccount },
    }));
  }
});

void test('rejects non-native Token Program state for a WSOL account', async () => {
  const valid = request();
  const nonNativeWsol = tokenAccount(
    valid.snapshot.quoteVault.address,
    TOKEN_PROGRAM_ID,
    QUOTE_MINT,
    POOL,
    900_000n,
    false,
  );
  await rejectsPolicy(deepFreeze({
    ...valid,
    snapshot: { ...valid.snapshot, quoteVault: nonNativeWsol },
  }));
});

void test('rejects caller-fabricated decoded recipient lists', async () => {
  const valid = request();
  for (const decoded of [
    Object.freeze({ protocolFeeRecipients: frozenKeys(40, 7) }),
    Object.freeze({ protocolFeeRecipients: frozenKeys(40, 9) }),
    Object.freeze({ protocolFeeRecipients: Object.freeze(Array.from({ length: 8 }, () => key(40))) }),
  ]) {
    await rejectsPolicy(deepFreeze({
      ...valid,
      snapshot: {
        ...valid.snapshot,
        globalConfig: { ...valid.snapshot.globalConfig, decoded },
      },
    }));
  }
});

void test('rejects missing conditional cashback and pool-v2 snapshot data', async () => {
  const valid = request();
  await rejectsPolicy(deepFreeze({
    ...valid,
    snapshot: {
      ...valid.snapshot,
      pool: await rawPoolSnapshot({ isCashbackCoin: true }),
    },
  }));
  await rejectsPolicy(deepFreeze({
    ...valid,
    snapshot: {
      ...valid.snapshot,
      pool: await rawPoolSnapshot({ coinCreator: new PublicKey(key(98)) }),
    },
  }));
});

void test('rejects malformed cashback accumulator data from the exact-slot snapshot', async () => {
  const valid = request();
  const userVolume = userVolumeAccumulatorPda(new PublicKey(USER));
  await rejectsPolicy(deepFreeze({
    ...valid,
    snapshot: {
      ...valid.snapshot,
      pool: await rawPoolSnapshot({ isCashbackCoin: true }),
      userVolumeAccumulator: optionalAccount(userVolume.toBase58(), true),
      userVolumeQuoteTokenAccount: tokenAccount(
        getAssociatedTokenAddressSync(NATIVE_MINT, userVolume, true, TOKEN_PROGRAM_ID).toBase58(),
        TOKEN_PROGRAM_ID,
        QUOTE_MINT,
        userVolume.toBase58(),
        1n,
      ),
    },
  }));
});

void test('bounds hostile frozen inputs before traps or expensive decoding and sanitizes every error', async () => {
  const valid = request();
  let touched = false;
  const proxy = new Proxy(valid, {
    ownKeys: () => {
      touched = true;
      throw new Error('credential trap');
    },
  });
  await rejectsPolicy(proxy);
  assert.equal(touched, false);

  await rejectsPolicy(deepFreeze({
    ...valid,
    snapshot: {
      ...valid.snapshot,
      globalConfig: { ...valid.snapshot.globalConfig, dataBase64: 'A'.repeat(100_000) },
    },
  }));

  await rejectsPolicy(deepFreeze({
    ...valid,
    snapshot: {
      ...valid.snapshot,
      baseVault: {
        ...valid.snapshot.baseVault,
        dataBase64: 'A'.repeat(100_000),
      },
    },
  }));
  await rejectsPolicy(deepFreeze({ ...valid, user: '1'.repeat(1_000_000) }));
});

void test('rejects invalid V1 side, quote policy, amounts and SDK RNG outside recipient lists', async () => {
  const valid = request();
  for (const quoteOverride of [
    { side: 'BUY' },
    { venue: 'PUMP_FUN' },
    { quoteMint: key(99) },
    { quoteTokenProgram: 'TOKEN_2022' },
    { quoteDecimals: 6 },
    { amountInRaw: 0n },
    { amountInRaw: U64_MAX + 1n },
    { protectedAmountOutRaw: valid.quote.expectedAmountOutRaw + 1n },
  ]) {
    await rejectsPolicy(deepFreeze({
      ...valid,
      quote: { ...valid.quote, ...quoteOverride },
    }));
  }
  const originalRandom = Math.random;
  Math.random = () => 1;
  try {
    await rejectsPolicy(valid);
  } finally {
    Math.random = originalRandom;
  }
});

void test('rejects a snapshot whose official global config disables selling', async () => {
  const valid = request();
  await rejectsPolicy(deepFreeze({
    ...valid,
    snapshot: {
      ...valid.snapshot,
      globalConfig: await rawGlobalConfigSnapshot({ disableFlags: 1 << 4 }),
    },
  }));
});

void test('keeps the PumpSwap builder offline, unsigned and free of slippage-number helpers', async () => {
  const source = await readFile(
    new URL('../src/executor-simulation/pumpswap-adapter.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /\b(?:Connection|OnlinePumpAmmSdk|Keypair|Signer)\b/u);
  assert.doesNotMatch(source, /\b(?:sellBaseInput|sellQuoteInput|sendTransaction|signTransaction|simulateTransaction)\b/u);
  assert.equal((source.match(/PUMP_AMM_SDK\.sellInstructions\(/gu) ?? []).length, 1);
  assert.doesNotMatch(source, /Math\.random\s*=/u);
  assert.match(source, /new BN\(value\.toString\(10\), 10\)/u);
});

function request(
  overrides: Partial<PumpSwapBuildRequestV1> = {},
): PumpSwapBuildRequestV1 {
  const poolProof = Object.freeze({
    migrationId: 'migration-1',
    migrationInstruction: 'MIGRATE_V2' as const,
    migrationConfirmationStatus: 'finalized' as const,
    poolAddress: POOL,
    market: 'pumpswap' as const,
    programId: PUMPSWAP_PROGRAM_ID,
    poolIndex: 0 as const,
    creator: CREATOR,
    baseMint: BASE_MINT,
    quoteMint: QUOTE_MINT,
    quoteDecimals: 9,
    baseTokenProgram: 'SPL_TOKEN' as const,
    quoteTokenProgram: 'SPL_TOKEN' as const,
    baseVault: BASE_VAULT,
    quoteVault: QUOTE_VAULT,
    lpMint: LP_MINT,
    poolConfirmationStatus: 'finalized' as const,
    activatedSlot: 100n,
    transactionIndex: 0,
    instructionIndex: 1,
    innerInstructionIndex: null,
  });
  const globalConfig = rawAccount(
    GLOBAL_CONFIG_PDA.toBase58(),
    PUMPSWAP_PROGRAM_ID,
    RAW_GLOBAL_CONFIG,
  );
  const snapshot = Object.freeze({
    slot: 123n,
    globalConfig,
    feeConfig: rawAccount(
      PUMP_AMM_FEE_CONFIG_PDA.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58(), RAW_FEE_CONFIG,
    ),
    pool: rawAccount(POOL, PUMPSWAP_PROGRAM_ID, RAW_POOL),
    baseMint: mintSnapshot(BASE_MINT, TOKEN_PROGRAM_ID, 6, 1_000_000_000n),
    quoteMint: mintSnapshot(QUOTE_MINT, TOKEN_PROGRAM_ID, 9, 1_000_000_000n),
    baseVault: tokenAccount(BASE_VAULT, TOKEN_PROGRAM_ID, BASE_MINT, POOL, 500_000n),
    quoteVault: tokenAccount(QUOTE_VAULT, TOKEN_PROGRAM_ID, QUOTE_MINT, POOL, 900_000n),
    userBaseTokenAccount: tokenAccount(
      userAta(BASE_MINT, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID, BASE_MINT, USER, U64_MAX,
    ),
    userQuoteTokenAccount: tokenAccount(
      userAta(QUOTE_MINT, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID, QUOTE_MINT, USER, 1n,
    ),
    userVolumeAccumulator: optionalAccount(
      userVolumeAccumulatorPda(new PublicKey(USER)).toBase58(), false,
    ),
    userVolumeQuoteTokenAccount: optionalAccount(
      getAssociatedTokenAddressSync(
        NATIVE_MINT,
        userVolumeAccumulatorPda(new PublicKey(USER)),
        true,
        TOKEN_PROGRAM_ID,
      ).toBase58(),
      false,
    ),
    poolV2: optionalAccount(poolV2Pda(new PublicKey(BASE_MINT)).toBase58(), false),
  });
  return deepFreeze({
    quote: quote(),
    user: USER,
    poolProof,
    snapshot,
    ...overrides,
  }) as PumpSwapBuildRequestV1;
}

function quote() {
  return Object.freeze({
    payloadVersion: 1 as const,
    venue: 'PUMP_SWAP' as const,
    side: 'SELL' as const,
    mint: BASE_MINT,
    quoteMint: QUOTE_MINT,
    baseTokenProgram: 'SPL_TOKEN' as const,
    quoteTokenProgram: 'SPL_TOKEN' as const,
    quoteDecimals: 9 as const,
    amountInRaw: 10n,
    expectedAmountOutRaw: 9n,
    protectedAmountOutRaw: 8n,
    snapshotSlot: 123n,
    quoteFingerprint: 'a'.repeat(64),
  });
}

async function rawStateRequest(input: PumpSwapBuildRequestV1): Promise<PumpSwapBuildRequestV1> {
  return deepFreeze({
    ...input,
    snapshot: {
      ...input.snapshot,
      globalConfig: rawAccount(GLOBAL_CONFIG_PDA.toBase58(), PUMPSWAP_PROGRAM_ID, RAW_GLOBAL_CONFIG),
      feeConfig: rawAccount(PUMP_AMM_FEE_CONFIG_PDA.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58(), RAW_FEE_CONFIG),
      pool: rawAccount(POOL, PUMPSWAP_PROGRAM_ID, RAW_POOL),
    },
  }) as PumpSwapBuildRequestV1;
}

async function rawPoolSnapshot(
  overrides: Record<string, unknown>,
  dataLength = 300,
) {
  const canonical = await officialAccountData('pool', {
    poolBump: canonicalPoolBump(), index: 0, creator: new PublicKey(CREATOR),
    baseMint: new PublicKey(BASE_MINT), quoteMint: NATIVE_MINT, lpMint: new PublicKey(LP_MINT),
    poolBaseTokenAccount: new PublicKey(BASE_VAULT), poolQuoteTokenAccount: new PublicKey(QUOTE_VAULT),
    lpSupply: new BN(1_000_000), coinCreator: PublicKey.default, isMayhemMode: false,
    isCashbackCoin: false, virtualQuoteReserves: new BN(10_000), ...overrides,
  });
  const full = Buffer.concat([canonical, Buffer.alloc(300 - canonical.length)]);
  return rawAccount(POOL, PUMPSWAP_PROGRAM_ID, full.subarray(0, dataLength));
}

async function rawGlobalConfigSnapshot(overrides: Record<string, unknown>) {
  return rawAccount(GLOBAL_CONFIG_PDA.toBase58(), PUMPSWAP_PROGRAM_ID, await officialAccountData('globalConfig', {
    admin: new PublicKey(key(30)), lpFeeBasisPoints: new BN(20), protocolFeeBasisPoints: new BN(5),
    disableFlags: 0, protocolFeeRecipients: frozenKeys(40, 8).map((value) => new PublicKey(value)),
    coinCreatorFeeBasisPoints: new BN(5), adminSetCoinCreatorAuthority: new PublicKey(key(50)),
    whitelistPda: new PublicKey(key(51)), reservedFeeRecipient: new PublicKey(key(52)),
    mayhemModeEnabled: true, reservedFeeRecipients: frozenKeys(53, 7).map((value) => new PublicKey(value)),
    isCashbackEnabled: false, buybackFeeRecipients: frozenKeys(60, 8).map((value) => new PublicKey(value)),
    buybackBasisPoints: new BN(1), boostAuthority: new PublicKey(key(70)), boostEnabled: false, ...overrides,
  }));
}

function rawAccount(address: string, ownerProgramId: string, data: Buffer) {
  return Object.freeze({ address, ownerProgramId, dataBase64: data.toString('base64') });
}

function testAccountInfo(ownerProgramId: string, data: Buffer) {
  return { executable: false, owner: new PublicKey(ownerProgramId), lamports: 0, data, rentEpoch: 0 };
}

async function officialAccountData(
  name: 'globalConfig' | 'feeConfig' | 'pool',
  value: unknown,
): Promise<Buffer> {
  return Buffer.from(await OFFLINE_PUMP_AMM_PROGRAM.coder.accounts.encode(name, value));
}

function mintSnapshot(
  address: string,
  ownerProgramId: PublicKey,
  decimals: number,
  supplyRaw: bigint,
  transformRawData?: (canonicalMintData: Buffer) => Buffer,
) {
  const decoded = Object.freeze({
    mintAuthorityOption: 0 as const,
    mintAuthority: SYSTEM_PROGRAM,
    supplyRaw,
    decimals,
    isInitialized: true,
    freezeAuthorityOption: 0 as const,
    freezeAuthority: SYSTEM_PROGRAM,
  });
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: decoded.mintAuthorityOption,
    mintAuthority: new PublicKey(decoded.mintAuthority),
    supply: decoded.supplyRaw,
    decimals: decoded.decimals,
    isInitialized: decoded.isInitialized,
    freezeAuthorityOption: decoded.freezeAuthorityOption,
    freezeAuthority: new PublicKey(decoded.freezeAuthority),
  }, data);
  const rawData = transformRawData?.(data) ?? data;
  return Object.freeze({
    address,
    ownerProgramId: ownerProgramId.toBase58(),
    dataBase64: rawData.toString('base64'),
    decoded,
  });
}

function token2022MintExtensionData(
  mintData: Buffer,
  extensionType: number,
  extensionData: Buffer,
): Buffer {
  const data = Buffer.alloc(AccountLayout.span + 1 + 4 + extensionData.length);
  mintData.copy(data);
  data[AccountLayout.span] = AccountType.Mint;
  data.writeUInt16LE(extensionType, AccountLayout.span + 1);
  data.writeUInt16LE(extensionData.length, AccountLayout.span + 3);
  extensionData.copy(data, AccountLayout.span + 5);
  return data;
}

async function token2022Request(
  baseMint: PumpSwapBuildRequestV1['snapshot']['baseMint'],
): Promise<PumpSwapBuildRequestV1> {
  const normal = request();
  const baseVault = getAssociatedTokenAddressSync(
    new PublicKey(BASE_MINT), new PublicKey(POOL), true, TOKEN_2022_PROGRAM_ID,
  ).toBase58();
  return deepFreeze({
    ...normal,
    quote: { ...normal.quote, baseTokenProgram: 'TOKEN_2022' },
    poolProof: {
      ...normal.poolProof,
      baseTokenProgram: 'TOKEN_2022',
      baseVault,
    },
    snapshot: {
      ...normal.snapshot,
      pool: await rawPoolSnapshot({ poolBaseTokenAccount: new PublicKey(baseVault) }),
      baseMint,
      baseVault: tokenAccount(baseVault, TOKEN_2022_PROGRAM_ID, BASE_MINT, POOL, 500_000n),
      userBaseTokenAccount: tokenAccount(
        userAta(BASE_MINT, TOKEN_2022_PROGRAM_ID),
        TOKEN_2022_PROGRAM_ID,
        BASE_MINT,
        USER,
        U64_MAX,
      ),
    },
  }) as PumpSwapBuildRequestV1;
}

function tokenAccount(
  address: string,
  ownerProgramId: PublicKey,
  mint: string,
  owner: string,
  amountRaw: bigint,
  isNative: boolean = mint === QUOTE_MINT,
) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({
    mint: new PublicKey(mint),
    owner: new PublicKey(owner),
    amount: amountRaw,
    delegateOption: 0,
    delegate: PublicKey.default,
    state: AccountState.Initialized,
    isNativeOption: isNative ? 1 : 0,
    isNative: isNative ? 2_039_280n : 0n,
    delegatedAmount: 0n,
    closeAuthorityOption: 0,
    closeAuthority: PublicKey.default,
  }, data);
  return Object.freeze({
    address,
    exists: true as const,
    ownerProgramId: ownerProgramId.toBase58(),
    dataBase64: data.toString('base64'),
  });
}

function optionalAccount(address: string, exists: boolean) {
  return Object.freeze(exists
    ? { address, exists: true as const, ownerProgramId: PUMPSWAP_PROGRAM_ID, dataBase64: 'AQ==' }
    : { address, exists: false as const, ownerProgramId: null, dataBase64: null });
}

function userVolumeAccount(address: string, user: string) {
  const data = Buffer.alloc(90);
  officialAccountDiscriminator('UserVolumeAccumulator').copy(data, 0);
  new PublicKey(user).toBuffer().copy(data, 8);
  return Object.freeze({
    address,
    exists: true as const,
    ownerProgramId: PUMPSWAP_PROGRAM_ID,
    dataBase64: data.toString('base64'),
  });
}

function userAta(mint: string, programId: PublicKey): string {
  return getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(USER),
    true,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ).toBase58();
}

function officialDiscriminator(name: string): Buffer {
  const definition = pumpAmmJson.instructions.find((instruction) => instruction.name === name);
  assert.ok(definition);
  return Buffer.from(definition.discriminator);
}

function officialAccountDiscriminator(name: string): Buffer {
  const definition = pumpAmmJson.accounts.find((account) => account.name === name);
  assert.ok(definition);
  return Buffer.from(definition.discriminator);
}

function canonicalPoolBump(): number {
  return PublicKey.findProgramAddressSync([
    Buffer.from('pool'),
    Buffer.from([0, 0]),
    new PublicKey(CREATOR).toBuffer(),
    new PublicKey(BASE_MINT).toBuffer(),
    NATIVE_MINT.toBuffer(),
  ], new PublicKey(PUMPSWAP_PROGRAM_ID))[1];
}

async function rejectsPolicy(value: unknown): Promise<void> {
  await assert.rejects(
    buildPumpSwapPlan(value as PumpSwapBuildRequestV1),
    (error: unknown) => {
      assert.ok(error instanceof PumpSwapBuildPolicyError);
      assert.equal(error.code, 'BUILD_POLICY_REJECTED');
      assert.equal(error.message, 'PumpSwap build policy rejected.');
      return true;
    },
  );
}

function frozenKeys(start: number, count: number): readonly string[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => key(start + index)));
}

function key(seed: number): string {
  const bytes = new Uint8Array(32);
  bytes[0] = seed;
  bytes[31] = 255 - seed;
  return new PublicKey(bytes).toBase58();
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function assertPlainDeepFrozen(value: unknown): void {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.getPrototypeOf(value), Array.isArray(value)
    ? Array.prototype
    : Object.prototype);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (typeof nested === 'object' && nested !== null) assertPlainDeepFrozen(nested);
  }
}
