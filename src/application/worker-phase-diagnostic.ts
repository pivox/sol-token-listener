export type WorkerDiagnosticPhase =
  | 'claim_call' | 'claim_setup' | 'locator' | 'snapshot_and_ownership' | 'pipeline' | 'completion';
export type WorkerAttemptOutcome = 'processed' | 'failed' | 'lease-lost' | 'exceptional';
export type WorkerClaimOutcome = 'claimed' | 'idle' | 'exceptional';

export interface WorkerPhaseDiagnosticObserver {
  beginPhase(phase: WorkerDiagnosticPhase): () => void;
  beginAttempt(): (outcome: WorkerAttemptOutcome) => void;
  recordClaimOutcome(outcome: WorkerClaimOutcome): void;
  recordSnapshotReuse(): void;
}

const BUCKET_BOUNDS = Object.freeze([1, 5, 10, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000]);

interface DurationAggregate {
  entered: number;
  exited: number;
  active: number;
  count: number;
  sumMs: number;
  maxMs: number;
  invalid: number;
  buckets: number[];
}

export type WorkerDurationSnapshot = Readonly<Omit<DurationAggregate, 'buckets'>> & {
  readonly buckets: readonly number[];
};

export interface WorkerPhaseDiagnosticSnapshot {
  readonly version: 1;
  readonly scope: 'ALL_WORKER_ATTEMPTS_PROCESS_LIFETIME';
  readonly bucketUpperBoundsMs: readonly number[];
  readonly phases: Readonly<Record<WorkerDiagnosticPhase, WorkerDurationSnapshot>>;
  readonly totalAttempt: WorkerDurationSnapshot;
  readonly claimOutcomes: Readonly<Record<WorkerClaimOutcome, number>>;
  readonly attemptOutcomes: Readonly<Record<WorkerAttemptOutcome, number>>;
  readonly snapshotReuse: number;
  readonly overflow: boolean;
}

function emptyDuration(): DurationAggregate {
  return { entered: 0, exited: 0, active: 0, count: 0, sumMs: 0, maxMs: 0, invalid: 0,
    buckets: Array<number>(BUCKET_BOUNDS.length + 1).fill(0) };
}

function snapshotDuration(value: DurationAggregate): WorkerDurationSnapshot {
  return Object.freeze({ ...value, buckets: Object.freeze([...value.buckets]) });
}

/** Process-local, fixed-cardinality diagnostics. It never retains attempt identifiers or samples. */
export class WorkerPhaseDiagnosticRecorder implements WorkerPhaseDiagnosticObserver {
  private readonly phases = {
    claim_call: emptyDuration(), claim_setup: emptyDuration(), locator: emptyDuration(),
    snapshot_and_ownership: emptyDuration(), pipeline: emptyDuration(), completion: emptyDuration(),
  };
  private readonly totalAttempt = emptyDuration();
  private readonly claimOutcomes = { claimed: 0, idle: 0, exceptional: 0 };
  private readonly attemptOutcomes = { processed: 0, failed: 0, 'lease-lost': 0, exceptional: 0 };
  private snapshotReuse = 0;
  private overflow = false;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  beginPhase(phase: WorkerDiagnosticPhase): () => void {
    return this.beginDuration(this.phases[phase]);
  }

  beginAttempt(): (outcome: WorkerAttemptOutcome) => void {
    const finish = this.beginDuration(this.totalAttempt);
    let finished = false;
    return outcome => {
      if (finished) return;
      finished = true;
      finish();
      this.attemptOutcomes[outcome] = this.add(this.attemptOutcomes[outcome], 1);
    };
  }

  recordClaimOutcome(outcome: WorkerClaimOutcome): void {
    this.claimOutcomes[outcome] = this.add(this.claimOutcomes[outcome], 1);
  }

  recordSnapshotReuse(): void {
    this.snapshotReuse = this.add(this.snapshotReuse, 1);
  }

  snapshot(): WorkerPhaseDiagnosticSnapshot {
    return Object.freeze({
      version: 1, scope: 'ALL_WORKER_ATTEMPTS_PROCESS_LIFETIME', bucketUpperBoundsMs: BUCKET_BOUNDS,
      phases: Object.freeze({
        claim_call: snapshotDuration(this.phases.claim_call),
        claim_setup: snapshotDuration(this.phases.claim_setup),
        locator: snapshotDuration(this.phases.locator),
        snapshot_and_ownership: snapshotDuration(this.phases.snapshot_and_ownership),
        pipeline: snapshotDuration(this.phases.pipeline),
        completion: snapshotDuration(this.phases.completion),
      }),
      totalAttempt: snapshotDuration(this.totalAttempt),
      claimOutcomes: Object.freeze({ ...this.claimOutcomes }),
      attemptOutcomes: Object.freeze({ ...this.attemptOutcomes }),
      snapshotReuse: this.snapshotReuse, overflow: this.overflow,
    });
  }

  private add(current: number, increment: number): number {
    if (increment > Number.MAX_SAFE_INTEGER - current) {
      this.overflow = true;
      return Number.MAX_SAFE_INTEGER;
    }
    return current + increment;
  }

  private readClock(): number {
    try { return this.clock(); } catch { return NaN; }
  }

  private beginDuration(aggregate: DurationAggregate): () => void {
    aggregate.entered = this.add(aggregate.entered, 1);
    aggregate.active = this.add(aggregate.active, 1);
    const started = this.readClock();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const ended = this.readClock();
      aggregate.exited = this.add(aggregate.exited, 1);
      aggregate.active = Math.max(0, aggregate.active - 1);
      // Round up so a positive sub-ms sample cannot masquerade as zero latency.
      const duration = Math.ceil(ended - started);
      if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started || !Number.isSafeInteger(duration)) {
        aggregate.invalid = this.add(aggregate.invalid, 1);
        return;
      }
      aggregate.count = this.add(aggregate.count, 1);
      aggregate.sumMs = this.add(aggregate.sumMs, duration);
      aggregate.maxMs = Math.max(aggregate.maxMs, duration);
      const index = BUCKET_BOUNDS.findIndex(bound => duration <= bound);
      const bucket = index === -1 ? BUCKET_BOUNDS.length : index;
      aggregate.buckets[bucket] = this.add(aggregate.buckets[bucket] ?? 0, 1);
    };
  }
}
