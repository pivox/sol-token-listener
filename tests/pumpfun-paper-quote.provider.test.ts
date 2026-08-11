import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  bondingCurvePda,
  getBuySolAmountFromTokenAmount,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_SDK,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '../src/launchpads/pumpfun/official-sdk.js';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { PumpFunPaperQuoteProvider } from '../src/paper/pumpfun-paper-quote.provider.js';
import { PaperQuoteError } from '../src/ports/paper-quote-router.js';
import type {
  MarketRpcReader,
  ReadonlyAccountSnapshot,
} from '../src/ports/market-rpc-reader.js';
import { PUMP_PROGRAM_ID, WSOL_MINT } from '../src/launchpads/pumpfun/constants.js';

const MINT = new PublicKey(new Uint8Array(32).fill(7));
const CREATOR = new PublicKey(new Uint8Array(32).fill(9));
const SLOT = 123n;
const NOW = 1_700_000_000_000;
const U64_MAX = 18_446_744_073_709_551_615n;
const quoteAsset = Object.freeze({
  mint: WSOL_MINT,
  decimals: 9,
  tokenProgram: 'SPL_TOKEN' as const,
});

void test('quotes BUY and SELL with the official Pump.fun SDK at one slot', async () => {
  const fixture = await accounts();
  const rpc = new FakeReader(fixture.snapshots);
  const provider = new PumpFunPaperQuoteProvider(rpc, () => NOW);
  const buyAmount = 1_000_000n;
  const buy = await provider.quote({
    mint: MINT.toBase58(), quoteAsset, side: 'BUY', amountInRaw: buyAmount, slippageBps: 500n,
  });
  const expectedBuy = getBuyTokenAmountFromSolAmount({
    global: fixture.global,
    feeConfig: fixture.feeConfig,
    mintSupply: fixture.mintSupply,
    bondingCurve: fixture.curve,
    amount: new BN(buyAmount.toString()),
    quoteMint: new PublicKey(quoteAsset.mint),
  });
  const expectedBuyCost = getBuySolAmountFromTokenAmount({
    global: fixture.global,
    feeConfig: fixture.feeConfig,
    mintSupply: fixture.mintSupply,
    bondingCurve: fixture.curve,
    amount: expectedBuy,
    quoteMint: new PublicKey(quoteAsset.mint),
  });
  const grossBuy = expectedBuy
    .mul(fixture.curve.virtualQuoteReserves)
    .div(fixture.curve.virtualTokenReserves.sub(expectedBuy))
    .addn(1);
  assert.deepEqual({
    inputMint: buy.inputMint,
    outputMint: buy.outputMint,
    amountInRaw: buy.amountInRaw,
    amountOutRaw: buy.amountOutRaw,
    minimumAmountOutRaw: buy.minimumAmountOutRaw,
    feesRaw: buy.feesRaw,
    slippageBps: buy.slippageBps,
    observedAtMs: buy.observedAtMs,
    observedSlot: buy.observedSlot,
  }, {
    inputMint: WSOL_MINT,
    outputMint: MINT.toBase58(),
    amountInRaw: buyAmount,
    amountOutRaw: BigInt(expectedBuy.toString(10)),
    minimumAmountOutRaw: BigInt(expectedBuy.toString(10)) * 9_500n / 10_000n,
    feesRaw: BigInt(expectedBuyCost.sub(grossBuy).toString(10)),
    slippageBps: 500n,
    observedAtMs: NOW,
    observedSlot: SLOT,
  });

  const sellAmount = buy.amountOutRaw;
  const sell = await provider.quote({
    mint: MINT.toBase58(), quoteAsset, side: 'SELL', amountInRaw: sellAmount, slippageBps: 250n,
  });
  const expectedSell = getSellSolAmountFromTokenAmount({
    global: fixture.global,
    feeConfig: fixture.feeConfig,
    mintSupply: fixture.mintSupply,
    bondingCurve: fixture.curve,
    amount: new BN(sellAmount.toString()),
  });
  const grossSell = new BN(sellAmount.toString())
    .mul(fixture.curve.virtualQuoteReserves)
    .div(fixture.curve.virtualTokenReserves.add(new BN(sellAmount.toString())));
  assert.equal(sell.inputMint, MINT.toBase58());
  assert.equal(sell.outputMint, WSOL_MINT);
  assert.equal(sell.amountOutRaw, BigInt(expectedSell.toString(10)));
  assert.equal(sell.feesRaw, BigInt(grossSell.sub(expectedSell).toString(10)));
  assert.equal(sell.minimumAmountOutRaw, sell.amountOutRaw * 9_750n / 10_000n);
  assert.notEqual(sell.id, buy.id);
  assert.deepEqual(rpc.addresses, [
    GLOBAL_PDA.toBase58(), PUMP_FEE_CONFIG_PDA.toBase58(),
    bondingCurvePda(MINT).toBase58(), MINT.toBase58(),
  ]);
});

void test('accepts SPL Token and Token-2022 mints, detected from the account owner', async () => {
  for (const tokenProgram of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const fixture = await accounts({ mintOwner: tokenProgram });
    const quote = await new PumpFunPaperQuoteProvider(
      new FakeReader(fixture.snapshots),
      () => NOW,
    ).quote({ mint: MINT.toBase58(), quoteAsset, side: 'BUY', amountInRaw: 1_000_000n, slippageBps: 0n });
    assert.ok(quote.amountOutRaw > 0n);
  }
});

void test('fails closed on missing, inconsistent, complete, insolvent, or malformed state', async () => {
  const fixture = await accounts();
  const [globalAccount, feeConfigAccount, curveAccount, mintAccount] = fixture.snapshots;
  const cases: readonly (readonly [string, readonly (ReadonlyAccountSnapshot | null)[], 'QUOTE_STATE_UNAVAILABLE' | 'QUOTE_STATE_INCONSISTENT'])[] = [
    ['global missing', [null, feeConfigAccount, curveAccount, mintAccount], 'QUOTE_STATE_UNAVAILABLE'],
    ['fee config missing', [globalAccount, null, curveAccount, mintAccount], 'QUOTE_STATE_UNAVAILABLE'],
    ['wrong owner', [{ ...globalAccount, owner: TOKEN_PROGRAM_ID.toBase58() }, feeConfigAccount, curveAccount, mintAccount], 'QUOTE_STATE_INCONSISTENT'],
    ['mixed slot', [globalAccount, feeConfigAccount, { ...curveAccount, slot: SLOT + 1n }, mintAccount], 'QUOTE_STATE_INCONSISTENT'],
    ['bad discriminator', [globalAccount, feeConfigAccount, { ...curveAccount, data: corrupt(curveAccount.data) }, mintAccount], 'QUOTE_STATE_INCONSISTENT'],
  ];
  for (const [label, snapshots, code] of cases) {
    await assert.rejects(
      new PumpFunPaperQuoteProvider(new FakeReader(snapshots), () => NOW).quote({
        mint: MINT.toBase58(), quoteAsset, side: 'BUY', amountInRaw: 1_000_000n, slippageBps: 0n,
      }),
      (error: unknown) => assertPaperError(error, code, label),
    );
  }

  const complete = await accounts({ complete: true });
  await rejectsState(complete.snapshots, 'BUY', 1_000_000n);
  const insolvent = await accounts({ realQuoteReserves: 1n });
  await rejectsState(insolvent.snapshots, 'SELL', 10_000_000n);
  await rejectsState(fixture.snapshots, 'BUY', U64_MAX + 1n);
  await rejectsState(fixture.snapshots, 'BUY', 1n);
});

void test('rejects a foreign quote mint without leaking RPC data', async () => {
  const fixture = await accounts();
  const foreign = new PublicKey(new Uint8Array(32).fill(11)).toBase58();
  await assert.rejects(
    new PumpFunPaperQuoteProvider(new FakeReader(fixture.snapshots), () => NOW).quote({
      mint: MINT.toBase58(),
      quoteAsset: { ...quoteAsset, mint: foreign },
      side: 'BUY',
      amountInRaw: 1_000_000n,
      slippageBps: 0n,
    }),
    (error: unknown) => assertPaperError(error, 'UNSUPPORTED_QUOTE_MINT', 'foreign quote'),
  );
});

async function rejectsState(
  snapshots: readonly (ReadonlyAccountSnapshot | null)[],
  side: 'BUY' | 'SELL',
  amountInRaw: bigint,
): Promise<void> {
  await assert.rejects(
    new PumpFunPaperQuoteProvider(new FakeReader(snapshots), () => NOW).quote({
      mint: MINT.toBase58(), quoteAsset, side, amountInRaw, slippageBps: 0n,
    }),
    (error: unknown) => assertPaperError(error, 'QUOTE_STATE_INCONSISTENT', side),
  );
}

function assertPaperError(error: unknown, code: string, label: string): true {
  assert.ok(error instanceof PaperQuoteError, label);
  assert.equal(error.code, code, label);
  assert.doesNotMatch(error.message, /rpc\.example|payload|[0-9a-f]{80}/iu);
  return true;
}

class FakeReader implements MarketRpcReader {
  public addresses: readonly string[] = [];

  public constructor(private readonly snapshots: readonly (ReadonlyAccountSnapshot | null)[]) {}

  public async readAccountsAtSameSlot(addresses: readonly string[]): Promise<readonly (ReadonlyAccountSnapshot | null)[]> {
    this.addresses = addresses;
    return this.snapshots;
  }
}

async function accounts(options: {
  readonly mintOwner?: PublicKey;
  readonly complete?: boolean;
  readonly realQuoteReserves?: bigint;
} = {}): Promise<{
  readonly snapshots: readonly [
    ReadonlyAccountSnapshot,
    ReadonlyAccountSnapshot,
    ReadonlyAccountSnapshot,
    ReadonlyAccountSnapshot,
  ];
  readonly global: Global;
  readonly feeConfig: FeeConfig;
  readonly curve: BondingCurve;
  readonly mintSupply: BN;
}> {
  const zero = PublicKey.default;
  const repeated = (length: number): PublicKey[] => Array.from({ length }, () => zero);
  const global: Global = {
    initialized: true,
    authority: zero,
    feeRecipient: zero,
    initialVirtualTokenReserves: new BN('1000000000'),
    initialVirtualSolReserves: new BN('100000000'),
    initialRealTokenReserves: new BN('800000000'),
    tokenTotalSupply: new BN('1000000000'),
    feeBasisPoints: new BN(100),
    withdrawAuthority: zero,
    enableMigrate: true,
    poolMigrationFee: new BN(0),
    creatorFeeBasisPoints: new BN(50),
    feeRecipients: repeated(7),
    setCreatorAuthority: zero,
    adminSetCreatorAuthority: zero,
    createV2Enabled: true,
    whitelistPda: zero,
    reservedFeeRecipient: zero,
    mayhemModeEnabled: false,
    reservedFeeRecipients: repeated(7),
    isCashbackEnabled: false,
    buybackFeeRecipients: repeated(8),
    buybackBasisPoints: new BN(0),
    initialVirtualQuoteReserves: new BN('100000000'),
    whitelistedQuoteMints: [new PublicKey(WSOL_MINT)],
  };
  const feeConfig = {
    bump: 1,
    admin: zero,
    flatFees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(50) },
    feeTiers: [{
      marketCapLamportsThreshold: new BN(0),
      fees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(50) },
    }],
    stableFeeTiers: [],
  } as FeeConfig & { readonly bump: number; readonly stableFeeTiers: readonly unknown[] };
  const curve: BondingCurve = {
    virtualTokenReserves: new BN('1000000000'),
    virtualQuoteReserves: new BN('100000000'),
    realTokenReserves: new BN('800000000'),
    realQuoteReserves: new BN((options.realQuoteReserves ?? 50_000_000n).toString()),
    tokenTotalSupply: new BN('1000000000'),
    complete: options.complete ?? false,
    creator: CREATOR,
    isMayhemMode: false,
    isCashbackCoin: false,
    quoteMint: new PublicKey(WSOL_MINT),
  };
  const mintSupply = new BN('1000000000');
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: zero,
    supply: BigInt(mintSupply.toString(10)),
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: zero,
  }, mintData);
  return {
    global,
    feeConfig,
    curve,
    mintSupply,
    snapshots: [
      snapshot(GLOBAL_PDA.toBase58(), PUMP_PROGRAM_ID, encodeAccount('global', global)),
      snapshot(PUMP_FEE_CONFIG_PDA.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58(), encodeAccount('feeConfig', feeConfig)),
      snapshot(bondingCurvePda(MINT).toBase58(), PUMP_PROGRAM_ID, encodeAccount('bondingCurve', curve)),
      snapshot(MINT.toBase58(), (options.mintOwner ?? TOKEN_PROGRAM_ID).toBase58(), mintData),
    ],
  };
}

function snapshot(address: string, owner: string, data: Uint8Array): ReadonlyAccountSnapshot {
  return { address, owner, data, lamports: 1n, slot: SLOT };
}

function corrupt(input: Uint8Array): Uint8Array {
  const data = Uint8Array.from(input);
  data[0] = (data[0] ?? 0) ^ 0xff;
  return data;
}

interface AccountLayoutEntry {
  readonly discriminator: readonly number[];
  readonly layout: { encode(value: unknown, destination: Buffer): number };
}

function encodeAccount(name: string, value: unknown): Buffer {
  const sdk = PUMP_SDK as unknown as {
    readonly offlinePumpProgram: {
      readonly coder: {
        readonly accounts: {
          readonly accountLayouts: ReadonlyMap<string, AccountLayoutEntry>;
        };
      };
    };
  };
  const entry = sdk.offlinePumpProgram.coder.accounts.accountLayouts.get(name);
  if (entry === undefined) throw new Error(`Unknown official SDK account fixture: ${name}.`);
  const destination = Buffer.alloc(4_096);
  const length = entry.layout.encode(value, destination);
  return Buffer.concat([Buffer.from(entry.discriminator), destination.subarray(0, length)]);
}
