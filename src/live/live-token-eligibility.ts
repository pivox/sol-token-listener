import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';

export type PumpCurveLayout = 'pump-sdk-1.36-bonding-curve-v2' | 'pump-sdk-1.36-bonding-curve-v2-holder-reward' | 'unsupported';
export interface PumpCurveAdmissionEvidence {
  readonly mint: string;
  readonly tokenProgram: string;
  readonly owner: string;
  readonly layout: PumpCurveLayout;
  readonly slot: bigint;
  readonly receivedAtMs: number;
  readonly source: 'validated_getMultipleAccounts_same_slot';
  readonly isCashbackCoin: boolean | null;
  readonly isHolderReward: boolean | null;
  readonly mintExtensions: readonly string[] | null;
}

export type LiveTokenEligibility =
  | { readonly status: 'ACCEPTED'; readonly profileId: string; readonly evidence: PumpCurveAdmissionEvidence; readonly characteristics: Readonly<{ cashback: false; holderReward: boolean }> }
  | { readonly status: 'REJECTED'; readonly reason: string; readonly evidence: PumpCurveAdmissionEvidence };

export const INITIAL_LIVE_CAPABILITY_PROFILE = 'pumpfun-v2-to-pumpswap-sol-spl-or-token2022-metadata-only-v1';
export const SUPPORTED_PUMP_CREATE_V2_TOKEN2022_EXTENSIONS = Object.freeze(['MetadataPointer', 'TokenMetadata']);

/** Fail-closed admission based on the exact fresh curve and mint account snapshot used by quoteAndState. */
export function assessLiveTokenEligibility(input: {
  readonly mint: string;
  readonly quoteMint: string;
  readonly quoteTokenProgram: string;
  readonly nowMs: number;
  readonly maximumAgeMs: number;
  readonly evidence: PumpCurveAdmissionEvidence;
}): LiveTokenEligibility {
  const evidence = input.evidence;
  const reject = (reason: string): LiveTokenEligibility => Object.freeze({ status: 'REJECTED', reason, evidence });
  if (evidence.mint !== input.mint || evidence.owner !== PUMP_PROGRAM_ID) return reject('curve identity or owner mismatch');
  if (evidence.layout === 'unsupported' || evidence.isCashbackCoin === null || evidence.isHolderReward === null) {
    return reject('bonding curve layout or admission characteristics are unknown');
  }
  if (evidence.mintExtensions === null) return reject('base mint extensions are unknown or cannot be decoded');
  if (evidence.mintExtensions.some((extension) => !SUPPORTED_PUMP_CREATE_V2_TOKEN2022_EXTENSIONS.includes(extension))) {
    return reject('base mint has a Token-2022 extension outside the supported metadata-only profile');
  }
  if (evidence.slot <= 0n || !Number.isSafeInteger(evidence.receivedAtMs) || evidence.receivedAtMs > input.nowMs
    || input.nowMs - evidence.receivedAtMs > input.maximumAgeMs) return reject('bonding curve evidence is stale or has an invalid slot/time');
  if (evidence.isCashbackCoin) return reject('cashback coins are excluded from the initial live profile');
  if (evidence.tokenProgram !== TOKEN_PROGRAM_ID.toBase58() && evidence.tokenProgram !== TOKEN_2022_PROGRAM_ID.toBase58()) {
    return reject('base mint Token Program is unsupported');
  }
  if (input.quoteMint !== 'So11111111111111111111111111111111111111112'
    || (input.quoteTokenProgram !== 'SPL_TOKEN' && input.quoteTokenProgram !== TOKEN_PROGRAM_ID.toBase58())) {
    return reject('only native SOL/wSOL with legacy SPL quote token is supported');
  }
  return Object.freeze({ status: 'ACCEPTED', profileId: INITIAL_LIVE_CAPABILITY_PROFILE,
    evidence, characteristics: Object.freeze({ cashback: false, holderReward: evidence.isHolderReward }) });
}
