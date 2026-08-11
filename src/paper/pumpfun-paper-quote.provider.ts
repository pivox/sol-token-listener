import { createHash } from 'node:crypto';
import { MintLayout } from '@solana/spl-token';
import {
  bondingCurvePda,
  getBuySolAmountFromTokenAmount,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_SDK,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '../launchpads/pumpfun/official-sdk.js';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import type { PaperExecutionQuote } from '../domain/paper-trading.js';
import {
  DEFAULT_PUBLIC_KEY,
  PUMP_FEE_PROGRAM_ADDRESS,
  PUMP_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ADDRESS,
  WSOL_MINT,
} from '../launchpads/pumpfun/constants.js';
import type {
  MarketRpcReader,
  ReadonlyAccountSnapshot,
} from '../ports/market-rpc-reader.js';
import {
  PaperQuoteError,
  type PaperQuoteRequest,
  type PaperQuoteRouter,
} from '../ports/paper-quote-router.js';

const U64_MAX = 18_446_744_073_709_551_615n;
const BASIS_POINTS = 10_000n;

export class PumpFunPaperQuoteProvider implements PaperQuoteRouter {
  public constructor(
    private readonly rpc: MarketRpcReader,
    private readonly clock: () => number = Date.now,
  ) {}

  public async quote(request: PaperQuoteRequest): Promise<PaperExecutionQuote> {
    const addresses = accountAddresses(request.mint);
    let accounts: readonly (ReadonlyAccountSnapshot | null)[];
    try {
      accounts = await this.rpc.readAccountsAtSameSlot(addresses);
    } catch {
      throw new PaperQuoteError(
        'QUOTE_STATE_UNAVAILABLE',
        'Les comptes de cotation Pump.fun sont temporairement indisponibles.',
      );
    }
    try {
      return createQuote(request, addresses, accounts, this.clock());
    } catch (error) {
      if (error instanceof PaperQuoteError) throw error;
      throw new PaperQuoteError(
        'QUOTE_STATE_INCONSISTENT',
        'Les comptes de cotation Pump.fun ne peuvent pas être validés.',
      );
    }
  }
}

function createQuote(
  request: PaperQuoteRequest,
  addresses: readonly [string, string, string, string],
  accounts: readonly (ReadonlyAccountSnapshot | null)[],
  observedAtMs: number,
): PaperExecutionQuote {
  validateRequest(request, observedAtMs);
  const globalAccount = required(accounts[0], addresses[0]);
  const feeConfigAccount = required(accounts[1], addresses[1]);
  const curveAccount = required(accounts[2], addresses[2]);
  const mintAccount = required(accounts[3], addresses[3]);
  const present = [globalAccount, feeConfigAccount, curveAccount, mintAccount];
  if (present.some((account) => account.slot !== globalAccount.slot)) {
    inconsistent('Les comptes Pump.fun ne partagent pas le même slot.');
  }
  owner(globalAccount, PUMP_PROGRAM_ID);
  owner(feeConfigAccount, PUMP_FEE_PROGRAM_ADDRESS);
  owner(curveAccount, PUMP_PROGRAM_ID);
  tokenMintOwner(mintAccount);

  const global = decodeGlobal(globalAccount);
  const feeConfig = decodeFeeConfig(feeConfigAccount);
  const curve = decodeCurve(curveAccount);
  const mintSupply = decodeMintSupply(mintAccount);
  validateState(request, global, feeConfig, curve, mintSupply);

  const amount = new BN(request.amountInRaw.toString());
  const quoteMint = new PublicKey(request.quoteAsset.mint);
  const result = request.side === 'BUY'
    ? buy(global, feeConfig, curve, mintSupply, amount, quoteMint)
    : sell(global, feeConfig, curve, mintSupply, amount);
  if (result.amountOutRaw <= 0n) inconsistent('La cotation produit une sortie nulle.');
  const minimumAmountOutRaw = result.amountOutRaw
    * (BASIS_POINTS - request.slippageBps)
    / BASIS_POINTS;
  const inputMint = request.side === 'BUY' ? request.quoteAsset.mint : request.mint;
  const outputMint = request.side === 'BUY' ? request.mint : request.quoteAsset.mint;
  const identity = JSON.stringify([
    'PUMP_FUN_BONDING_CURVE',
    ...addresses,
    globalAccount.slot.toString(),
    inputMint,
    outputMint,
    request.amountInRaw.toString(),
    request.slippageBps.toString(),
    request.side,
  ]);
  return Object.freeze({
    id: `quote_${createHash('sha256').update(identity).digest('hex')}`,
    inputMint,
    outputMint,
    amountInRaw: request.amountInRaw,
    amountOutRaw: result.amountOutRaw,
    minimumAmountOutRaw,
    feesRaw: result.feesRaw,
    slippageBps: request.slippageBps,
    priceImpactBps: priceImpact(
      request.side,
      request.amountInRaw,
      result.amountOutRaw,
      toBigint(curve.virtualTokenReserves, 'virtualTokenReserves'),
      toBigint(curve.virtualQuoteReserves, 'virtualQuoteReserves'),
    ),
    observedAtMs,
    observedSlot: globalAccount.slot,
  });
}

function buy(
  global: Global,
  feeConfig: FeeConfig,
  curve: BondingCurve,
  mintSupply: BN,
  amount: BN,
  quoteMint: PublicKey,
): { readonly amountOutRaw: bigint; readonly feesRaw: bigint } {
  const amountOut = getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply, bondingCurve: curve, amount, quoteMint,
  });
  const totalCost = getBuySolAmountFromTokenAmount({
    global, feeConfig, mintSupply, bondingCurve: curve, amount: amountOut, quoteMint,
  });
  if (totalCost.gt(amount)) inconsistent('Le coût BUY officiel dépasse le montant demandé.');
  if (amountOut.gte(curve.virtualTokenReserves)) inconsistent('La réserve token virtuelle est insuffisante.');
  const grossReserveChange = amountOut
    .mul(curve.virtualQuoteReserves)
    .div(curve.virtualTokenReserves.sub(amountOut))
    .addn(1);
  if (totalCost.lt(grossReserveChange)) inconsistent('Les frais BUY officiels sont incohérents.');
  return Object.freeze({
    amountOutRaw: toBigint(amountOut, 'buyAmountOut'),
    feesRaw: toBigint(totalCost.sub(grossReserveChange), 'buyFees'),
  });
}

function sell(
  global: Global,
  feeConfig: FeeConfig,
  curve: BondingCurve,
  mintSupply: BN,
  amount: BN,
): { readonly amountOutRaw: bigint; readonly feesRaw: bigint } {
  const grossReserveChange = amount
    .mul(curve.virtualQuoteReserves)
    .div(curve.virtualTokenReserves.add(amount));
  if (grossReserveChange.gt(curve.realQuoteReserves)) {
    inconsistent('La réserve quote réelle est insuffisante pour vendre.');
  }
  const amountOut = getSellSolAmountFromTokenAmount({
    global, feeConfig, mintSupply, bondingCurve: curve, amount,
  });
  if (amountOut.gt(grossReserveChange)) inconsistent('Les frais SELL officiels sont incohérents.');
  return Object.freeze({
    amountOutRaw: toBigint(amountOut, 'sellAmountOut'),
    feesRaw: toBigint(grossReserveChange.sub(amountOut), 'sellFees'),
  });
}

function validateRequest(request: PaperQuoteRequest, observedAtMs: number): void {
  publicKey(request.mint, 'mint');
  publicKey(request.quoteAsset.mint, 'quote mint');
  if (
    request.quoteAsset.mint === WSOL_MINT
    && request.quoteAsset.tokenProgram !== 'SPL_TOKEN'
  ) unsupportedQuote();
  if (
    !Number.isSafeInteger(request.quoteAsset.decimals)
    || request.quoteAsset.decimals < 0
    || request.quoteAsset.decimals > 18
  ) unsupportedQuote();
  if (request.amountInRaw <= 0n || request.amountInRaw > U64_MAX) {
    inconsistent('Le montant de cotation est hors plage u64.');
  }
  if (request.slippageBps < 0n || request.slippageBps > BASIS_POINTS) {
    inconsistent('Le slippage de cotation est hors bornes.');
  }
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    inconsistent('La date de cotation est invalide.');
  }
}

function validateState(
  request: PaperQuoteRequest,
  global: Global,
  feeConfig: FeeConfig,
  curve: BondingCurve,
  mintSupply: BN,
): void {
  if (!global.initialized) inconsistent('Le compte global Pump.fun n’est pas initialisé.');
  if (curve.complete) inconsistent('La bonding curve Pump.fun est complète.');
  const curveQuoteMint = curve.quoteMint.toBase58();
  const legacySolCurve = curveQuoteMint === DEFAULT_PUBLIC_KEY && request.quoteAsset.mint === WSOL_MINT;
  if (!legacySolCurve && curveQuoteMint !== request.quoteAsset.mint) unsupportedQuote();
  const values = [
    global.initialVirtualTokenReserves,
    global.initialVirtualSolReserves,
    global.initialRealTokenReserves,
    global.tokenTotalSupply,
    global.feeBasisPoints,
    global.creatorFeeBasisPoints,
    global.initialVirtualQuoteReserves,
    curve.virtualTokenReserves,
    curve.virtualQuoteReserves,
    curve.realTokenReserves,
    curve.realQuoteReserves,
    curve.tokenTotalSupply,
    mintSupply,
  ];
  for (const [index, value] of values.entries()) toBigint(value, `state${String(index)}`);
  if (
    curve.virtualTokenReserves.lten(0)
    || curve.virtualQuoteReserves.lten(0)
    || curve.realTokenReserves.lten(0)
    || mintSupply.lten(0)
    || !curve.tokenTotalSupply.eq(mintSupply)
  ) inconsistent('Les réserves Pump.fun sont incohérentes.');
  validateFeeConfig(feeConfig);
}

function validateFeeConfig(feeConfig: FeeConfig): void {
  if (feeConfig.feeTiers.length === 0 || feeConfig.feeTiers.length > 256) {
    inconsistent('La configuration de frais Pump.fun est invalide.');
  }
  let previous: bigint | null = null;
  for (const tier of feeConfig.feeTiers) {
    const threshold = toBigint(tier.marketCapLamportsThreshold, 'feeThreshold');
    if (previous !== null && threshold <= previous) {
      inconsistent('Les paliers de frais Pump.fun sont incohérents.');
    }
    previous = threshold;
    for (const fee of [tier.fees.lpFeeBps, tier.fees.protocolFeeBps, tier.fees.creatorFeeBps]) {
      const value = toBigint(fee, 'feeBps');
      if (value > BASIS_POINTS) inconsistent('Les frais Pump.fun sont hors bornes.');
    }
  }
}

function priceImpact(
  side: 'BUY' | 'SELL',
  amountInRaw: bigint,
  amountOutRaw: bigint,
  virtualTokenReservesRaw: bigint,
  virtualQuoteReservesRaw: bigint,
): bigint {
  const spotNumerator = side === 'BUY'
    ? amountInRaw * virtualTokenReservesRaw
    : amountInRaw * virtualQuoteReservesRaw;
  const spotDenominator = side === 'BUY'
    ? virtualQuoteReservesRaw
    : virtualTokenReservesRaw;
  const candidate = spotNumerator - amountOutRaw * spotDenominator;
  const lost = candidate > 0n ? candidate : 0n;
  const impact = ceilDiv(lost * BASIS_POINTS, spotNumerator);
  return impact > BASIS_POINTS ? BASIS_POINTS : impact;
}

function accountAddresses(mint: string): readonly [string, string, string, string] {
  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    inconsistent('Le mint Pump.fun est invalide.');
  }
  return [
    GLOBAL_PDA.toBase58(),
    PUMP_FEE_CONFIG_PDA.toBase58(),
    bondingCurvePda(mintKey).toBase58(),
    mintKey.toBase58(),
  ];
}

function required(
  account: ReadonlyAccountSnapshot | null | undefined,
  address: string,
): ReadonlyAccountSnapshot {
  if (account?.address !== address) {
    throw new PaperQuoteError(
      'QUOTE_STATE_UNAVAILABLE',
      'Un compte requis pour la cotation Pump.fun est indisponible.',
    );
  }
  return account;
}

function owner(account: ReadonlyAccountSnapshot, expected: string): void {
  if (account.owner !== expected) inconsistent('Un owner de compte Pump.fun est incohérent.');
}

function tokenMintOwner(account: ReadonlyAccountSnapshot): void {
  if (account.owner !== SPL_TOKEN_PROGRAM_ID && account.owner !== TOKEN_2022_PROGRAM_ADDRESS) {
    inconsistent('Le Token Program du mint Pump.fun est inconnu.');
  }
}

function decodeGlobal(account: ReadonlyAccountSnapshot): Global {
  return PUMP_SDK.decodeGlobal(accountInfo(account));
}

function decodeFeeConfig(account: ReadonlyAccountSnapshot): FeeConfig {
  return PUMP_SDK.decodeFeeConfig(accountInfo(account));
}

function decodeCurve(account: ReadonlyAccountSnapshot): BondingCurve {
  return PUMP_SDK.decodeBondingCurve(accountInfo(account));
}

function decodeMintSupply(account: ReadonlyAccountSnapshot): BN {
  if (account.data.length < MintLayout.span) inconsistent('Le compte mint Pump.fun est tronqué.');
  const mint = MintLayout.decode(account.data);
  if (!mint.isInitialized || mint.supply > U64_MAX) inconsistent('Le compte mint Pump.fun est invalide.');
  return new BN(mint.supply.toString());
}

function accountInfo(snapshot: ReadonlyAccountSnapshot): AccountInfo<Buffer> {
  if (snapshot.lamports < 0n || snapshot.lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    inconsistent('Les lamports du compte Pump.fun sont hors plage SDK.');
  }
  return {
    data: Buffer.from(snapshot.data),
    executable: false,
    lamports: Number(snapshot.lamports),
    owner: new PublicKey(snapshot.owner),
    rentEpoch: 0,
  };
}

function publicKey(value: string, field: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new PaperQuoteError('QUOTE_STATE_INCONSISTENT', `Le ${field} est invalide.`);
  }
}

function toBigint(value: BN, field: string): bigint {
  const decimal = value.toString(10);
  if (!/^(?:0|[1-9]\d*)$/u.test(decimal)) inconsistent(`La valeur ${field} est invalide.`);
  const result = BigInt(decimal);
  if (result > U64_MAX) inconsistent(`La valeur ${field} est hors plage u64.`);
  return result;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) inconsistent('Une division de cotation est invalide.');
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function unsupportedQuote(): never {
  throw new PaperQuoteError(
    'UNSUPPORTED_QUOTE_MINT',
    'Le quote mint n’est pas supporté par cette bonding curve Pump.fun.',
  );
}

function inconsistent(message: string): never {
  throw new PaperQuoteError('QUOTE_STATE_INCONSISTENT', message);
}
