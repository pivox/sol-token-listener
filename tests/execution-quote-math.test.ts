import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExtensionType,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  computePumpFunCausalQuote,
  pumpFunQuoteAccountAddresses,
  PumpFunCausalQuoteError,
} from '../src/launchpads/pumpfun/causal-quote.js';
import {
  bondingCurvePda,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_SDK,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '../src/launchpads/pumpfun/official-sdk.js';
import {
  DEFAULT_PUBLIC_KEY,
  PUMP_PROGRAM_ID,
  WSOL_MINT,
} from '../src/launchpads/pumpfun/constants.js';
import { computeEffectiveQuoteReservesRaw } from '../src/markets/pumpswap/pumpswap-quote.provider.js';
import { PumpFunPaperQuoteProvider } from '../src/paper/pumpfun-paper-quote.provider.js';
import type { MarketRpcReader, ReadonlyAccountSnapshot } from '../src/ports/market-rpc-reader.js';

const MINT = new PublicKey(new Uint8Array(32).fill(71));
const SLOT = 9_007_199_254_740_999n;
const NOW = 1_700_000_000_000;
const REQUEST = Object.freeze({
  mint: MINT.toBase58(),
  quoteAsset: Object.freeze({ mint: WSOL_MINT, decimals: 9, tokenProgram: 'SPL_TOKEN' as const }),
  side: 'BUY' as const,
  amountInRaw: 1_000_000n,
  slippageBps: 125n,
});

void test('extracted Pump.fun math preserves the paper quote and exposes one causal snapshot', async () => {
  const snapshots = fixture();
  const addresses = pumpFunQuoteAccountAddresses(MINT.toBase58());
  const computation = computePumpFunCausalQuote({
    request: REQUEST,
    addresses,
    accounts: snapshots,
    observedAtMs: NOW,
  });
  const paper = await new PumpFunPaperQuoteProvider(new Reader(snapshots), () => NOW).quote(REQUEST);

  assert.deepEqual(computation.quote, paper);
  assert.equal(computation.snapshotSlot, SLOT);
  assert.equal(computation.normalizedQuoteMint, WSOL_MINT);
  assert.equal(computation.baseTokenProgram, 'SPL_TOKEN');
  assert.deepEqual(computation.reserves, {
    virtualTokenReservesRaw: 1_000_000_000n,
    virtualQuoteReservesRaw: 100_000_000n,
    realTokenReservesRaw: 800_000_000n,
    realQuoteReservesRaw: 50_000_000n,
  });
  assert.equal(computation.isMayhemMode, true);
  assert.equal(computation.isCashbackCoin, true);
  assert.ok(computation.reverseSellQuote !== null);
  assert.equal(computation.reverseSellQuote?.amountInRaw, computation.quote.amountOutRaw);
  assert.ok((computation.reverseSellQuote?.amountOutRaw ?? 0n) > 0n);
  assert.equal(typeof computation.reverseSellQuote?.feesRaw, 'bigint');
});

void test('normalizes a legacy Pump.fun quote mint to WSOL and rejects mixed snapshot slots', () => {
  const snapshots = fixture({ legacyQuoteMint: true });
  const addresses = pumpFunQuoteAccountAddresses(MINT.toBase58());
  const computation = computePumpFunCausalQuote({
    request: REQUEST,
    addresses,
    accounts: snapshots,
    observedAtMs: NOW,
  });
  assert.equal(computation.normalizedQuoteMint, WSOL_MINT);
  assert.throws(
    () => computePumpFunCausalQuote({
      request: REQUEST,
      addresses,
      accounts: snapshots.map((account, index) => index === 3
        ? { ...account, slot: SLOT + 1n }
        : account),
      observedAtMs: NOW,
    }),
    /m.me slot/iu,
  );
});

void test('quotes the reverse SELL on post-BUY reserves, including newly added real liquidity', () => {
  const addresses = pumpFunQuoteAccountAddresses(MINT.toBase58());
  const snapshots = fixture();
  const buy = computePumpFunCausalQuote({
    request: REQUEST,
    addresses,
    accounts: snapshots,
    observedAtMs: NOW,
  });
  const sellOnInitialSnapshot = computePumpFunCausalQuote({
    request: {
      ...REQUEST,
      side: 'SELL',
      amountInRaw: buy.quote.amountOutRaw,
    },
    addresses,
    accounts: snapshots,
    observedAtMs: NOW,
  });
  assert.notEqual(
    buy.reverseSellQuote?.amountOutRaw,
    sellOnInitialSnapshot.quote.amountOutRaw,
  );

  const noInitialRealLiquidity = computePumpFunCausalQuote({
    request: REQUEST,
    addresses,
    accounts: fixture({ realQuoteReservesRaw: 0n }),
    observedAtMs: NOW,
  });
  assert.ok(noInitialRealLiquidity.reverseSellQuote !== null);
  assert.ok(noInitialRealLiquidity.reverseSellQuote.amountOutRaw > 0n);
});

void test('PumpSwap effective reserves are always real vault plus virtual reserves', () => {
  assert.equal(computeEffectiveQuoteReservesRaw(20_000_000n, 5_000_000n), 25_000_000n);
  assert.equal(computeEffectiveQuoteReservesRaw(20_000_000n, -5_000_000n), 15_000_000n);
  assert.throws(() => computeEffectiveQuoteReservesRaw(1n, -1n), /effective/iu);
});

void test('rejects a transfer-affecting Token-2022 extension from the causal snapshot', () => {
  const snapshots = fixture({ unsupportedTokenExtension: true });
  assert.throws(
    () => computePumpFunCausalQuote({
      request: REQUEST,
      addresses: pumpFunQuoteAccountAddresses(MINT.toBase58()),
      accounts: snapshots,
      observedAtMs: NOW,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PumpFunCausalQuoteError);
      assert.equal(error.code, 'UNSUPPORTED_TOKEN_EXTENSION');
      return true;
    },
  );
});

class Reader implements MarketRpcReader {
  public constructor(private readonly accounts: readonly ReadonlyAccountSnapshot[]) {}

  public async readAccountsAtSameSlot(): Promise<readonly ReadonlyAccountSnapshot[]> {
    return this.accounts;
  }
}

function fixture(options: {
  readonly legacyQuoteMint?: boolean;
  readonly unsupportedTokenExtension?: boolean;
  readonly realQuoteReservesRaw?: bigint;
} = {}): readonly [
  ReadonlyAccountSnapshot,
  ReadonlyAccountSnapshot,
  ReadonlyAccountSnapshot,
  ReadonlyAccountSnapshot,
] {
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
    mayhemModeEnabled: true,
    reservedFeeRecipients: repeated(7),
    isCashbackEnabled: true,
    buybackFeeRecipients: repeated(8),
    buybackBasisPoints: new BN(0),
    initialVirtualQuoteReserves: new BN('100000000'),
    whitelistedQuoteMints: [new PublicKey(WSOL_MINT)],
  };
  const feeConfig = {
    bump: 1,
    admin: zero,
    flatFees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(50) },
    feeTiers: [
      {
        marketCapLamportsThreshold: new BN(0),
        fees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(50) },
      },
      {
        marketCapLamportsThreshold: new BN('1000000000000000'),
        fees: { lpFeeBps: new BN(0), protocolFeeBps: new BN(50), creatorFeeBps: new BN(25) },
      },
    ],
    stableFeeTiers: [],
  } as FeeConfig & { readonly bump: number; readonly stableFeeTiers: readonly unknown[] };
  const curve: BondingCurve = {
    virtualTokenReserves: new BN('1000000000'),
    virtualQuoteReserves: new BN('100000000'),
    realTokenReserves: new BN('800000000'),
    realQuoteReserves: new BN((options.realQuoteReservesRaw ?? 50_000_000n).toString()),
    tokenTotalSupply: new BN('1000000000'),
    complete: false,
    creator: zero,
    isMayhemMode: true,
    isCashbackCoin: true,
    quoteMint: options.legacyQuoteMint ? new PublicKey(DEFAULT_PUBLIC_KEY) : new PublicKey(WSOL_MINT),
  };
  const mintData = Buffer.alloc(options.unsupportedTokenExtension ? 170 : MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: zero,
    supply: 1_000_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: zero,
  }, mintData);
  if (options.unsupportedTokenExtension) {
    mintData[165] = 1;
    mintData.writeUInt16LE(ExtensionType.TransferFeeConfig, 166);
    mintData.writeUInt16LE(0, 168);
  }
  return [
    snapshot(GLOBAL_PDA.toBase58(), PUMP_PROGRAM_ID, encodeAccount('global', global)),
    snapshot(PUMP_FEE_CONFIG_PDA.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58(), encodeAccount('feeConfig', feeConfig)),
    snapshot(bondingCurvePda(MINT).toBase58(), PUMP_PROGRAM_ID, encodeAccount('bondingCurve', curve)),
    snapshot(
      MINT.toBase58(),
      (options.unsupportedTokenExtension ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBase58(),
      mintData,
    ),
  ];
}

function snapshot(address: string, owner: string, data: Uint8Array): ReadonlyAccountSnapshot {
  return { address, owner, data, lamports: 1n, slot: SLOT };
}

interface AccountLayoutEntry {
  readonly discriminator: readonly number[];
  readonly layout: { encode(value: unknown, destination: Buffer): number };
}

function encodeAccount(name: string, value: unknown): Buffer {
  const sdk = PUMP_SDK as unknown as {
    readonly offlinePumpProgram: {
      readonly coder: {
        readonly accounts: { readonly accountLayouts: ReadonlyMap<string, AccountLayoutEntry> };
      };
    };
  };
  const entry = sdk.offlinePumpProgram.coder.accounts.accountLayouts.get(name);
  if (entry === undefined) throw new Error(`Unknown fixture account: ${name}.`);
  const destination = Buffer.alloc(4_096);
  const length = entry.layout.encode(value, destination);
  return Buffer.concat([Buffer.from(entry.discriminator), destination.subarray(0, length)]);
}
