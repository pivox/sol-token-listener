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
  firstProcessingCanary,
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

function catchUpAdmissionMetrics() {
  return {
    version: 1, enabled: true, providerId: 'fallback-1', scanActive: true, workerClaimReady: false,
    actionableBacklogBySource: { websocketOnly: 1, catchUpOnly: 2, websocketAndCatchUp: 3 },
    actionableBacklogByPriority: { normal: 3, launchCandidate: 2, trackedTrade: 1 },
    deferredCount: 4, ignoredCount: 5, quarantinedCount: 6,
  };
}

function parseCatchUpAdmission(catchUpAdmission: unknown, backlogCount = 6) {
  return apiHealthEnvelopeSchema.parse(success({
    ...health, heartbeat: { ...health.heartbeat, catchUpAdmission, backlogCount },
  })).data;
}

function parseFirstProcessingCanary(value: unknown) {
  return apiHealthEnvelopeSchema.parse(success({
    ...health,
    heartbeat: { ...health.heartbeat, firstProcessingCanary: value },
  })).data.heartbeat.firstProcessingCanary;
}

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
  it('accepts PASS, FAIL and INCONCLUSIVE first-processing canary evidence', () => {
    expect(parseFirstProcessingCanary(firstProcessingCanary)?.verdict).toBe('PASS');
    expect(parseFirstProcessingCanary({
      ...firstProcessingCanary,
      eligibleCount: 1,
      completedCount: 1,
      underThresholdCount: 0,
      atOrAboveThresholdCount: 1,
      p95Ms: 45_000,
      verdict: 'FAIL',
    })?.verdict).toBe('FAIL');
    expect(parseFirstProcessingCanary({
      ...firstProcessingCanary,
      sampledAtMs: firstProcessingCanary.cohortEndsAtMs,
      verdict: 'INCONCLUSIVE',
    })?.verdict).toBe('INCONCLUSIVE');
    expect(parseFirstProcessingCanary({
      ...firstProcessingCanary,
      sampledAtMs: firstProcessingCanary.cohortStartedAtMs + 14_400_000,
      verdict: 'INCONCLUSIVE',
    })?.verdict).toBe('INCONCLUSIVE');
    expect(parseFirstProcessingCanary({
      ...firstProcessingCanary,
      sampledAtMs: firstProcessingCanary.cohortStartedAtMs + 14_400_000,
      eligibleCount: 4,
      invalidDurationCount: 1,
      verdict: 'FAIL',
    })?.verdict).toBe('FAIL');
  });

  it('keeps omitted first-processing evidence undefined and explicit absence null', () => {
    const heartbeat: Record<string, unknown> = { ...health.heartbeat };
    delete heartbeat.firstProcessingCanary;
    const legacy = apiHealthEnvelopeSchema.parse(success({ ...health, heartbeat })).data;

    expect(legacy.heartbeat.firstProcessingCanary).toBeUndefined();
    expect(parseFirstProcessingCanary(null)).toBeNull();
  });

  it('rejects hostile first-processing fields, totals and impossible verdicts', () => {
    const invalid: unknown[] = [
      { ...firstProcessingCanary, signature: 'secret-signature' },
      { ...firstProcessingCanary, mint: 'secret-mint' },
      { ...firstProcessingCanary, thresholdMs: 44_999 },
      { ...firstProcessingCanary, cohortCapacity: 49_999 },
      { ...firstProcessingCanary, cohortEndsAtMs: firstProcessingCanary.cohortEndsAtMs + 1 },
      { ...firstProcessingCanary, sampledAtMs: firstProcessingCanary.cohortStartedAtMs - 1 },
      { ...firstProcessingCanary, eligibleCount: -0 },
      { ...firstProcessingCanary, eligibleCount: Number.MAX_SAFE_INTEGER + 1 },
      { ...firstProcessingCanary, eligibleCount: 4 },
      { ...firstProcessingCanary, completedCount: 2 },
      { ...firstProcessingCanary, pendingCount: 1 },
      { ...firstProcessingCanary, p95Ms: null },
      { ...firstProcessingCanary, p95Ms: 45_000 },
      { ...firstProcessingCanary, verdict: 'FAIL' },
      {
        ...firstProcessingCanary,
        cohortStartedAtMs: Number.MAX_SAFE_INTEGER - 14_400_000 + 1,
        cohortEndsAtMs: Number.MAX_SAFE_INTEGER - 14_400_000 + 900_001,
        sampledAtMs: Number.MAX_SAFE_INTEGER,
        verdict: 'INCONCLUSIVE',
      },
      { ...firstProcessingCanary, overflowed: true },
    ];
    for (const field of Object.keys(firstProcessingCanary)) {
      invalid.push(Object.fromEntries(
        Object.entries(firstProcessingCanary).filter(([key]) => key !== field),
      ));
    }

    for (const candidate of invalid) {
      expect(() => parseFirstProcessingCanary(candidate)).toThrow();
    }
  });

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

  it('accepts catch-up admission V1 metrics and absent/null rolling-deployment fields', () => {
    const metrics = catchUpAdmissionMetrics();
    const parsed = parseCatchUpAdmission(metrics);
    expect(parsed.heartbeat.catchUpAdmission).toEqual(metrics);
    expectTypeOf(parsed.heartbeat.catchUpAdmission?.providerId).toEqualTypeOf<'primary' | 'fallback-1' | 'fallback-2' | 'fallback-3' | null | undefined>();
    expect(apiHealthEnvelopeSchema.parse(success(health)).data.heartbeat.catchUpAdmission).toBeUndefined();
    expect(parseCatchUpAdmission(null).heartbeat.catchUpAdmission).toBeNull();
    for (const providerId of ['primary', 'fallback-1', 'fallback-2', 'fallback-3', null]) {
      expect(parseCatchUpAdmission({ ...metrics, providerId, scanActive: false }).heartbeat.catchUpAdmission?.providerId).toBe(providerId);
    }
    expect(parseCatchUpAdmission({ ...metrics, enabled: false, providerId: null, scanActive: false }).heartbeat.catchUpAdmission?.enabled).toBe(false);
    const maximum = {
      ...metrics,
      actionableBacklogBySource: { websocketOnly: Number.MAX_SAFE_INTEGER, catchUpOnly: 0, websocketAndCatchUp: 0 },
      actionableBacklogByPriority: { normal: Number.MAX_SAFE_INTEGER, launchCandidate: 0, trackedTrade: 0 },
      deferredCount: Number.MAX_SAFE_INTEGER,
    };
    expect(parseCatchUpAdmission(maximum, Number.MAX_SAFE_INTEGER).heartbeat.catchUpAdmission).toEqual(maximum);
  });

  it('rejects malformed catch-up admission exact keys, states, bounded counts and sums', () => {
    const metrics = catchUpAdmissionMetrics();
    const invalid: unknown[] = [
      [], 'https://secret.invalid', { ...metrics, version: 2 },
      { ...metrics, enabled: 1 }, { ...metrics, scanActive: 'true' }, { ...metrics, workerClaimReady: 0 },
      { ...metrics, providerId: 'fallback-99' }, { ...metrics, providerId: 'https://secret.invalid' },
      { ...metrics, providerId: 'secret-signature' }, { ...metrics, providerId: 'secret-mint' },
      { ...metrics, rpcUrl: 'https://secret.invalid' }, { ...metrics, signature: 'secret-signature' },
      { ...metrics, mint: 'secret-mint' }, { ...metrics, workerClaimReady: true },
      { ...metrics, providerId: null }, { ...metrics, enabled: false },
      { ...metrics, actionableBacklogBySource: { ...metrics.actionableBacklogBySource, extra: 0 } },
      { ...metrics, actionableBacklogByPriority: { ...metrics.actionableBacklogByPriority, mint: 'secret-mint' } },
      { ...metrics, actionableBacklogBySource: { ...metrics.actionableBacklogBySource, websocketOnly: 2 } },
      { ...metrics, actionableBacklogByPriority: { ...metrics.actionableBacklogByPriority, normal: 4 } },
      { ...metrics, actionableBacklogBySource: { websocketOnly: Number.MAX_SAFE_INTEGER, catchUpOnly: 1, websocketAndCatchUp: 0 } },
    ];
    for (const count of [-1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1', 1n]) {
      for (const field of ['deferredCount', 'ignoredCount', 'quarantinedCount']) invalid.push({ ...metrics, [field]: count });
      for (const field of ['websocketOnly', 'catchUpOnly', 'websocketAndCatchUp']) {
        invalid.push({ ...metrics, actionableBacklogBySource: { ...metrics.actionableBacklogBySource, [field]: count } });
      }
      for (const field of ['normal', 'launchCandidate', 'trackedTrade']) {
        invalid.push({ ...metrics, actionableBacklogByPriority: { ...metrics.actionableBacklogByPriority, [field]: count } });
      }
    }
    for (const field of Object.keys(metrics)) {
      const incomplete = Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== field));
      invalid.push(incomplete);
    }
    for (const candidate of invalid) expect(() => parseCatchUpAdmission(candidate)).toThrow();
    expect(() => parseCatchUpAdmission(metrics, 7)).toThrow();
    for (const backlogCount of [null, undefined]) {
      expect(() => apiHealthEnvelopeSchema.parse(success({
        ...health, heartbeat: { ...health.heartbeat, catchUpAdmission: metrics, backlogCount },
      }))).toThrow();
    }
  });

  it('accepts the complete WebSocket diagnostic and an older backend without it', () => {
    const current = apiHealthEnvelopeSchema.parse(success(health)).data;
    expect(current.heartbeat.websocket).toEqual(health.heartbeat.websocket);
    expect(current.heartbeat.blockHydration).toEqual(health.heartbeat.blockHydration);

    const legacyHeartbeat: Record<string, unknown> = { ...health.heartbeat };
    delete legacyHeartbeat.websocket;
    delete legacyHeartbeat.blockHydration;
    legacyHeartbeat.lastSignature = 'legacy-backend-signature';
    const legacy = apiHealthEnvelopeSchema.parse(success({
      ...health,
      heartbeat: legacyHeartbeat,
    })).data;
    expect(legacy.heartbeat.websocket).toBeUndefined();
    expect(legacy.heartbeat.blockHydration).toBeUndefined();
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
    const maximumSlot = '9'.repeat(78);
    const maximum = apiHealthEnvelopeSchema.parse(success({
      ...health,
      heartbeat: {
        ...health.heartbeat,
        websocket: {
          ...websocket,
          lastObservation: { ...websocket.lastObservation, slot: maximumSlot },
        },
      },
    })).data;
    expect(maximum.heartbeat.websocket?.lastObservation?.slot).toBe(maximumSlot);

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
      { ...websocket, lastObservation: { ...websocket.lastObservation, slot: '01' } },
      { ...websocket, lastObservation: { ...websocket.lastObservation, slot: '9'.repeat(79) } },
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
