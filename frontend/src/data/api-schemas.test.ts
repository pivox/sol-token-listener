// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  apiFailureSchema,
  apiHealthEnvelopeSchema,
  apiHoldersEnvelopeSchema,
  apiLaunchDetailEnvelopeSchema,
  apiLaunchListEnvelopeSchema,
  apiPaperPositionListEnvelopeSchema,
  apiQualificationEnvelopeSchema,
  apiSocialEnvelopeSchema,
  apiSseEventSchema,
  apiTimelineEnvelopeSchema,
  domainEventTypeSchema,
} from './api-schemas.js';
import {
  health,
  holdersAvailable,
  holdersUnavailable,
  launchDetail,
  launchSummary,
  paperPosition,
  qualification,
  socialAvailable,
  socialUnavailable,
  sseEvent,
  success,
  timelineEntry,
} from '../../tests/fixtures/api.js';

const DOMAIN_EVENT_TYPES = [
  'TokenLaunchDetected', 'TokenMetadataResolved', 'TokenMetadataFailed',
  'SocialEvidenceCollected', 'CreatorProfileUpdated', 'HolderDistributionUpdated',
  'WalletClusterDetected', 'BondingCurveTradeObserved', 'BondingCurveStateUpdated',
  'BondingCurveCompleted', 'QualificationUpdated', 'TradingCandidateUpdated',
  'PaperStrategySessionUpdated', 'PaperExternalBuyCounted', 'PaperPositionOpened',
  'PaperPositionUpdated', 'PaperPositionClosed', 'MigrationObserved',
  'PumpSwapPoolActivated',
] as const;

describe('frontend-owned API V1 schemas', () => {
  it('accepts every complete public projection fixture', () => {
    expect(apiLaunchListEnvelopeSchema.parse(success([launchSummary], 'cursor-a')).data).toHaveLength(1);
    expect(apiLaunchDetailEnvelopeSchema.parse(success(launchDetail)).data.mint).toBe(launchDetail.mint);
    expect(apiTimelineEnvelopeSchema.parse(success([timelineEntry])).data[0]?.type).toBe('QualificationUpdated');
    expect(apiQualificationEnvelopeSchema.parse(success(qualification)).data?.verdict).toBe('REJECTED');
    expect(apiSocialEnvelopeSchema.parse(success(socialAvailable)).data.status).toBe('AVAILABLE');
    expect(apiSocialEnvelopeSchema.parse(success(socialUnavailable)).data.status).toBe('NOT_AVAILABLE');
    expect(apiHoldersEnvelopeSchema.parse(success(holdersAvailable)).data.status).toBe('AVAILABLE');
    expect(apiHoldersEnvelopeSchema.parse(success(holdersUnavailable)).data.status).toBe('NOT_AVAILABLE');
    expect(apiPaperPositionListEnvelopeSchema.parse(success([paperPosition])).data[0]?.status).toBe('PAPER_CLOSED');
    expect(apiHealthEnvelopeSchema.parse(success(health)).data.status).toBe('DEGRADED');
    expect(apiSseEventSchema.parse(sseEvent).eventId).toBe(sseEvent.eventId);
  });

  it('accepts additive fields inside V1 domain objects but not envelopes', () => {
    expect(apiLaunchListEnvelopeSchema.parse(success([{ ...launchSummary, futureField: true }])).data[0]).toMatchObject({
      futureField: true,
    });
    expect(() => apiLaunchListEnvelopeSchema.parse({ ...success([launchSummary]), secret: 'unexpected' })).toThrow();
  });

  it.each(DOMAIN_EVENT_TYPES)('accepts the stable event type %s', (type) => {
    expect(domainEventTypeSchema.parse(type)).toBe(type);
    expect(apiSseEventSchema.parse({ ...sseEvent, type }).type).toBe(type);
  });

  it('rejects unsafe numeric and malformed financial representations', () => {
    expect(() => apiLaunchListEnvelopeSchema.parse(success([{ ...launchSummary, detectedSlot: 42 }]))).toThrow();
    expect(() => apiLaunchListEnvelopeSchema.parse(success([{ ...launchSummary, liquidityQuote: '1.5' }]))).toThrow();
    expect(() => apiPaperPositionListEnvelopeSchema.parse(success([{ ...paperPosition, quantity: 1.5 }]))).toThrow();
    expect(() => apiPaperPositionListEnvelopeSchema.parse(success([{ ...paperPosition, realizedPnlQuote: '1e3' }]))).toThrow();
  });

  it('rejects malformed timestamps, discriminators, and unknown enums', () => {
    expect(() => apiLaunchListEnvelopeSchema.parse(success([{ ...launchSummary, detectedAt: 'today' }]))).toThrow();
    expect(() => apiSocialEnvelopeSchema.parse(success({ status: 'NOT_AVAILABLE', links: [{}], evidence: [] }))).toThrow();
    expect(() => apiHoldersEnvelopeSchema.parse(success({ ...holdersUnavailable, status: 'EMPTY' }))).toThrow();
    expect(() => apiSseEventSchema.parse({ ...sseEvent, confirmationStatus: 'trusted' })).toThrow();
  });

  it('accepts stable public failures and rejects leaked fields', () => {
    expect(apiFailureSchema.parse({
      apiVersion: 'v1', error: { code: 'INVALID_CURSOR', message: 'The cursor is invalid' },
    }).error.code).toBe('INVALID_CURSOR');
    expect(() => apiFailureSchema.parse({
      apiVersion: 'v1', error: {
        code: 'INTERNAL_ERROR', message: 'Internal error', stack: 'database secret',
      },
    })).toThrow();
  });
});
