// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { MINT } from '../../tests/fixtures/api.js';
import type { ApiSseEvent } from './api-schemas.js';
import { invalidationKeysForEvent, queryKeys } from './query-keys.js';

const ALL_TYPES = [
  'TokenLaunchDetected', 'TokenMetadataResolved', 'TokenMetadataFailed',
  'SocialEvidenceCollected', 'CreatorProfileUpdated', 'HolderDistributionUpdated',
  'WalletClusterDetected', 'BondingCurveTradeObserved', 'BondingCurveStateUpdated',
  'BondingCurveCompleted', 'QualificationUpdated', 'TradingCandidateUpdated',
  'PaperStrategySessionUpdated', 'PaperExternalBuyCounted', 'PaperPositionOpened',
  'PaperPositionUpdated', 'PaperPositionClosed', 'MigrationObserved',
  'PumpSwapPoolActivated',
] as const;

function event(type: (typeof ALL_TYPES)[number]): ApiSseEvent {
  return {
    eventId: 'event-a', type, mint: MINT, source: 'test', program: 'pumpfun', signature: 'signature',
    cursor: { slot: '1', transactionIndex: '0', instructionIndex: '0', innerInstructionIndex: null },
    confirmationStatus: 'confirmed', blockchainTime: null, observedAt: '2026-08-11T00:00:00.000Z',
    payloadVersion: 1, payload: {},
  };
}

describe('event-driven query invalidation', () => {
  it.each(ALL_TYPES)('always invalidates radar, timeline, and only the matching detail for %s', (type) => {
    const keys = invalidationKeysForEvent(event(type));
    expect(keys).toContainEqual(queryKeys.launches.all);
    expect(keys).toContainEqual(queryKeys.launch(MINT));
    expect(keys).toContainEqual(queryKeys.events(MINT));
    expect(keys).not.toContainEqual(queryKeys.launch('22222222222222222222222222222222'));
  });

  it('invalidates each specialized projection only for relevant event families', () => {
    expect(invalidationKeysForEvent(event('SocialEvidenceCollected'))).toContainEqual(queryKeys.social(MINT));
    for (const type of ['CreatorProfileUpdated', 'HolderDistributionUpdated', 'WalletClusterDetected'] as const) {
      expect(invalidationKeysForEvent(event(type))).toContainEqual(queryKeys.holders(MINT));
    }
    expect(invalidationKeysForEvent(event('QualificationUpdated'))).toContainEqual(queryKeys.risk(MINT));
    for (const type of ['PaperPositionOpened', 'PaperPositionUpdated', 'PaperPositionClosed'] as const) {
      expect(invalidationKeysForEvent(event(type))).toContainEqual(queryKeys.paperPositions.all);
    }
    expect(invalidationKeysForEvent(event('TokenMetadataResolved'))).not.toContainEqual(queryKeys.social(MINT));
  });

  it('returns fresh arrays so callers cannot mutate shared cache keys', () => {
    expect(invalidationKeysForEvent(event('QualificationUpdated'))).not.toBe(
      invalidationKeysForEvent(event('QualificationUpdated')),
    );
  });
});
