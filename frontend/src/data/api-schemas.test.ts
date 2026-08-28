// @vitest-environment node

import { describe, expect, expectTypeOf, it } from 'vitest';
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

  it('accepts creation strategy reasons and requires a stable pending exit reason', () => {
    const creation = {
      ...launchSummary,
      paperStrategy: {
        ...launchSummary.paperStrategy,
        strategyId: 'creation-entry-v1',
        reasonCode: 'SELL_QUOTE_UNAVAILABLE_OR_STALE',
        pendingExitReason: 'CREATOR_EARLY_SELL',
      },
    };
    expect(apiLaunchListEnvelopeSchema.parse(success([creation])).data[0]
      ?.paperStrategy?.pendingExitReason).toBe('CREATOR_EARLY_SELL');
    expect(() => apiLaunchListEnvelopeSchema.parse(success([{
      ...creation,
      paperStrategy: { ...creation.paperStrategy, pendingExitReason: 'UNSTABLE_REASON' },
    }]))).toThrow();
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

  it('requires bounded qualification health details', () => {
    const qualification = { currentCount: 3, lastSuccessAt: '2026-08-11T00:00:00.000Z' };
    const pipelineWithoutQualification: Record<string, unknown> = { ...health.pipeline };
    const healthWithoutQualification: Record<string, unknown> = { ...health };
    delete pipelineWithoutQualification.qualification;
    delete healthWithoutQualification.qualification;
    expect(apiHealthEnvelopeSchema.parse(success({
      ...health,
      pipeline: { ...health.pipeline, qualification: 'RUNNING' },
      qualification,
    })).data.qualification.currentCount).toBe(3);
    expect(() => apiHealthEnvelopeSchema.parse(success({
      ...health,
      pipeline: pipelineWithoutQualification,
      qualification,
    }))).toThrow();
    expect(() => apiHealthEnvelopeSchema.parse(success({
      ...healthWithoutQualification,
      pipeline: { ...health.pipeline, qualification: 'RUNNING' },
    }))).toThrow();
    expect(() => apiHealthEnvelopeSchema.parse(success({
      ...health,
      pipeline: { ...health.pipeline, qualification: 'RUNNING' },
      qualification: { currentCount: -1, lastSuccessAt: '2026-08-11T00:00:00.000Z' },
    }))).toThrow();
    expect(() => apiHealthEnvelopeSchema.parse(success({
      ...health,
      pipeline: { ...health.pipeline, qualification: 'RUNNING' },
      qualification: { currentCount: 3, lastSuccessAt: 'not-a-timestamp' },
    }))).toThrow();
  });

  it('accepts the complete WebSocket diagnostic and an older backend without it', () => {
    const current = apiHealthEnvelopeSchema.parse(success(health)).data;
    expect(current.heartbeat.websocket).toEqual(health.heartbeat.websocket);

    const legacyHeartbeat: Record<string, unknown> = { ...health.heartbeat };
    delete legacyHeartbeat.websocket;
    legacyHeartbeat.lastSignature = 'legacy-backend-signature';
    const legacy = apiHealthEnvelopeSchema.parse(success({
      ...health,
      heartbeat: legacyHeartbeat,
    })).data;
    expect(legacy.heartbeat.websocket).toBeUndefined();
  });

  it('keeps hostile additive WebSocket fields opaque in the inferred client contract', () => {
    const decoded = apiHealthEnvelopeSchema.parse(success({
      ...health,
      heartbeat: {
        ...health.heartbeat,
        websocket: {
          ...health.heartbeat.websocket,
          rpcUrl: 'https://secret-rpc.invalid/key',
          signature: 'secret-signature',
          ownerGeneration: '9223372036854775807',
        },
      },
    })).data;

    expect(decoded.heartbeat.websocket?.state).toBe('DEGRADED');
    expectTypeOf(decoded.heartbeat.websocket?.rpcUrl).toEqualTypeOf<unknown>();
    expectTypeOf(decoded.heartbeat.websocket?.signature).toEqualTypeOf<unknown>();
    expectTypeOf(decoded.heartbeat.websocket?.ownerGeneration).toEqualTypeOf<unknown>();
  });

  it('strictly validates every known WebSocket enum, timestamp, and slot', () => {
    const websocket = health.heartbeat.websocket;
    const invalidWebSockets: readonly Record<string, unknown>[] = [
      { ...websocket, version: 2 },
      { ...websocket, supervision: 'ENABLED' },
      { ...websocket, state: 'UNKNOWN' },
      { ...websocket, phase: 'ROTATING' },
      { ...websocket, providerId: 'https://secret-rpc.invalid' },
      { ...websocket, candidateProviderId: 'fallback-99' },
      { ...websocket, updatedAt: 'today' },
      { ...websocket, heartbeatAt: 'today' },
      { ...websocket, acknowledgedAt: 'today' },
      { ...websocket, lastObservation: { ...websocket.lastObservation, observedAt: 'today' } },
      { ...websocket, lastObservation: { ...websocket.lastObservation, slot: '-1' } },
      { ...websocket, disconnect: { ...websocket.disconnect, occurredAt: 'today' } },
      { ...websocket, disconnect: { ...websocket.disconnect, reasonCode: 'RAW_REMOTE_REASON' } },
      { ...websocket, recovery: { ...websocket.recovery, status: 'DONE' } },
      { ...websocket, recovery: { ...websocket.recovery, startedAt: 'today' } },
      { ...websocket, recovery: { ...websocket.recovery, completedAt: 'today' } },
      { ...websocket, recovery: { ...websocket.recovery, reasonCode: 'STACK_TRACE' } },
    ];

    for (const invalidWebsocket of invalidWebSockets) {
      expect(() => apiHealthEnvelopeSchema.parse(success({
        ...health,
        heartbeat: { ...health.heartbeat, websocket: invalidWebsocket },
      }))).toThrow();
    }
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
