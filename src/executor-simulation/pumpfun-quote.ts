import {
  ExtensionType,
  getExtensionTypes,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import {
  DEFAULT_PUBLIC_KEY,
  PUMP_FEE_PROGRAM_ADDRESS,
  PUMP_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ADDRESS,
  WSOL_MINT,
} from '../launchpads/pumpfun/constants.js';
import {
  getBuySolAmountFromTokenAmount,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  PUMP_SDK,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '../launchpads/pumpfun/official-sdk.js';
import type { ExecutionRpcAccount } from '../ports/execution-market-gateway.js';

const U64_MAX = (1n << 64n) - 1n;
const BASIS_POINTS = 10_000n;
const ALLOWED_TOKEN_2022_MINT_EXTENSIONS = new Set<ExtensionType>([
  ExtensionType.MintCloseAuthority,
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.GroupPointer,
  ExtensionType.TokenGroup,
  ExtensionType.GroupMemberPointer,
  ExtensionType.TokenGroupMember,
]);

export type PumpFunExecutionQuoteErrorCode =
  | 'QUOTE_MINT_NOT_ALLOWED'
  | 'SELL_QUOTE_UNAVAILABLE'
  | 'UNSUPPORTED_TOKEN_EXTENSION'
  | 'EXECUTION_EVIDENCE_INVALID';

export class PumpFunExecutionQuoteError extends Error {
  public constructor(public readonly code: PumpFunExecutionQuoteErrorCode) {
    super('Pump.fun execution quote rejected.');
    this.name = 'PumpFunExecutionQuoteError';
  }
}

export interface PumpFunExecutionQuoteInputV1 {
  readonly mint: string;
  readonly quoteMint: string;
  readonly quoteTokenProgram: 'SPL_TOKEN';
  readonly quoteDecimals: 9;
  readonly side: 'BUY' | 'SELL';
  readonly amountInRaw: bigint;
  readonly slippageBps: bigint;
  readonly accounts: readonly [
    ExecutionRpcAccount,
    ExecutionRpcAccount,
    ExecutionRpcAccount,
    ExecutionRpcAccount,
  ];
}

export interface PumpFunExecutionQuoteResultV1 {
  readonly baseTokenProgram: 'SPL_TOKEN' | 'TOKEN_2022';
  readonly expectedAmountOutRaw: bigint;
  readonly minimumAmountOutRaw: bigint;
  readonly feesRaw: bigint;
  readonly reverseSellAvailable: boolean;
}

export function computePumpFunExecutionQuote(
  input: PumpFunExecutionQuoteInputV1,
): PumpFunExecutionQuoteResultV1 {
  try {
    return compute(input);
  } catch (error) {
    if (error instanceof PumpFunExecutionQuoteError) throw error;
    throw invalid();
  }
}

function compute(input: PumpFunExecutionQuoteInputV1): PumpFunExecutionQuoteResultV1 {
  const [globalAccount, feeAccount, curveAccount, mintAccount] = input.accounts;
  if (input.quoteMint !== WSOL_MINT) throw quoteMintRejected();
  if (input.amountInRaw <= 0n || input.amountInRaw > U64_MAX
    || input.slippageBps < 0n || input.slippageBps > BASIS_POINTS
    || mintAccount.address !== input.mint
    || globalAccount.owner !== PUMP_PROGRAM_ID
    || feeAccount.owner !== PUMP_FEE_PROGRAM_ADDRESS
    || curveAccount.owner !== PUMP_PROGRAM_ID
    || [globalAccount, feeAccount, curveAccount, mintAccount].some((account) => account.executable)) {
    throw invalid();
  }
  const global = PUMP_SDK.decodeGlobal(accountInfo(globalAccount));
  const feeConfig = PUMP_SDK.decodeFeeConfig(accountInfo(feeAccount));
  const curve = PUMP_SDK.decodeBondingCurve(accountInfo(curveAccount));
  const mint = decodeMint(mintAccount);
  validateState(global, feeConfig, curve, mint.supply, input.quoteMint);
  const amount = bn(input.amountInRaw);
  const result = input.side === 'BUY'
    ? buy(global, feeConfig, curve, mint.supply, amount, new PublicKey(input.quoteMint))
    : sell(global, feeConfig, curve, mint.supply, amount);
  if (result.amountOutRaw <= 0n) throw invalid();
  const minimumAmountOutRaw = result.amountOutRaw
    * (BASIS_POINTS - input.slippageBps)
    / BASIS_POINTS;
  return Object.freeze({
    baseTokenProgram: mint.program,
    expectedAmountOutRaw: result.amountOutRaw,
    minimumAmountOutRaw,
    feesRaw: result.feesRaw,
    reverseSellAvailable: input.side !== 'BUY'
      || reverseSell(global, feeConfig, curve, mint.supply, result.amountOutRaw),
  });
}

function buy(
  global: Global,
  feeConfig: FeeConfig,
  curve: BondingCurve,
  mintSupply: BN,
  amount: BN,
  quoteMint: PublicKey,
): Readonly<{ readonly amountOutRaw: bigint; readonly feesRaw: bigint }> {
  const amountOut = getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply, bondingCurve: curve, amount, quoteMint,
  });
  const totalCost = getBuySolAmountFromTokenAmount({
    global, feeConfig, mintSupply, bondingCurve: curve, amount: amountOut, quoteMint,
  });
  if (totalCost.gt(amount) || amountOut.gte(curve.virtualTokenReserves)) throw invalid();
  const gross = amountOut.mul(curve.virtualQuoteReserves)
    .div(curve.virtualTokenReserves.sub(amountOut)).addn(1);
  if (totalCost.lt(gross)) throw invalid();
  return Object.freeze({
    amountOutRaw: toBigint(amountOut),
    feesRaw: toBigint(totalCost.sub(gross)),
  });
}

function sell(
  global: Global,
  feeConfig: FeeConfig,
  curve: BondingCurve,
  mintSupply: BN,
  amount: BN,
): Readonly<{ readonly amountOutRaw: bigint; readonly feesRaw: bigint }> {
  const gross = amount.mul(curve.virtualQuoteReserves)
    .div(curve.virtualTokenReserves.add(amount));
  if (gross.gt(curve.realQuoteReserves)) throw sellUnavailable();
  const amountOut = getSellSolAmountFromTokenAmount({
    global, feeConfig, mintSupply, bondingCurve: curve, amount,
  });
  if (amountOut.gt(gross)) throw invalid();
  return Object.freeze({
    amountOutRaw: toBigint(amountOut),
    feesRaw: toBigint(gross.sub(amountOut)),
  });
}

function reverseSell(
  global: Global,
  feeConfig: FeeConfig,
  curve: BondingCurve,
  mintSupply: BN,
  amountInRaw: bigint,
): boolean {
  const amount = bn(amountInRaw);
  if (amount.gte(curve.virtualTokenReserves) || amount.gt(curve.realTokenReserves)) return false;
  const gross = amount.mul(curve.virtualQuoteReserves)
    .div(curve.virtualTokenReserves.sub(amount)).addn(1);
  const postBuy: BondingCurve = {
    ...curve,
    virtualTokenReserves: curve.virtualTokenReserves.sub(amount),
    virtualQuoteReserves: curve.virtualQuoteReserves.add(gross),
    realTokenReserves: curve.realTokenReserves.sub(amount),
    realQuoteReserves: curve.realQuoteReserves.add(gross),
  };
  const reverseGross = amount.mul(postBuy.virtualQuoteReserves)
    .div(postBuy.virtualTokenReserves.add(amount));
  if (reverseGross.gt(postBuy.realQuoteReserves)) return false;
  try {
    const result = sell(global, feeConfig, postBuy, mintSupply, amount);
    return result.amountOutRaw > 0n;
  } catch {
    return false;
  }
}

function decodeMint(account: ExecutionRpcAccount): Readonly<{
  readonly supply: BN;
  readonly program: 'SPL_TOKEN' | 'TOKEN_2022';
}> {
  const program = account.owner === SPL_TOKEN_PROGRAM_ID
    ? TOKEN_PROGRAM_ID
    : account.owner === TOKEN_2022_PROGRAM_ADDRESS
      ? TOKEN_2022_PROGRAM_ID
      : null;
  if (program === null) throw invalid();
  let mint: ReturnType<typeof unpackMint>;
  try {
    mint = unpackMint(new PublicKey(account.address), accountInfo(account), program);
  } catch {
    throw invalid();
  }
  if (!mint.isInitialized || mint.supply > U64_MAX) throw invalid();
  for (const extension of getExtensionTypes(mint.tlvData)) {
    if (!ALLOWED_TOKEN_2022_MINT_EXTENSIONS.has(extension)) {
      throw new PumpFunExecutionQuoteError('UNSUPPORTED_TOKEN_EXTENSION');
    }
  }
  return Object.freeze({
    supply: new BN(mint.supply.toString()),
    program: program.equals(TOKEN_PROGRAM_ID) ? 'SPL_TOKEN' : 'TOKEN_2022',
  });
}

function validateState(
  global: Global,
  feeConfig: FeeConfig,
  curve: BondingCurve,
  mintSupply: BN,
  quoteMint: string,
): void {
  const curveQuoteMint = curve.quoteMint.toBase58();
  const legacy = curveQuoteMint === DEFAULT_PUBLIC_KEY && quoteMint === WSOL_MINT;
  if (!legacy && curveQuoteMint !== quoteMint) throw quoteMintRejected();
  if (!global.initialized || curve.complete
    || curve.virtualTokenReserves.lten(0)
    || curve.virtualQuoteReserves.lten(0)
    || curve.realTokenReserves.lten(0)
    || mintSupply.lten(0)
    || !curve.tokenTotalSupply.eq(mintSupply)) throw invalid();
  for (const value of [
    global.initialVirtualTokenReserves, global.initialVirtualSolReserves,
    global.initialRealTokenReserves, global.tokenTotalSupply, global.feeBasisPoints,
    global.creatorFeeBasisPoints, global.initialVirtualQuoteReserves,
    curve.virtualTokenReserves, curve.virtualQuoteReserves, curve.realTokenReserves,
    curve.realQuoteReserves, curve.tokenTotalSupply, mintSupply,
  ]) void toBigint(value);
  if (feeConfig.feeTiers.length === 0 || feeConfig.feeTiers.length > 256) throw invalid();
  let previous: bigint | null = null;
  for (const tier of feeConfig.feeTiers) {
    const threshold = toBigint(tier.marketCapLamportsThreshold);
    if (previous !== null && threshold <= previous) throw invalid();
    previous = threshold;
    for (const fee of [tier.fees.lpFeeBps, tier.fees.protocolFeeBps, tier.fees.creatorFeeBps]) {
      if (toBigint(fee) > BASIS_POINTS) throw invalid();
    }
  }
}

function accountInfo(account: ExecutionRpcAccount): AccountInfo<Buffer> {
  if (account.lamports < 0n || account.lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return {
    data: Buffer.from(account.dataBase64, 'base64'),
    executable: account.executable,
    lamports: Number(account.lamports),
    owner: new PublicKey(account.owner),
    rentEpoch: 0,
  };
}

function bn(value: bigint): BN { return new BN(value.toString(10), 10); }

function toBigint(value: BN): bigint {
  const decimal = value.toString(10);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(decimal)) throw invalid();
  const result = BigInt(decimal);
  if (result > U64_MAX) throw invalid();
  return result;
}

function invalid(): PumpFunExecutionQuoteError {
  return new PumpFunExecutionQuoteError('EXECUTION_EVIDENCE_INVALID');
}

function quoteMintRejected(): PumpFunExecutionQuoteError {
  return new PumpFunExecutionQuoteError('QUOTE_MINT_NOT_ALLOWED');
}

function sellUnavailable(): PumpFunExecutionQuoteError {
  return new PumpFunExecutionQuoteError('SELL_QUOTE_UNAVAILABLE');
}
