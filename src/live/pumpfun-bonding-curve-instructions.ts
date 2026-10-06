import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, type AccountInfo, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import type { PaperExecutionQuote } from '../domain/paper-trading.js';
import { DEFAULT_PUBLIC_KEY, PUMP_PROGRAM_ID, WSOL_MINT } from '../launchpads/pumpfun/constants.js';
import { PUMP_SDK, type BondingCurve } from '../launchpads/pumpfun/official-sdk.js';
import type { PumpFunQuoteAndState } from '../paper/pumpfun-paper-quote.provider.js';

const U64_MAX = 18_446_744_073_709_551_615n;
const BASIS_POINTS = 10_000n;

/** Builds only Pump.fun bonding-curve V2 instructions. It never signs or sends. */
export async function createPumpFunBondingCurveInstructions(input: {
  readonly side: 'BUY' | 'SELL';
  readonly quoteAndState: PumpFunQuoteAndState;
  readonly associatedUserAccountInfo: AccountInfo<Buffer> | null;
  readonly user: PublicKey;
  readonly quoteTokenProgram?: PublicKey;
}): Promise<readonly TransactionInstruction[]> {
  const { side } = input;
  const { quote, mint, stateSlot, global, bondingCurve, bondingCurveAccountInfo, tokenProgram } = input.quoteAndState;
  validateQuote(quote, side, mint, stateSlot, bondingCurve);
  if (side === 'SELL') validateCurrentCashbackState(input.quoteAndState);
  if (!global.initialized) throw new Error('Pump.fun global state is not initialized.');
  if (bondingCurve.complete) throw new Error('Pump.fun bonding curve is complete; migration route is unsupported.');
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error('Unsupported Pump.fun base token program.');
  }
  const curveQuoteMint = bondingCurve.quoteMint.toBase58();
  if (curveQuoteMint !== DEFAULT_PUBLIC_KEY && curveQuoteMint !== WSOL_MINT) {
    throw new Error('Unsupported Pump.fun quote mint for the initial live profile.');
  }
  if ((input.quoteTokenProgram ?? TOKEN_PROGRAM_ID).toBase58() !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error('The initial live profile supports only the SPL Token wSOL quote account.');
  }

  const slippageBps = quote.slippageBps;
  // The locked SDK accepts percent with 0.1% precision and applies slippage
  // internally to quoteAmount. Reject finer precision instead of rounding it.
  const slippagePercent = Number(slippageBps) / 100;
  const common = {
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    mint,
    user: input.user,
    slippage: slippagePercent,
    tokenProgram,
    quoteTokenProgram: input.quoteTokenProgram ?? TOKEN_PROGRAM_ID,
  };
  if (side === 'BUY') {
    const quoteAmountBeforeSdkSlippage = maximumSdkBaseQuote(quote.amountInRaw, slippageBps);
    return Object.freeze(await PUMP_SDK.buyV2Instructions({
      ...common,
      associatedUserAccountInfo: input.associatedUserAccountInfo,
      amount: new BN(quote.minimumAmountOutRaw.toString()),
      quoteAmount: new BN(quoteAmountBeforeSdkSlippage.toString()),
    }));
  }
  return Object.freeze(await PUMP_SDK.sellV2Instructions({
    ...common,
    amount: new BN(quote.amountInRaw.toString()),
    quoteAmount: new BN(quote.amountOutRaw.toString()),
  }));
}

function validateCurrentCashbackState(state: PumpFunQuoteAndState): void {
  const evidence = state.admissionEvidence;
  if (evidence.mint !== state.mint.toBase58() || evidence.owner !== PUMP_PROGRAM_ID
    || evidence.slot !== state.stateSlot || evidence.source !== 'validated_getMultipleAccounts_same_slot'
    || evidence.layout === 'unsupported' || evidence.isCashbackCoin === null
    || evidence.tokenProgram !== state.tokenProgram.toBase58()
    || evidence.isCashbackCoin === null || evidence.isCashbackCoin !== state.bondingCurve.isCashbackCoin) {
    throw new Error('SELL requires the current Pump.fun cashback state from the same validated RPC slot.');
  }
}

function validateQuote(
  quote: PaperExecutionQuote,
  side: 'BUY' | 'SELL',
  mint: PublicKey,
  stateSlot: bigint,
  bondingCurve: BondingCurve,
): void {
  if (quote.observedSlot !== stateSlot) throw new Error('Pump.fun quote and instruction state must use the same slot.');
  if (quote.observedSlot < 0n || quote.slippageBps < 0n || quote.slippageBps > 1_000n || quote.slippageBps % 10n !== 0n) {
    throw new Error('Pump.fun quote slot or slippage is outside the supported range.');
  }
  if (quote.amountInRaw <= 0n || quote.amountOutRaw <= 0n || quote.minimumAmountOutRaw <= 0n
    || quote.amountInRaw > U64_MAX || quote.amountOutRaw > U64_MAX || quote.minimumAmountOutRaw > U64_MAX
    || quote.minimumAmountOutRaw > quote.amountOutRaw) {
    throw new Error('Pump.fun quote amounts are invalid.');
  }
  const sdkMinimumOut = quote.amountOutRaw * (BASIS_POINTS - quote.slippageBps) / BASIS_POINTS;
  if (quote.minimumAmountOutRaw !== sdkMinimumOut) {
    throw new Error('Pump.fun quote minimum output does not match the locked SDK slippage rule.');
  }
  const expected = side === 'BUY'
    ? { input: WSOL_MINT, output: mint.toBase58() }
    : { input: mint.toBase58(), output: WSOL_MINT };
  if (quote.inputMint !== expected.input || quote.outputMint !== expected.output) {
    throw new Error(`Pump.fun ${side} quote mint directions are invalid.`);
  }
  const expectedQuote = bondingCurve.quoteMint.toBase58();
  if (expectedQuote !== DEFAULT_PUBLIC_KEY && expectedQuote !== WSOL_MINT) {
    throw new Error('Unsupported Pump.fun quote mint for the initial live profile.');
  }
}

/** Largest base amount for which the SDK's floored slippage addition stays within budget. */
function maximumSdkBaseQuote(budget: bigint, slippageBps: bigint): bigint {
  return budget * BASIS_POINTS / (BASIS_POINTS + slippageBps);
}
