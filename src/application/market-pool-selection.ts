export interface TrackedPoolCandidate {
  readonly poolAddress: string;
  readonly baseMint: string;
  readonly engaged: boolean;
  readonly activatedAtMs: number;
  readonly activationSignature: string;
  readonly activationSlot: bigint;
}

export interface TrackedPoolSelectionOptions {
  readonly nowMs: number;
  readonly windowMs: number;
  readonly maxPools: number;
}

export interface TrackedPoolSelection {
  readonly tracked: readonly TrackedPoolCandidate[];
  readonly droppedByCap: readonly TrackedPoolCandidate[];
}

// Engaged pools (paper session or open live position) are never dropped: losing their trade feed
// would blind an exposed position. The cap only trims window-only pools, oldest first.
export function selectTrackedPools(
  candidates: readonly TrackedPoolCandidate[],
  options: TrackedPoolSelectionOptions,
): TrackedPoolSelection {
  if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0
    || !Number.isSafeInteger(options.windowMs) || options.windowMs < 0
    || !Number.isSafeInteger(options.maxPools) || options.maxPools < 1) {
    throw new TypeError('Tracked pool selection options are invalid.');
  }
  const engaged = candidates.filter((pool) => pool.engaged);
  const windowOnly = candidates
    .filter((pool) => !pool.engaged && options.nowMs - pool.activatedAtMs < options.windowMs)
    .sort((left, right) => right.activatedAtMs - left.activatedAtMs
      || left.poolAddress.localeCompare(right.poolAddress));
  const room = Math.max(0, options.maxPools - engaged.length);
  return Object.freeze({
    tracked: Object.freeze([...engaged, ...windowOnly.slice(0, room)]),
    droppedByCap: Object.freeze(windowOnly.slice(room)),
  });
}
