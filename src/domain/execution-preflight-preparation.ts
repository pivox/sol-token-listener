import { createHash } from 'node:crypto';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ExecutionPreflightPreparationState =
  | 'WAITING'
  | 'PREPARING'
  | 'PREPARED'
  | 'FAILED';

export type ExecutionPreflightPreparationErrorCode =
  | 'PREFLIGHT_PAIR_NOT_FOUND'
  | 'PREFLIGHT_PAIR_CONFLICT'
  | 'PREFLIGHT_PAIR_LINEAGE_INVALID'
  | 'PREFLIGHT_TARGET_NOT_PRISTINE'
  | 'PREFLIGHT_PROBE_NOT_PRISTINE'
  | 'PREFLIGHT_TARGET_FENCE_LOST'
  | 'PREFLIGHT_PREPARATION_DEADLINE_EXCEEDED'
  | 'PREFLIGHT_RPC_CAPACITY_UNVERIFIED'
  | 'PREFLIGHT_PREPARATION_EXPORT_FAILED';

export interface ExecutionPreflightPreparationIdentityV1 {
  readonly payloadVersion: 1;
  readonly runId: string;
  readonly runFingerprint: string;
}

export interface ExecutionPreflightPreparationV1 extends ExecutionPreflightPreparationIdentityV1 {
  readonly state: ExecutionPreflightPreparationState;
  readonly stateRevision: bigint;
  readonly watermarkAtMs: number;
  readonly deadlineAtMs: number;
  readonly pairId: string | null;
  readonly assessmentId: string | null;
  readonly assessmentFingerprint: string | null;
  readonly artifactId: string | null;
  readonly artifactFingerprint: string | null;
  readonly failureCode: ExecutionPreflightPreparationErrorCode | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly selectedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly purgeAfterMs: number | null;
}

export interface ClaimedExecutionPreflightPreparation {
  readonly preparation: ExecutionPreflightPreparationV1;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
}

export class ExecutionPreflightPreparationValidationError extends TypeError {
  public constructor() {
    super('Invalid execution preflight preparation.');
    this.name = 'ExecutionPreflightPreparationValidationError';
  }
}

export function createExecutionPreflightPreparationIdentity(
  entropy: unknown,
): ExecutionPreflightPreparationIdentityV1 {
  if (typeof entropy !== 'string' || !UUID_V4.test(entropy)) throw invalid();
  const digest = hashLengthPrefixed([
    'execution-preflight-preparation-run-v1',
    entropy,
  ]);
  const runId = `execution_preflight_preparation_${digest}`;
  const runFingerprint = createHash('sha256').update(JSON.stringify(Object.freeze({
    payloadVersion: 1,
    runId,
  })), 'utf8').digest('hex');
  return Object.freeze({ payloadVersion: 1, runId, runFingerprint });
}

function hashLengthPrefixed(values: readonly string[]): string {
  const chunks: Buffer[] = [];
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}

function invalid(): ExecutionPreflightPreparationValidationError {
  return new ExecutionPreflightPreparationValidationError();
}
