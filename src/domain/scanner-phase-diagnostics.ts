import { isProxy } from 'node:util/types';
import { RPC_PROVIDER_IDS } from './rpc-provider.js';

export const SCANNER_DIAGNOSTIC_PHASES = Object.freeze([
  'SOURCE_PAGE', 'COVERAGE_READ', 'BLOCK_HYDRATE', 'CLASSIFICATION_WRITE',
  'PAGE_ADMIT', 'RUN_PROGRESS', 'CHECKPOINT', 'SUPERVISOR',
] as const);
export const SCANNER_DIAGNOSTIC_OUTCOMES = Object.freeze([
  'OK', 'ERROR', 'PAUSED', 'REFRESH_REQUIRED', 'ABORTED',
] as const);
export const SCANNER_DIAGNOSTIC_PROVIDERS = RPC_PROVIDER_IDS;
export const SCANNER_DIAGNOSTIC_PROGRAMS = Object.freeze(['pumpfun', 'pumpswap'] as const);
export const SCANNER_DIAGNOSTIC_CODES = Object.freeze([
  'UNKNOWN',
  'SOURCE_REQUEST', 'SOURCE_RESPONSE', 'SOURCE_PAGINATION',
  'INVALID_INPUT', 'INVALID_CLOCK', 'LOCATOR_RETRYABLE', 'LOCATOR_UNTRUSTED',
  'LOCATOR_UNSUPPORTED_FAILURE', 'TRANSACTION_IDENTITY_MISMATCH',
  'TRANSACTION_OUTCOME_MISMATCH', 'DECODER_UNTRUSTED', 'INVALID_RECEIPT',
  'INVALID_PROGRAM', 'INVALID_PAGE', 'INVALID_RECEIPTS',
  'PROVIDER_AFFINITY', 'CHECKPOINT_READ', 'SOURCE', 'ENQUEUE', 'PAGE_ADMIT',
  'CHECKPOINT_CAS', 'FAILURE_WRITE', 'FAILURE_RESOLVE', 'RUN_READ',
  'RUN_CREATE', 'RUN_PROGRESS', 'RUN_COMPLETE', 'RUN_FAIL', 'RUN_SUPERSEDE',
  'CATCH_UP_WINDOW_EXCEEDED', 'CATCH_UP_PAGE_BUDGET_EXHAUSTED',
  'CATCH_UP_REFRESH_REQUIRED', 'RPC_UNAVAILABLE',
] as const);

export type ScannerDiagnosticPhase = (typeof SCANNER_DIAGNOSTIC_PHASES)[number];
export type ScannerDiagnosticOutcome = (typeof SCANNER_DIAGNOSTIC_OUTCOMES)[number];
export type ScannerDiagnosticProvider = (typeof SCANNER_DIAGNOSTIC_PROVIDERS)[number];
export type ScannerDiagnosticProgram = (typeof SCANNER_DIAGNOSTIC_PROGRAMS)[number];
export type ScannerDiagnosticCode = (typeof SCANNER_DIAGNOSTIC_CODES)[number];

export interface ScannerPhaseDiagnosticBucketV1 {
  readonly provider: ScannerDiagnosticProvider;
  readonly program: ScannerDiagnosticProgram;
  readonly phase: ScannerDiagnosticPhase;
  readonly count: number;
  readonly totalDurationMs: number;
  readonly maxDurationMs: number;
  readonly lastOutcome: ScannerDiagnosticOutcome;
  readonly lastCode: ScannerDiagnosticCode | null;
}

export interface ScannerPhaseDiagnosticFrontV1 {
  readonly program: ScannerDiagnosticProgram;
  readonly progressCount: number;
  readonly completedCount: number;
  readonly lastProgressAgeMs: number | null;
  readonly checkpointAdvanced: boolean;
}

export interface ScannerPhaseDiagnosticsV1 {
  readonly version: 1;
  readonly sampledAtMs: number;
  readonly unavailable: boolean;
  readonly overflow: boolean;
  readonly buckets: readonly ScannerPhaseDiagnosticBucketV1[];
  readonly fronts: readonly ScannerPhaseDiagnosticFrontV1[];
}

export interface ScannerPhaseEvent {
  readonly provider: ScannerDiagnosticProvider;
  readonly program: ScannerDiagnosticProgram;
  readonly phase: ScannerDiagnosticPhase;
  readonly durationMs: number;
  readonly outcome: ScannerDiagnosticOutcome;
  readonly code: ScannerDiagnosticCode | null;
}

export interface ScannerFrontEvent {
  readonly program: ScannerDiagnosticProgram;
  readonly kind: 'PROGRESS' | 'COMPLETE' | 'CHECKPOINT_ADVANCED';
  readonly atMs: number;
}

const MAX_DATE_MS = 8_640_000_000_000_000;
const SNAPSHOT_KEYS = ['version', 'sampledAtMs', 'unavailable', 'overflow', 'buckets', 'fronts'] as const;
const BUCKET_KEYS = [
  'provider', 'program', 'phase', 'count', 'totalDurationMs', 'maxDurationMs',
  'lastOutcome', 'lastCode',
] as const;
const FRONT_KEYS = [
  'program', 'progressCount', 'completedCount', 'lastProgressAgeMs', 'checkpointAdvanced',
] as const;
const PHASE_EVENT_KEYS = ['provider', 'program', 'phase', 'durationMs', 'outcome', 'code'] as const;
const FRONT_EVENT_KEYS = ['program', 'kind', 'atMs'] as const;
const MAX_BUCKETS = SCANNER_DIAGNOSTIC_PROVIDERS.length
  * SCANNER_DIAGNOSTIC_PROGRAMS.length * SCANNER_DIAGNOSTIC_PHASES.length;

/** Strict copy of an aggregate diagnostic. No arbitrary strings or errors cross this boundary. */
export function snapshotScannerPhaseDiagnostics(input: unknown): ScannerPhaseDiagnosticsV1 {
  try {
    const value = exactRecord(input, SNAPSHOT_KEYS);
    if (value.version !== 1 || typeof value.unavailable !== 'boolean'
      || typeof value.overflow !== 'boolean') throw invalid();
    const sampledAtMs = integer(value.sampledAtMs, MAX_DATE_MS);
    const rawBuckets = exactArray(value.buckets, MAX_BUCKETS);
    const buckets: ScannerPhaseDiagnosticBucketV1[] = [];
    const seenBuckets = new Set<string>();
    for (const rawBucket of rawBuckets) {
      const bucket = exactRecord(rawBucket, BUCKET_KEYS);
      const provider = finite(bucket.provider, SCANNER_DIAGNOSTIC_PROVIDERS);
      const program = finite(bucket.program, SCANNER_DIAGNOSTIC_PROGRAMS);
      const phase = finite(bucket.phase, SCANNER_DIAGNOSTIC_PHASES);
      const key = `${provider}:${program}:${phase}`;
      if (seenBuckets.has(key)) throw invalid();
      seenBuckets.add(key);
      const count = integer(bucket.count);
      const totalDurationMs = integer(bucket.totalDurationMs);
      const maxDurationMs = integer(bucket.maxDurationMs);
      if (count === 0 || maxDurationMs > totalDurationMs) throw invalid();
      const lastOutcome = finite(bucket.lastOutcome, SCANNER_DIAGNOSTIC_OUTCOMES);
      const lastCode = codeForOutcome(lastOutcome, bucket.lastCode);
      buckets.push(Object.freeze({
        provider, program, phase, count, totalDurationMs, maxDurationMs,
        lastOutcome, lastCode,
      }));
    }
    const rawFronts = exactArray(value.fronts, SCANNER_DIAGNOSTIC_PROGRAMS.length);
    if (rawFronts.length !== SCANNER_DIAGNOSTIC_PROGRAMS.length) throw invalid();
    const fronts: ScannerPhaseDiagnosticFrontV1[] = [];
    for (const [index, rawFront] of rawFronts.entries()) {
      const front = exactRecord(rawFront, FRONT_KEYS);
      const program = finite(front.program, SCANNER_DIAGNOSTIC_PROGRAMS);
      if (program !== SCANNER_DIAGNOSTIC_PROGRAMS[index]) throw invalid();
      const progressCount = integer(front.progressCount);
      const completedCount = integer(front.completedCount);
      const lastProgressAgeMs = front.lastProgressAgeMs === null
        ? null : integer(front.lastProgressAgeMs, sampledAtMs);
      if ((progressCount === 0) !== (lastProgressAgeMs === null)
        || typeof front.checkpointAdvanced !== 'boolean') throw invalid();
      fronts.push(Object.freeze({
        program, progressCount, completedCount, lastProgressAgeMs,
        checkpointAdvanced: front.checkpointAdvanced,
      }));
    }
    return Object.freeze({
      version: 1, sampledAtMs, unavailable: value.unavailable,
      overflow: value.overflow, buckets: Object.freeze(buckets), fronts: Object.freeze(fronts),
    });
  } catch {
    throw invalid();
  }
}

interface MutableBucket {
  provider: ScannerDiagnosticProvider;
  program: ScannerDiagnosticProgram;
  phase: ScannerDiagnosticPhase;
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastOutcome: ScannerDiagnosticOutcome;
  lastCode: ScannerDiagnosticCode | null;
}

interface MutableFront {
  program: ScannerDiagnosticProgram;
  progressCount: number;
  completedCount: number;
  lastProgressAtMs: number | null;
  checkpointAdvanced: boolean;
}

/** A process-local lifetime aggregate; no RPC, persistence, cursor or raw-error access. */
export class ScannerPhaseDiagnosticsCollector {
  private readonly buckets = new Map<string, MutableBucket>();
  private readonly fronts = new Map<ScannerDiagnosticProgram, MutableFront>(
    SCANNER_DIAGNOSTIC_PROGRAMS.map(program => [program, {
      program, progressCount: 0, completedCount: 0,
      lastProgressAtMs: null, checkpointAdvanced: false,
    }]),
  );
  private overflow = false;
  private unavailable = false;

  public static fromSnapshot(input: unknown): ScannerPhaseDiagnosticsCollector {
    const snapshot = snapshotScannerPhaseDiagnostics(input);
    const collector = new ScannerPhaseDiagnosticsCollector();
    collector.overflow = snapshot.overflow;
    collector.unavailable = snapshot.unavailable;
    for (const bucket of snapshot.buckets) {
      collector.buckets.set(bucketKey(bucket.provider, bucket.program, bucket.phase), { ...bucket });
    }
    for (const front of snapshot.fronts) {
      collector.fronts.set(front.program, {
        program: front.program,
        progressCount: front.progressCount,
        completedCount: front.completedCount,
        lastProgressAtMs: front.lastProgressAgeMs === null
          ? null : snapshot.sampledAtMs - front.lastProgressAgeMs,
        checkpointAdvanced: false,
      });
    }
    return collector;
  }

  public recordPhase(input: ScannerPhaseEvent): void {
    const event = exactRecord(input, PHASE_EVENT_KEYS);
    const provider = finite(event.provider, SCANNER_DIAGNOSTIC_PROVIDERS);
    const program = finite(event.program, SCANNER_DIAGNOSTIC_PROGRAMS);
    const phase = finite(event.phase, SCANNER_DIAGNOSTIC_PHASES);
    const durationMs = integer(event.durationMs);
    const outcome = finite(event.outcome, SCANNER_DIAGNOSTIC_OUTCOMES);
    const code = codeForOutcome(outcome, event.code);
    const key = bucketKey(provider, program, phase);
    const current = this.buckets.get(key);
    if (current === undefined) {
      this.buckets.set(key, {
        provider, program, phase, count: 1, totalDurationMs: durationMs,
        maxDurationMs: durationMs, lastOutcome: outcome, lastCode: code,
      });
      return;
    }
    const count = saturatingAdd(current.count, 1);
    const totalDurationMs = saturatingAdd(current.totalDurationMs, durationMs);
    this.overflow ||= count.overflow || totalDurationMs.overflow;
    current.count = count.value;
    current.totalDurationMs = totalDurationMs.value;
    current.maxDurationMs = Math.max(current.maxDurationMs, durationMs);
    current.lastOutcome = outcome;
    current.lastCode = code;
  }

  public recordFront(input: ScannerFrontEvent): void {
    const event = exactRecord(input, FRONT_EVENT_KEYS);
    const program = finite(event.program, SCANNER_DIAGNOSTIC_PROGRAMS);
    const kind = finite(event.kind, ['PROGRESS', 'COMPLETE', 'CHECKPOINT_ADVANCED'] as const);
    const atMs = integer(event.atMs, MAX_DATE_MS);
    const front = this.fronts.get(program);
    if (front === undefined) throw invalid();
    if (kind === 'PROGRESS') {
      if (front.lastProgressAtMs !== null && atMs < front.lastProgressAtMs) throw invalid();
      const next = saturatingAdd(front.progressCount, 1);
      this.overflow ||= next.overflow;
      front.progressCount = next.value;
      front.lastProgressAtMs = atMs;
    } else if (kind === 'COMPLETE') {
      const next = saturatingAdd(front.completedCount, 1);
      this.overflow ||= next.overflow;
      front.completedCount = next.value;
    } else {
      front.checkpointAdvanced = true;
    }
  }

  public markUnavailable(): void {
    this.unavailable = true;
  }

  public snapshot(sampledAtMs: number): ScannerPhaseDiagnosticsV1 {
    integer(sampledAtMs, MAX_DATE_MS);
    const fronts = SCANNER_DIAGNOSTIC_PROGRAMS.map(program => {
      const front = this.fronts.get(program);
      if (front === undefined) throw invalid();
      if (front.lastProgressAtMs !== null && front.lastProgressAtMs > sampledAtMs) throw invalid();
      return {
        program, progressCount: front.progressCount, completedCount: front.completedCount,
        lastProgressAgeMs: front.lastProgressAtMs === null
          ? null : sampledAtMs - front.lastProgressAtMs,
        checkpointAdvanced: front.checkpointAdvanced,
      };
    });
    const result = snapshotScannerPhaseDiagnostics({
      version: 1, sampledAtMs, unavailable: this.unavailable,
      overflow: this.overflow, buckets: [...this.buckets.values()], fronts,
    });
    for (const front of this.fronts.values()) front.checkpointAdvanced = false;
    return result;
  }
}

function bucketKey(
  provider: ScannerDiagnosticProvider,
  program: ScannerDiagnosticProgram,
  phase: ScannerDiagnosticPhase,
): string {
  return `${provider}:${program}:${phase}`;
}

function codeForOutcome(
  outcome: ScannerDiagnosticOutcome,
  value: unknown,
): ScannerDiagnosticCode | null {
  if (outcome === 'OK' || outcome === 'ABORTED') {
    if (value !== null) throw invalid();
    return null;
  }
  if (outcome === 'PAUSED') {
    if (value !== 'CATCH_UP_PAGE_BUDGET_EXHAUSTED') throw invalid();
    return value;
  }
  if (outcome === 'REFRESH_REQUIRED') {
    if (value !== 'CATCH_UP_REFRESH_REQUIRED') throw invalid();
    return value;
  }
  return finite(value, SCANNER_DIAGNOSTIC_CODES);
}

function exactRecord<const Keys extends readonly string[]>(
  input: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || isProxy(input)) {
    throw invalid();
  }
  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== keys.length || ownKeys.some(key => !keys.includes(key as string))) {
    throw invalid();
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalid();
    }
    result[key] = descriptor.value;
  }
  return result as Readonly<Record<Keys[number], unknown>>;
}

function exactArray(input: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype
    || input.length > maximum) throw invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== input.length + 1) throw invalid();
  const result: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalid();
    }
    result.push(descriptor.value);
  }
  return result;
}

function finite<const Values extends readonly string[]>(
  input: unknown,
  values: Values,
): Values[number] {
  if (typeof input !== 'string' || !values.some(value => value === input)) throw invalid();
  return input;
}

function integer(input: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || Object.is(input, -0)
    || input < 0 || input > maximum) throw invalid();
  return input;
}

function saturatingAdd(current: number, addition: number): { value: number; overflow: boolean } {
  if (addition > Number.MAX_SAFE_INTEGER - current) {
    return { value: Number.MAX_SAFE_INTEGER, overflow: true };
  }
  return { value: current + addition, overflow: false };
}

function invalid(): TypeError {
  return new TypeError('Scanner phase diagnostics are invalid.');
}
