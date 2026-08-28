import { isProxy } from 'node:util/types';
import { isRpcProviderId } from '../domain/rpc-provider.js';
import {
  createWebSocketHealthSnapshot,
  MAX_WEBSOCKET_HEALTH_GENERATION,
  MAX_WEBSOCKET_HEALTH_SLOT,
  WEBSOCKET_DISCONNECT_REASON_CODES,
  WEBSOCKET_HEALTH_PHASES,
  WEBSOCKET_RECOVERY_REASON_CODES,
  WEBSOCKET_RECOVERY_STATUSES,
  type WebSocketHealthSnapshot,
} from '../domain/websocket-health.js';
import type {
  WebSocketHealthBeginOwner,
  WebSocketHealthObservation,
  WebSocketHealthRepository,
  WebSocketHealthRepositoryErrorCode,
  WebSocketHealthTransition,
} from '../ports/websocket-health-repository.js';
import { getDatabasePool } from './database.js';

type Row = Readonly<Record<string, unknown>>;
interface QueryResult {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}
interface WebSocketHealthClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(error?: boolean): void;
}
export interface WebSocketHealthPool {
  connect(): Promise<WebSocketHealthClient>;
}

const SERVICE_KEY = 'transaction-listener';
const BEGIN_OWNER_KEYS = Object.freeze(['candidateProviderId'] as const);
const TRANSITION_KEYS = Object.freeze([
  'ownerGeneration', 'expectedRevision', 'phase', 'providerId',
  'activeSessionGeneration', 'candidateProviderId', 'candidateSessionGeneration',
  'acknowledged', 'disconnectReasonCode', 'recoveryStatus', 'recoveryReasonCode',
] as const);
const OBSERVATION_KEYS = Object.freeze([
  'ownerGeneration', 'sessionGeneration', 'slot',
] as const);
const INTERNAL_REPOSITORY_ERRORS = new WeakSet();

export class WebSocketHealthRepositoryError extends Error {
  public constructor(public readonly code: WebSocketHealthRepositoryErrorCode) {
    super('WebSocket health repository operation failed.');
    this.name = 'WebSocketHealthRepositoryError';
  }
}

export class PostgresWebSocketHealthRepository implements WebSocketHealthRepository {
  private readonly clientsRequiringEviction = new WeakSet<WebSocketHealthClient>();

  public constructor(private readonly pool: WebSocketHealthPool = getDatabasePool()) {}

  public async read(): Promise<WebSocketHealthSnapshot> {
    return this.withClient(async (client) => {
      const result = await safeQuery(client,
        'SELECT * FROM listener_websocket_health WHERE service_key = $1',
        [SERVICE_KEY],
      );
      return requiredSnapshot(result.rows);
    });
  }

  public async beginOwner(input: WebSocketHealthBeginOwner): Promise<WebSocketHealthSnapshot> {
    const begin = beginOwnerInput(input);
    return this.transaction(async (client) => {
      const currentResult = await safeQuery(client,
        `WITH operation AS MATERIALIZED (SELECT clock_timestamp() AS at)
         SELECT health.*, operation.at AS operation_at,
           health.heartbeat_at >= operation.at - INTERVAL '30 seconds' AS owner_is_fresh
         FROM listener_websocket_health health CROSS JOIN operation
         WHERE service_key = $1 FOR UPDATE OF health`,
        [SERVICE_KEY],
      );
      if (currentResult.rows.length !== 1) throw repositoryError('STATE_CONFLICT');
      const rawCurrentRow = currentResult.rows[0];
      if (rawCurrentRow === undefined) throw repositoryError('STATE_CONFLICT');
      const currentRow = databaseRecord(rawCurrentRow);
      const current = snapshotFromRow(currentRow);
      const operationAt = timestampFromDatabase(currentRow.operation_at);
      const isUnrecoverable = current.phase === 'UNRECOVERABLE';
      const isClean = current.supervision === 'INACTIVE' || current.phase === 'STOPPED';
      const isFresh = currentRow.owner_is_fresh === true;
      if (!isClean && !isUnrecoverable && isFresh) {
        throw repositoryError('ACTIVE_INSTANCE');
      }
      if (current.ownerGeneration === MAX_WEBSOCKET_HEALTH_GENERATION
        || current.revision === MAX_WEBSOCKET_HEALTH_GENERATION) {
        throw repositoryError('GENERATION_EXHAUSTED');
      }

      const ownerGeneration = current.ownerGeneration + 1n;
      const abnormal = !isClean;
      const recoveryReason = isUnrecoverable
        ? current.recovery.reasonCode ?? 'CATCH_UP_WINDOW_EXCEEDED'
        : abnormal ? 'UNEXPECTED_RESTART' : null;
      const updated = await safeQuery(client,
        `UPDATE listener_websocket_health SET
          supervision = 'ACTIVE',
          owner_generation = $2,
          revision = revision + 1,
          active_session_generation = NULL,
          candidate_session_generation = $2,
          provider_id = NULL,
          candidate_provider_id = $3,
          phase = 'CONNECTING',
          acknowledged_at = NULL,
          disconnect_occurred_at = CASE WHEN $4::BOOLEAN THEN $5::TIMESTAMPTZ
            ELSE disconnect_occurred_at END,
          disconnect_reason_code = CASE WHEN $4::BOOLEAN THEN 'UNEXPECTED_RESTART'
            ELSE disconnect_reason_code END,
          recovery_status = CASE WHEN $4::BOOLEAN THEN 'REQUIRED' ELSE 'NOT_REQUIRED' END,
          recovery_started_at = NULL,
          recovery_completed_at = NULL,
          recovery_reason_code = $6,
          heartbeat_at = $5,
          updated_at = $5,
          evidence_purge_after = CASE WHEN $4::BOOLEAN THEN NULL ELSE evidence_purge_after END
         WHERE service_key = $1
         RETURNING *`,
        [SERVICE_KEY, ownerGeneration.toString(), begin.candidateProviderId,
          abnormal, new Date(operationAt), recoveryReason],
      );
      return requiredSnapshot(updated.rows);
    });
  }

  public async transition(input: WebSocketHealthTransition): Promise<WebSocketHealthSnapshot> {
    const transition = transitionInput(input);
    if (transition.expectedRevision === MAX_WEBSOCKET_HEALTH_GENERATION) {
      throw repositoryError('GENERATION_EXHAUSTED');
    }
    return this.transaction(async (client) => {
      const result = await safeQuery(client,
        `WITH operation AS MATERIALIZED (SELECT clock_timestamp() AS at)
         UPDATE listener_websocket_health health SET
          revision = health.revision + 1,
          active_session_generation = $4,
          candidate_session_generation = $6,
          provider_id = $3,
          candidate_provider_id = $5,
          phase = $7,
          acknowledged_at = CASE WHEN $8::BOOLEAN
            THEN COALESCE(health.acknowledged_at, operation.at) ELSE NULL END,
          disconnect_occurred_at = CASE
            WHEN $9::TEXT IS NULL THEN health.disconnect_occurred_at
            WHEN health.disconnect_reason_code = $9 THEN health.disconnect_occurred_at
            ELSE operation.at END,
          disconnect_reason_code = COALESCE($9, health.disconnect_reason_code),
          recovery_status = $10,
          recovery_started_at = CASE
            WHEN $10 IN ('NOT_REQUIRED', 'REQUIRED') THEN NULL
            WHEN health.recovery_reason_code = $11
              AND health.recovery_started_at IS NOT NULL THEN health.recovery_started_at
            ELSE operation.at END,
          recovery_completed_at = CASE
            WHEN $10 IN ('RECOVERED', 'FAILED') THEN operation.at ELSE NULL END,
          recovery_reason_code = $11,
          heartbeat_at = operation.at,
          updated_at = operation.at,
          evidence_purge_after = CASE
            WHEN $10 = 'RECOVERED' THEN operation.at + INTERVAL '4 hours'
            WHEN $10 IN ('REQUIRED', 'IN_PROGRESS', 'FAILED') THEN NULL
            ELSE health.evidence_purge_after END
         FROM operation
         WHERE health.service_key = $1
           AND health.owner_generation = $2
           AND health.revision = $12
           AND (
             ($4::BIGINT IS NULL AND $3::TEXT IS NULL)
             OR ($4 = health.active_session_generation AND $3 = health.provider_id)
             OR ($4 = health.candidate_session_generation
               AND $3 = health.candidate_provider_id)
           )
           AND (
             ($6::BIGINT IS NULL AND $5::TEXT IS NULL)
             OR ($6 = health.candidate_session_generation
               AND $5 = health.candidate_provider_id)
             OR (
               $6::NUMERIC = health.revision::NUMERIC + 1
               AND (health.active_session_generation IS NULL
                 OR $6 > health.active_session_generation)
               AND (health.candidate_session_generation IS NULL
                 OR $6 > health.candidate_session_generation)
             )
           )
         RETURNING health.*`,
        [SERVICE_KEY, transition.ownerGeneration.toString(), transition.providerId,
          bigintOrNull(transition.activeSessionGeneration), transition.candidateProviderId,
          bigintOrNull(transition.candidateSessionGeneration), transition.phase,
          transition.acknowledged, transition.disconnectReasonCode,
          transition.recoveryStatus, transition.recoveryReasonCode,
          transition.expectedRevision.toString()],
      );
      if (result.rows.length === 1) return requiredSnapshot(result.rows);
      if (result.rows.length !== 0) throw repositoryError('STATE_CONFLICT');
      const currentResult = await safeQuery(client,
        `SELECT owner_generation::TEXT AS owner_generation, revision::TEXT AS revision
         FROM listener_websocket_health WHERE service_key = $1 FOR UPDATE`,
        [SERVICE_KEY],
      );
      const rawCurrent = currentResult.rows[0];
      if (rawCurrent === undefined || currentResult.rows.length !== 1) {
        throw repositoryError('STATE_CONFLICT');
      }
      const current = databaseRecord(rawCurrent);
      if (bigintFromDatabase(current.owner_generation) !== transition.ownerGeneration) {
        throw repositoryError('STALE_OWNER');
      }
      if (bigintFromDatabase(current.revision) !== transition.expectedRevision) {
        throw repositoryError('STALE_REVISION');
      }
      throw repositoryError('STATE_CONFLICT');
    });
  }

  public async touch(ownerGeneration: bigint): Promise<void> {
    const owner = generation(ownerGeneration, false);
    await this.transaction(async (client) => {
      const result = await safeQuery(client,
        `UPDATE listener_websocket_health
         SET heartbeat_at = clock_timestamp()
         WHERE service_key = $1 AND supervision = 'ACTIVE' AND owner_generation = $2`,
        [SERVICE_KEY, owner.toString()],
      );
      if (result.rowCount === 1) return;
      if (result.rowCount === 0) throw repositoryError('STALE_OWNER');
      throw repositoryError('STATE_CONFLICT');
    });
  }

  public async recordObservation(
    input: WebSocketHealthObservation,
  ): Promise<'RECORDED' | 'STALE_SESSION'> {
    const observation = observationInput(input);
    return this.transaction(async (client) => {
      const result = await safeQuery(client,
        `UPDATE listener_websocket_health SET
          last_observation_at = clock_timestamp(),
          last_observation_slot = $4
         WHERE service_key = $1
           AND supervision = 'ACTIVE'
           AND owner_generation = $2
           AND ($3 = active_session_generation OR $3 = candidate_session_generation)`,
        [SERVICE_KEY, observation.ownerGeneration.toString(),
          observation.sessionGeneration.toString(), observation.slot.toString()],
      );
      if (result.rowCount === 1) return 'RECORDED';
      if (result.rowCount === 0) return 'STALE_SESSION';
      throw repositoryError('STATE_CONFLICT');
    });
  }

  private async transaction<TResult>(
    operation: (client: WebSocketHealthClient) => Promise<TResult>,
  ): Promise<TResult> {
    return this.withClient(async (client) => {
      let started = false;
      try {
        await client.query('BEGIN');
        started = true;
        const result = await operation(client);
        await client.query('COMMIT');
        started = false;
        return result;
      } catch (error: unknown) {
        if (started) {
          try {
            await client.query('ROLLBACK');
          } catch {
            this.clientsRequiringEviction.add(client);
            throw repositoryError('DEPENDENCY_FAILED');
          }
        }
        if (isInternalRepositoryError(error)) throw error;
        throw repositoryError('DEPENDENCY_FAILED');
      }
    });
  }

  private async withClient<TResult>(
    operation: (client: WebSocketHealthClient) => Promise<TResult>,
  ): Promise<TResult> {
    let client: WebSocketHealthClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw repositoryError('DEPENDENCY_FAILED');
    }
    let result: TResult;
    try {
      result = await operation(client);
    } catch (error: unknown) {
      this.releaseClient(client);
      if (isInternalRepositoryError(error)) throw error;
      throw repositoryError('DEPENDENCY_FAILED');
    }
    this.releaseClient(client);
    return result;
  }

  private releaseClient(client: WebSocketHealthClient): void {
    const evict = this.clientsRequiringEviction.delete(client);
    try {
      client.release(evict);
    } catch {
      throw repositoryError('DEPENDENCY_FAILED');
    }
  }
}

function beginOwnerInput(value: unknown): WebSocketHealthBeginOwner {
  const input = ownDataRecord(value, BEGIN_OWNER_KEYS);
  if (!isRpcProviderId(input.candidateProviderId)) throw repositoryError('STATE_CONFLICT');
  return Object.freeze({ candidateProviderId: input.candidateProviderId });
}

function transitionInput(value: unknown): WebSocketHealthTransition {
  const input = ownDataRecord(value, TRANSITION_KEYS);
  const ownerGeneration = generation(input.ownerGeneration, false);
  const expectedRevision = generation(input.expectedRevision, true);
  const providerId = provider(input.providerId);
  const activeSessionGeneration = nullableSessionGeneration(input.activeSessionGeneration);
  const candidateProviderId = provider(input.candidateProviderId);
  const candidateSessionGeneration = nullableSessionGeneration(input.candidateSessionGeneration);
  if ((providerId === null) !== (activeSessionGeneration === null)
    || (candidateProviderId === null) !== (candidateSessionGeneration === null)
    || (activeSessionGeneration !== null && candidateSessionGeneration !== null
      && activeSessionGeneration === candidateSessionGeneration)
    || typeof input.acknowledged !== 'boolean'
    || !(WEBSOCKET_HEALTH_PHASES as readonly unknown[]).includes(input.phase)
    || !(WEBSOCKET_RECOVERY_STATUSES as readonly unknown[]).includes(input.recoveryStatus)
    || (input.disconnectReasonCode !== null
      && !(WEBSOCKET_DISCONNECT_REASON_CODES as readonly unknown[]).includes(input.disconnectReasonCode))
    || (input.recoveryReasonCode !== null
      && !(WEBSOCKET_RECOVERY_REASON_CODES as readonly unknown[]).includes(input.recoveryReasonCode))) {
    throw repositoryError('STATE_CONFLICT');
  }
  const recoveryStatus = input.recoveryStatus as WebSocketHealthTransition['recoveryStatus'];
  const recoveryReasonCode = input.recoveryReasonCode as WebSocketHealthTransition['recoveryReasonCode'];
  if ((recoveryStatus === 'NOT_REQUIRED') !== (recoveryReasonCode === null)) {
    throw repositoryError('STATE_CONFLICT');
  }
  const result = Object.freeze({
    ownerGeneration,
    expectedRevision,
    phase: input.phase as WebSocketHealthTransition['phase'],
    providerId,
    activeSessionGeneration,
    candidateProviderId,
    candidateSessionGeneration,
    acknowledged: input.acknowledged,
    disconnectReasonCode: input.disconnectReasonCode as WebSocketHealthTransition['disconnectReasonCode'],
    recoveryStatus,
    recoveryReasonCode,
  });
  validateTransitionLifecycle(result);
  return result;
}

function validateTransitionLifecycle(value: WebSocketHealthTransition): void {
  const recoveryTime = value.recoveryStatus === 'REQUIRED'
    || value.recoveryStatus === 'NOT_REQUIRED' ? null : 0;
  const recoveryCompleted = value.recoveryStatus === 'RECOVERED'
    || value.recoveryStatus === 'FAILED' ? 0 : null;
  try {
    createWebSocketHealthSnapshot({
      payloadVersion: 1,
      supervision: 'ACTIVE',
      ownerGeneration: value.ownerGeneration,
      revision: value.expectedRevision,
      activeSessionGeneration: value.activeSessionGeneration,
      candidateSessionGeneration: value.candidateSessionGeneration,
      providerId: value.providerId,
      candidateProviderId: value.candidateProviderId,
      phase: value.phase,
      acknowledgedAtMs: value.acknowledged ? 0 : null,
      lastObservation: null,
      disconnect: value.disconnectReasonCode === null ? null : {
        occurredAtMs: 0, reasonCode: value.disconnectReasonCode,
      },
      recovery: {
        status: value.recoveryStatus,
        startedAtMs: recoveryTime,
        completedAtMs: recoveryCompleted,
        reasonCode: value.recoveryReasonCode,
      },
      heartbeatAtMs: 0,
      updatedAtMs: 0,
      evidencePurgeAfterMs: null,
    });
  } catch {
    throw repositoryError('STATE_CONFLICT');
  }
}

function observationInput(value: unknown): WebSocketHealthObservation {
  const input = ownDataRecord(value, OBSERVATION_KEYS);
  const slot = input.slot;
  if (typeof slot !== 'bigint' || slot < 0n || slot > MAX_WEBSOCKET_HEALTH_SLOT) {
    throw repositoryError('STATE_CONFLICT');
  }
  return Object.freeze({
    ownerGeneration: generation(input.ownerGeneration, false),
    sessionGeneration: generation(input.sessionGeneration, false),
    slot,
  });
}

function ownDataRecord(value: unknown, expectedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
      throw repositoryError('STATE_CONFLICT');
    }
    const prototype: object | null = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw repositoryError('STATE_CONFLICT');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length) throw repositoryError('STATE_CONFLICT');
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw repositoryError('STATE_CONFLICT');
      }
      output[key] = descriptor.value;
    }
    return output;
  } catch (error: unknown) {
    if (isInternalRepositoryError(error)) throw error;
    throw repositoryError('STATE_CONFLICT');
  }
}

async function safeQuery(
  client: WebSocketHealthClient,
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult> {
  const result: unknown = await client.query(text, values);
  return queryResultFromDatabase(result);
}

function queryResultFromDatabase(value: unknown): QueryResult {
  try {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
      throw repositoryError('STATE_CONFLICT');
    }
    const rowsDescriptor = Object.getOwnPropertyDescriptor(value, 'rows');
    const rowCountDescriptor = Object.getOwnPropertyDescriptor(value, 'rowCount');
    if (rowsDescriptor === undefined || !('value' in rowsDescriptor)
      || rowCountDescriptor === undefined || !('value' in rowCountDescriptor)) {
      throw repositoryError('STATE_CONFLICT');
    }
    const rows = rowsFromDatabase(rowsDescriptor.value as unknown);
    const rowCount = rowCountDescriptor.value as unknown;
    if (rowCount !== null && (!Number.isSafeInteger(rowCount) || (rowCount as number) < 0)) {
      throw repositoryError('STATE_CONFLICT');
    }
    return Object.freeze({ rows, rowCount: rowCount as number | null });
  } catch (error: unknown) {
    if (isInternalRepositoryError(error)) throw error;
    throw repositoryError('STATE_CONFLICT');
  }
}

function rowsFromDatabase(value: unknown): readonly Row[] {
  if (typeof value !== 'object' || value === null || isProxy(value)
    || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw repositoryError('STATE_CONFLICT');
  }
  const rows: Row[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw repositoryError('STATE_CONFLICT');
    }
    rows.push(descriptor.value as Row);
  }
  return Object.freeze(rows);
}

function databaseRecord(value: unknown): Row {
  try {
    if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
      throw repositoryError('STATE_CONFLICT');
    }
    const prototype: object | null = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw repositoryError('STATE_CONFLICT');
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw repositoryError('STATE_CONFLICT');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw repositoryError('STATE_CONFLICT');
      }
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch (error: unknown) {
    if (isInternalRepositoryError(error)) throw error;
    throw repositoryError('STATE_CONFLICT');
  }
}

function requiredSnapshot(rows: readonly Row[]): WebSocketHealthSnapshot {
  if (rows.length !== 1 || rows[0] === undefined) throw repositoryError('STATE_CONFLICT');
  return snapshotFromRow(rows[0]);
}

function snapshotFromRow(row: Row): WebSocketHealthSnapshot {
  try {
    const data = databaseRecord(row);
    return createWebSocketHealthSnapshot({
      payloadVersion: data.payload_version,
      supervision: data.supervision,
      ownerGeneration: bigintFromDatabase(data.owner_generation),
      revision: bigintFromDatabase(data.revision),
      activeSessionGeneration: nullableBigintFromDatabase(data.active_session_generation),
      candidateSessionGeneration: nullableBigintFromDatabase(data.candidate_session_generation),
      providerId: data.provider_id,
      candidateProviderId: data.candidate_provider_id,
      phase: data.phase,
      acknowledgedAtMs: nullableTimestampFromDatabase(data.acknowledged_at),
      lastObservation: data.last_observation_at === null && data.last_observation_slot === null
        ? null
        : {
            observedAtMs: timestampFromDatabase(data.last_observation_at),
            slot: bigintFromDatabase(data.last_observation_slot),
          },
      disconnect: data.disconnect_occurred_at === null && data.disconnect_reason_code === null
        ? null
        : {
            occurredAtMs: timestampFromDatabase(data.disconnect_occurred_at),
            reasonCode: data.disconnect_reason_code,
          },
      recovery: {
        status: data.recovery_status,
        startedAtMs: nullableTimestampFromDatabase(data.recovery_started_at),
        completedAtMs: nullableTimestampFromDatabase(data.recovery_completed_at),
        reasonCode: data.recovery_reason_code,
      },
      heartbeatAtMs: nullableTimestampFromDatabase(data.heartbeat_at),
      updatedAtMs: timestampFromDatabase(data.updated_at),
      evidencePurgeAfterMs: nullableTimestampFromDatabase(data.evidence_purge_after),
    });
  } catch (error: unknown) {
    if (isInternalRepositoryError(error)) throw error;
    throw repositoryError('STATE_CONFLICT');
  }
}

function generation(value: unknown, allowZero: boolean): bigint {
  if (typeof value !== 'bigint'
    || value < (allowZero ? 0n : 1n)
    || value > MAX_WEBSOCKET_HEALTH_GENERATION) {
    throw repositoryError('STATE_CONFLICT');
  }
  return value;
}

function nullableSessionGeneration(value: unknown): bigint | null {
  return value === null ? null : generation(value, false);
}

function provider(value: unknown): WebSocketHealthTransition['providerId'] {
  if (value === null) return null;
  if (!isRpcProviderId(value)) throw repositoryError('STATE_CONFLICT');
  return value;
}

function bigintOrNull(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function bigintFromDatabase(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw repositoryError('STATE_CONFLICT');
  }
  return BigInt(value);
}

function nullableBigintFromDatabase(value: unknown): bigint | null {
  return value === null ? null : bigintFromDatabase(value);
}

function timestampFromDatabase(value: unknown): number {
  if (typeof value !== 'object' || value === null || isProxy(value)
    || Object.getPrototypeOf(value) !== Date.prototype) {
    throw repositoryError('STATE_CONFLICT');
  }
  const milliseconds = Date.prototype.getTime.call(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw repositoryError('STATE_CONFLICT');
  }
  return milliseconds;
}

function nullableTimestampFromDatabase(value: unknown): number | null {
  return value === null ? null : timestampFromDatabase(value);
}

function repositoryError(code: WebSocketHealthRepositoryErrorCode): WebSocketHealthRepositoryError {
  const error = new WebSocketHealthRepositoryError(code);
  INTERNAL_REPOSITORY_ERRORS.add(error);
  return error;
}

function isInternalRepositoryError(error: unknown): error is WebSocketHealthRepositoryError {
  return typeof error === 'object' && error !== null && INTERNAL_REPOSITORY_ERRORS.has(error);
}
