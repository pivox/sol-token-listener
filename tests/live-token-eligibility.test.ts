import assert from 'node:assert/strict';
import test from 'node:test';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { assessLiveTokenEligibility } from '../src/live/live-token-eligibility.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';

const common = {
  mint: 'mint', quoteMint: 'So11111111111111111111111111111111111111112',
  quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(), nowMs: 10_000, maximumAgeMs: 2_000,
  evidence: { mint: 'mint', tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), owner: PUMP_PROGRAM_ID,
    layout: 'pump-sdk-1.36-bonding-curve-v2-holder-reward' as const, slot: 77n, receivedAtMs: 9_500,
    source: 'validated_getMultipleAccounts_same_slot' as const, isCashbackCoin: false as boolean | null,
    isHolderReward: true as boolean | null, mintExtensions: ['MetadataPointer'] as readonly string[] | null },
};

void test('admits Token-2022 create_v2 holder-reward coin only with fresh decoded non-cashback evidence', () => {
  const result = assessLiveTokenEligibility(common);
  assert.equal(result.status, 'ACCEPTED');
  if (result.status === 'ACCEPTED') {
    assert.equal(result.profileId, 'pumpfun-v2-to-pumpswap-sol-spl-or-token2022-metadata-only-v1');
    assert.equal(result.evidence.isHolderReward, true);
  }
});

void test('rejects cashback, unknown flags, stale state and unsupported token pair explicitly', () => {
  const denied = [
    assessLiveTokenEligibility({ ...common, evidence: { ...common.evidence, isCashbackCoin: true } }),
    assessLiveTokenEligibility({ ...common, evidence: { ...common.evidence, isCashbackCoin: null } }),
    assessLiveTokenEligibility({ ...common, evidence: { ...common.evidence, receivedAtMs: 7_999 } }),
    assessLiveTokenEligibility({ ...common, quoteTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() }),
    assessLiveTokenEligibility({ ...common, evidence: { ...common.evidence, tokenProgram: 'unknown' } }),
    assessLiveTokenEligibility({ ...common, evidence: { ...common.evidence, mintExtensions: ['TransferFeeConfig'] } }),
  ];
  assert.deepEqual(denied.map((item) => item.status), Array(6).fill('REJECTED'));
});
