import type { Connection } from '@solana/web3.js';
import { amount, parseJitoBotConfig, redemptionLamports, requiredRedemptionLamports } from './config.js';
import type { JupiterClient } from './jupiter.js';
import { decodeJitoStakePool, JITO_POOL_ADDRESS } from './stake-pool.js';
import type { JitoBotConfig } from './types.js';

export interface ObserveMarketOptions {
  connection: Pick<Connection, 'getAccountInfoAndContext' | 'getEpochInfo'>;
  jupiter: Pick<JupiterClient, 'getQuote'>;
  config: JitoBotConfig;
  now?: () => number;
}

/** Public arithmetic only: this deliberately has no wallet, signer or submission port. */
export async function observeMarket(options: ObserveMarketOptions): Promise<Record<string, unknown>> {
  const config = parseJitoBotConfig(options.config);
  const quote = await options.jupiter.getQuote();
  if (quote.inputLamports !== amount(config.inputLamports)) throw new Error('Market quote input amount differs from the configured ticket');
  const rpcConfig = { commitment: 'confirmed' as const, minContextSlot: quote.contextSlot };
  const [response, epoch] = await Promise.all([
    options.connection.getAccountInfoAndContext(JITO_POOL_ADDRESS, rpcConfig),
    options.connection.getEpochInfo(rpcConfig),
  ]);
  if (!response.value) throw new Error('Jito stake pool account is missing');
  if (!Number.isSafeInteger(epoch.epoch) || epoch.epoch < 0 || !Number.isSafeInteger(response.context.slot) || response.context.slot < 0) throw new Error('Invalid public RPC chain context');
  const pool = decodeJitoStakePool(response.value, BigInt(epoch.epoch));
  const now = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid observation clock');
  const minimum = redemptionLamports(quote.minimumOutputAtomic.toString(), pool.stakeWithdrawalFee.numerator.toString(), pool.stakeWithdrawalFee.denominator.toString(), pool.totalLamports.toString(), pool.poolTokenSupply.toString());
  const required = requiredRedemptionLamports(config);
  const carry = required - amount(config.inputLamports) - amount(config.networkBudgetLamports) - amount(config.minProfitLamports);
  const quoteAgeMs = now - quote.receivedAtMs;
  const quoteFresh = Number.isSafeInteger(quote.receivedAtMs) && quoteAgeMs >= 0 && quoteAgeMs <= config.maxObservationAgeMs;
  const routeSourceSlots = quote.routePlan.map((route) => route.updateContextSlot);
  const knownSources = routeSourceSlots.filter((slot): slot is number => slot !== null);
  const maxRouteSlotLag = knownSources.length > 0 ? Math.max(...knownSources.map((slot) => quote.contextSlot - slot)) : null;
  const knownSourceStale = knownSources.some((slot) => !Number.isSafeInteger(slot) || slot < 0 || slot > quote.contextSlot || quote.contextSlot - slot > config.maxSourceSlotLag);
  const routeFreshness = knownSourceStale ? 'stale' : routeSourceSlots.length === 0 || knownSources.length !== routeSourceSlots.length ? 'unproven' : 'fresh';
  const poolQuoteSlotGap = response.context.slot - quote.contextSlot;
  const poolFresh = poolQuoteSlotGap >= 0 && poolQuoteSlotGap <= config.maxPoolQuoteSlotGap;
  return {
    status: 'observed', observedAtMs: now, walletChecked: false, withdrawalChecked: false, executable: false,
    inputLamports: quote.inputLamports.toString(), expectedJitoOutUnits: quote.expectedOutputAtomic.toString(), minimumJitoOutUnits: quote.minimumOutputAtomic.toString(),
    minimumRedemptionLamports: minimum.toString(), requiredRedemptionLamports: required.toString(),
    networkBudgetLamports: config.networkBudgetLamports, carryLamports: carry.toString(), minProfitLamports: config.minProfitLamports,
    netSurplusAfterBudgetAndCarryLamports: (minimum - required + amount(config.minProfitLamports)).toString(),
    arithmeticThresholdMet: minimum >= required,
    quote: { receivedAtMs: quote.receivedAtMs, contextSlot: quote.contextSlot, slippageBps: quote.slippageBps, routeSourceSlots, routeLabels: quote.routePlan.map((route) => route.label) },
    pool: { address: pool.poolAddress.toBase58(), mint: pool.poolMint.toBase58(), contextSlot: response.context.slot,
      currentEpoch: pool.currentEpoch.toString(), lastUpdateEpoch: pool.lastUpdateEpoch.toString(), totalLamports: pool.totalLamports.toString(), tokenSupply: pool.poolTokenSupply.toString(),
      withdrawalFeeNumerator: pool.stakeWithdrawalFee.numerator.toString(), withdrawalFeeDenominator: pool.stakeWithdrawalFee.denominator.toString() },
    freshness: { quote: quoteFresh ? 'fresh' : 'stale', route: routeFreshness, poolQuote: poolFresh ? 'fresh' : 'stale', quoteAgeMs, maxRouteSlotLag, poolQuoteSlotGap,
      allProven: quoteFresh && routeFreshness === 'fresh' && poolFresh },
    reason: 'Public price arithmetic only; wallet balance, withdrawal availability and executable transaction simulation remain unchecked',
  };
}
