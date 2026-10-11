import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import type { JitoBotConfig, Observation } from './types.js';

export const JITO_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
export const JITO_STAKE_POOL = 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const U64_MAX = (1n << 64n) - 1n;

export function amount(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error('Amount must be an unsigned decimal integer string');
  const result = BigInt(value);
  if (result > U64_MAX) throw new Error('Amount exceeds u64');
  return result;
}

const integerAmount = z.string().refine((value) => {
  try { amount(value); return true; } catch { return false; }
}, 'Expected unsigned u64 decimal string');
const address = z.string().refine((value) => {
  if (value === '') return true;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}, 'Expected a canonical Solana address');

const schema = z.object({
  version: z.literal(1).default(1),
  enabled: z.boolean().default(false),
  walletAddress: address.default(''),
  stakePoolAddress: z.literal(JITO_STAKE_POOL).default(JITO_STAKE_POOL),
  jitoMintAddress: z.literal(JITO_MINT).default(JITO_MINT),
  inputLamports: z.literal('3000000000').default('3000000000'),
  minProfitLamports: integerAmount.refine((v) => amount(v) >= 9_000_000n).default('9000000'),
  networkBudgetLamports: integerAmount.refine((v) => amount(v) >= 1_000_000n).default('1000000'),
  reserveLamports: integerAmount.refine((v) => amount(v) >= 20_000_000n).default('20000000'),
  carryAnnualBps: z.number().int().min(650).max(10_000).default(650),
  carryHours: z.number().int().min(72).max(8760).default(72),
  confirmationDelayMs: z.number().int().min(10_000).max(300_000).default(10_000),
  maxConfirmationGapMs: z.number().int().min(10_000).max(600_000).default(30_000),
  maxObservationAgeMs: z.number().int().min(1).max(30_000).default(5_000),
  maxSourceSlotLag: z.number().int().min(0).max(150).default(50),
  maxPoolQuoteSlotGap: z.number().int().min(0).max(150).default(32),
  maxCycles: z.number().int().min(1).max(100).default(1),
  maxTotalFeesLamports: integerAmount.default('0'),
  maxRealizedLossLamports: integerAmount.default('0'),
  stopFile: z.string().min(1).default('.jitosol-bot/STOP'),
}).strict().superRefine((config, context) => {
  if (config.enabled && !config.walletAddress) context.addIssue({ code: 'custom', message: 'Enabled bot requires walletAddress', path: ['walletAddress'] });
  if (config.maxConfirmationGapMs < config.confirmationDelayMs) context.addIssue({ code: 'custom', message: 'Confirmation window must include confirmation delay', path: ['maxConfirmationGapMs'] });
});

export function parseJitoBotConfig(value: unknown): JitoBotConfig {
  return schema.parse(value);
}

export function configFingerprint(config: JitoBotConfig): string {
  const identity = Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'enabled').sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('Invalid integer division');
  return (numerator + denominator - 1n) / denominator;
}

export function redemptionLamports(tokenUnits: string, feeNumerator: string, feeDenominator: string, totalLamports: string, tokenSupply: string): bigint {
  const units = amount(tokenUnits);
  const numerator = amount(feeNumerator);
  const denominator = amount(feeDenominator);
  const supply = amount(tokenSupply);
  if (supply === 0n || (denominator !== 0n && numerator > denominator)) throw new Error('Invalid pool fee or supply');
  // SPL Fee::apply defines a zero denominator as a disabled fee.
  const fee = denominator === 0n ? 0n : ceilDiv(units * numerator, denominator);
  return ((units - fee) * amount(totalLamports)) / supply;
}

export function requiredRedemptionLamports(config: JitoBotConfig): bigint {
  const input = amount(config.inputLamports);
  const carry = ceilDiv(input * BigInt(config.carryAnnualBps) * BigInt(config.carryHours), 10_000n * 365n * 24n);
  return input + amount(config.networkBudgetLamports) + amount(config.minProfitLamports) + carry;
}

export interface ObservationDecision { eligible: boolean; reason: string; minimumRedemptionLamports?: string; requiredRedemptionLamports?: string }

export function evaluateObservation(observation: Observation, config: JitoBotConfig, now: number): ObservationDecision {
  try {
    const { quote, pool, withdrawal, wallet } = observation;
    const fresh = (timestamp: number): boolean => Number.isSafeInteger(timestamp) && timestamp <= now && now - timestamp <= config.maxObservationAgeMs;
    if (![observation.observedAtMs, quote.receivedAtMs, withdrawal.checkedAtMs].every(fresh)) return { eligible: false, reason: 'stale or future observation' };
    if (!quote.id || quote.inputMint !== SOL_MINT || quote.outputMint !== config.jitoMintAddress || quote.inputLamports !== config.inputLamports) return { eligible: false, reason: 'quote mint or amount mismatch' };
    if (pool.address !== config.stakePoolAddress || pool.mint !== config.jitoMintAddress || pool.lastUpdateEpoch !== pool.currentEpoch) return { eligible: false, reason: 'pool identity or epoch mismatch' };
    if (![quote.contextSlot, quote.routeSlot, pool.contextSlot, pool.currentEpoch, pool.lastUpdateEpoch].every((value) => Number.isSafeInteger(value) && value >= 0)) return { eligible: false, reason: 'invalid chain context' };
    if (quote.routeSlot > quote.contextSlot || quote.contextSlot - quote.routeSlot > config.maxSourceSlotLag || Math.abs(pool.contextSlot - quote.contextSlot) > config.maxPoolQuoteSlotGap) return { eligible: false, reason: 'stale route or pool/quote slot gap' };
    if (!withdrawal.available) return { eligible: false, reason: withdrawal.reason ?? 'stake withdrawal unavailable' };
    if (wallet.address !== config.walletAddress) return { eligible: false, reason: 'wallet identity mismatch' };
    amount(wallet.jitoUnits);
    const reserves = amount(withdrawal.stakeRentLamports) + amount(withdrawal.tokenAccountRentLamports) + amount(config.networkBudgetLamports);
    const reserve = reserves > amount(config.reserveLamports) ? reserves : amount(config.reserveLamports);
    if (amount(wallet.solLamports) < amount(config.inputLamports) + reserve) return { eligible: false, reason: 'insufficient liquid balance and reserve' };
    const minimumDelegation = amount(withdrawal.minimumDelegationLamports);
    if (minimumDelegation === 0n || amount(quote.minJitoOutUnits) === 0n || amount(pool.totalLamports) === 0n) return { eligible: false, reason: 'invalid withdrawal minimum or pool balance' };
    const redemption = redemptionLamports(quote.minJitoOutUnits, pool.withdrawalFeeNumerator, pool.withdrawalFeeDenominator, pool.totalLamports, pool.tokenSupply);
    if (redemption < minimumDelegation || redemption > amount(pool.totalLamports)) return { eligible: false, reason: 'withdrawal fails minimum delegation or pool capacity' };
    const required = requiredRedemptionLamports(config);
    return { eligible: redemption >= required, reason: redemption >= required ? 'eligible' : 'net surplus below required threshold', minimumRedemptionLamports: redemption.toString(), requiredRedemptionLamports: required.toString() };
  } catch (error) {
    return { eligible: false, reason: `invalid observation: ${error instanceof Error ? error.message : String(error)}` };
  }
}
