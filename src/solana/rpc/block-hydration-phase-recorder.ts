import {
  createRuntimeBlockHydrationPhaseEvidence,
  type RuntimeBlockHydrationPhaseEvidenceV1,
} from '../../domain/block-hydration-phase-evidence.js';

const BUCKET_UPPER_BOUNDS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, Infinity] as const;

interface Cell {
  started: number;
  completed: number;
  failed: number;
  inFlight: number;
  maxInFlight: number;
  settledLatencyBuckets: number[];
  maxSettledLatencyMs: number;
}

export interface BlockHydrationPhaseRecorder {
  begin(phase: 'rpc' | 'snapshot'): (outcome: 'completed' | 'failed') => void;
  snapshot(): RuntimeBlockHydrationPhaseEvidenceV1 | null;
}

export function createBlockHydrationPhaseRecorder(
  options: { now?: () => number } = {},
): BlockHydrationPhaseRecorder {
  const now = options.now ?? ((): number => performance.now());
  const emptyCell = (): Cell => ({
    started: 0, completed: 0, failed: 0, inFlight: 0, maxInFlight: 0,
    settledLatencyBuckets: Array<number>(BUCKET_UPPER_BOUNDS.length).fill(0), maxSettledLatencyMs: 0,
  });
  const cells = { rpc: emptyCell(), snapshot: emptyCell() };
  let overflowed = false;
  let started = false;
  const increment = (value: number): number => {
    if (value >= Number.MAX_SAFE_INTEGER) {
      overflowed = true;
      return Number.MAX_SAFE_INTEGER;
    }
    return value + 1;
  };
  const readTime = (): number => {
    try {
      const time = now();
      if (typeof time !== 'number' || !Number.isFinite(time)) {
        overflowed = true;
        return NaN;
      }
      return time;
    } catch {
      overflowed = true;
      return NaN;
    }
  };
  return {
    begin(phase) {
      const cell = cells[phase];
      const start = readTime();
      started = true;
      cell.started = increment(cell.started);
      cell.inFlight = increment(cell.inFlight);
      cell.maxInFlight = Math.max(cell.maxInFlight, cell.inFlight);
      let settled = false;
      return (outcome) => {
        if (settled) return;
        settled = true;
        cell.inFlight = Math.max(0, cell.inFlight - 1);
        cell[outcome] = increment(cell[outcome]);
        const elapsed = readTime() - start;
        if (Number.isNaN(elapsed) || elapsed < 0) {
          overflowed = true;
          return;
        }
        if (elapsed > Number.MAX_SAFE_INTEGER) overflowed = true;
        const duration = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(elapsed));
        const bucket = BUCKET_UPPER_BOUNDS.findIndex((upper) => duration <= upper);
        cell.settledLatencyBuckets[bucket] = increment(cell.settledLatencyBuckets[bucket] ?? 0);
        cell.maxSettledLatencyMs = Math.max(cell.maxSettledLatencyMs, duration);
      };
    },
    snapshot(): RuntimeBlockHydrationPhaseEvidenceV1 | null {
      if (!started) return null;
      return createRuntimeBlockHydrationPhaseEvidence({
        version: 1, overflowed, rpc: cells.rpc, snapshot: cells.snapshot,
      });
    },
  };
}
