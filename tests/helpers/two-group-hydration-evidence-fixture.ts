/** Synthetic contract evidence, never a runtime metrics producer. */
export function twoGroupHydrationEvidenceFixture() {
  const role = () => ({ grants: 0, cancellations: 0,
    oldestWaitMs: null as number | null, lastWaitMs: null as number | null,
    maximumWaitMs: null as number | null });
  return {
    blockHydration: {
      version: 2 as const, enabled: true as const, configuredGroups: 2 as const,
      locates: 0, hits: 0, misses: 0, inFlightJoins: 0, fetches: 0,
      forcedRefreshes: 0, evictions: 0, oversizeBypasses: 0, fetchFailures: 0,
      epochInvalidations: 0, retainedEntries: 0, retainedBytes: 0,
      inFlightFetches: 0, queuedFetches: 0,
      queueDelayMs: { last: null as number | null, maximum: null as number | null },
      activeGroups: 0, maximumActiveGroups: 0, queuedGroups: 0,
      maximumQueuedGroups: 0, maximumInFlightFetches: 0,
      maximumQueuedFetches: 0, sameGroupJoins: 0,
      unsettledAfterCancel: 0, maximumUnsettledAfterCancel: 0,
    },
    blockHydrationAdmission: {
      version: 2 as const, enabled: true as const, configuredGroups: 2 as const,
      registeredWorkers: 1, pendingWorkers: 0, maximumPendingWorkers: 0,
      pendingClassifierGroups: 0, maximumPendingClassifierGroups: 0,
      unboundReservations: 0, activeGroups: 0, maximumAdmitted: 0,
      worker: role(), classifier: role(),
    },
    ordinaryRpcBudget: {
      version: 2 as const, enabled: true as const, windowMs: 1000 as const,
      maxAttemptsPerWindow: 8 as const, maxWaiters: 64 as const,
      startsInWindow: 0, maximumStartsInWindow: 0,
      queuedWaiters: 0, maximumQueuedWaiters: 0, localRejections: 0, closed: false,
    },
    blockResponseMemory: {
      version: 2 as const, perResponseLimitBytes: 33_554_432 as const,
      totalInFlightLimitBytes: 67_108_864 as const,
      activeBodies: 0, inFlightBytes: 0, maximumInFlightBytes: 0,
      oversizedResponses: 0, maximumRssBytes: 67_108_864,
    },
  };
}

export function stoppedTwoGroupHydrationEvidenceFixture() {
  const value = twoGroupHydrationEvidenceFixture();
  value.ordinaryRpcBudget.closed = true;
  return value;
}
