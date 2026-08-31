import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  createSignedTransactionArtifact,
  type SignedTransactionArtifactV1,
} from '../domain/execution-live.js';
import { assertExecutionIntent } from '../domain/execution-intent.js';
import type {
  AuthenticatedPersistedSignedTransactionV1,
  ExecutionLivePersistSignedInputV1,
} from '../ports/execution-live-repository.js';
import type { ClaimedExecutionIntent } from '../ports/execution-intent-repository.js';
import { getDatabasePool } from './database.js';

type Row = Readonly<Record<string, unknown>>;

interface QueryResult {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

interface DatabaseClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(error?: boolean): void;
}

interface DatabaseSource {
  connect(): Promise<DatabaseClient>;
}

export type ExecutionLiveRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_DATA'
  | 'CONFLICT'
  | 'PREFLIGHT_EXPIRED'
  | 'CONTROL_STOPPED'
  | 'LEASE_LOST'
  | 'DATABASE_FAILURE'
  | 'COMMIT_OUTCOME_UNKNOWN';

export class ExecutionLiveRepositoryError extends Error {
  public constructor(public readonly code: ExecutionLiveRepositoryErrorCode) {
    super('Execution live repository operation failed.');
    this.name = 'ExecutionLiveRepositoryError';
  }
}

const INTERNAL_ERRORS = new WeakSet<ExecutionLiveRepositoryError>();
const ARTIFACT_ID = /^execution_signed_transaction_[0-9a-f]{64}$/u;

export class PostgresExecutionLiveRepository {
  readonly #source: DatabaseSource;

  public constructor(
    source: DatabaseSource | Pick<InstanceType<typeof pg.Pool>, 'connect'> = getDatabasePool(),
  ) {
    this.#source = source;
  }

  public async persistSigned(
    inputValue: ExecutionLivePersistSignedInputV1,
  ): Promise<SignedTransactionArtifactV1> {
    const input = persistInputFrom(inputValue);
    return this.transaction(async (client) => {
      await lockGeneration(client, input.artifact.generationId);
      const replay = await findArtifact(client, input.artifact.artifactId, true);
      if (replay !== null) {
        if (!sameArtifact(replay, input.artifact)) throw failure('CONFLICT');
        return input.artifact;
      }
      const binding = exactRow(singleRow(await client.query(`SELECT
        trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms,
        intent.status AS intent_status,intent.side AS intent_side,
        intent.lease_owner,intent.lease_token::TEXT AS lease_token,
        trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT AS lease_expires_at_ms,
        attempt.status AS attempt_status,generation.wallet_public_key,
        generation.retired_at,control.state AS control_state,
        qualification.qualification_id,
        trunc(EXTRACT(EPOCH FROM qualification.expires_at)*1000)::TEXT
          AS qualification_expires_at_ms,
        armament.state AS armament_state,armament.state_revision::TEXT AS armament_revision,
        armament.provider_id,armament.qualification_id AS armament_qualification_id,
        armament.consumed_buys,armament.maximum_buys,
        trunc(EXTRACT(EPOCH FROM armament.expires_at)*1000)::TEXT AS armament_expires_at_ms,
        risk.unknown_block,reservation.reservation_id,reservation.state AS reservation_state,
        reservation.generation_id AS reservation_generation_id,
        reservation.intent_id AS reservation_intent_id,
        admission.decision AS admission_decision,admission.quota_state,
        provider.snapshot_fingerprint AS provider_snapshot_fingerprint,
        provider.superseded_at AS provider_superseded_at,
        trunc(EXTRACT(EPOCH FROM provider.expires_at)*1000)::TEXT AS provider_expires_at_ms
        FROM execution_intents intent
        JOIN execution_attempts attempt ON attempt.intent_id=intent.id
          AND attempt.attempt_number=$2
        JOIN execution_wallet_generations generation ON generation.generation_id=$3
        JOIN execution_control_state control ON control.generation_id=generation.generation_id
        JOIN execution_safety_qualifications qualification ON qualification.qualification_id=$4
        JOIN execution_activation_armaments armament ON armament.armament_id=$5
        JOIN execution_wallet_risk_state risk ON risk.generation_id=generation.generation_id
        JOIN execution_exposure_reservations reservation ON reservation.reservation_id=$6
        JOIN execution_risk_admission_reports admission
          ON admission.report_id=reservation.admission_report_id
        JOIN execution_provider_usage_snapshots provider
          ON provider.snapshot_fingerprint=reservation.provider_snapshot_fingerprint
          AND provider.provider_id=armament.provider_id
        WHERE intent.id=$1
        FOR UPDATE OF intent,attempt,generation,control,qualification,armament,risk,reservation`, [
        input.artifact.intentId, input.artifact.attemptNumber,
        input.artifact.generationId, input.qualificationId, input.artifact.armamentId,
        input.reservationId,
      ])), [
        'now_ms', 'intent_status', 'intent_side', 'lease_owner', 'lease_token',
        'lease_expires_at_ms', 'attempt_status', 'wallet_public_key', 'retired_at',
        'control_state', 'qualification_id', 'qualification_expires_at_ms',
        'armament_state', 'armament_revision', 'provider_id',
        'armament_qualification_id', 'consumed_buys', 'maximum_buys',
        'armament_expires_at_ms', 'unknown_block', 'reservation_id',
        'reservation_state', 'reservation_generation_id', 'reservation_intent_id',
        'admission_decision', 'quota_state', 'provider_snapshot_fingerprint',
        'provider_superseded_at', 'provider_expires_at_ms',
      ] as const);
      validateBuyBinding(binding, input);
      const nowMs = timestampText(binding.now_ms);
      const revision = unsignedBigint(binding.armament_revision);
      const locked = await client.query(`UPDATE execution_activation_armaments SET
        state='LOCKED',state_revision=$2::BIGINT,consumed_buys=consumed_buys+1
        WHERE armament_id=$1 AND state='ARMED' AND state_revision=$3::BIGINT
          AND consumed_buys < maximum_buys`, [
        input.artifact.armamentId, (revision + 1n).toString(), revision.toString(),
      ]);
      if (locked.rowCount !== 1) throw failure('CONFLICT');
      await insertActivationEvent(client, input.artifact, nowMs);
      await insertArtifact(client, input.artifact);
      const transitioned = await client.query(`UPDATE execution_intents SET
        status='SIGNED_NOT_SUBMITTED',state_revision=state_revision+2,
        last_reason_code='SIGNATURE_PERSISTED',
        updated_at=date_trunc('milliseconds',statement_timestamp())
        WHERE id=$1 AND status='PROCESSING' AND state_revision=$4::BIGINT
          AND lease_owner=$2 AND lease_token=$3::UUID
          AND lease_expires_at > statement_timestamp()`, [
        input.artifact.intentId, input.claim.leaseOwner, input.claim.leaseToken,
        input.claim.intent.stateRevision.toString(),
      ]);
      if (transitioned.rowCount !== 1) throw failure('LEASE_LOST');
      await insertIntentTransitions(client, input, nowMs);
      await insertSubmissionEvent(client, input.artifact, nowMs);
      return input.artifact;
    });
  }

  public async authenticatePersistedSignedTransaction(input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly artifactId: string;
  }>): Promise<AuthenticatedPersistedSignedTransactionV1> {
    const claim = claimFrom(input.claim);
    if (!ARTIFACT_ID.test(input.artifactId)) throw failure('INVALID_INPUT');
    return this.transaction(async (client) => {
      const row = await findArtifact(client, input.artifactId, false);
      if (row?.intent_id !== claim.intent.id
        || row.intent_status !== 'SIGNED_NOT_SUBMITTED'
        || row.lease_owner !== claim.leaseOwner || row.lease_token !== claim.leaseToken
        || timestampText(row.lease_expires_at_ms) <= timestampText(row.now_ms)) {
        throw failure('LEASE_LOST');
      }
      const artifact = artifactFromRow(row);
      if (artifact.artifactId !== input.artifactId || row.state !== 'PERSISTED'
        || unsignedBigint(row.state_revision) !== 0n) throw failure('INVALID_DATA');
      return Object.freeze({
        payloadVersion: 1,
        artifact,
        state: 'PERSISTED',
        stateRevision: 0n,
      });
    });
  }

  private async transaction<T>(operation: (client: DatabaseClient) => Promise<T>): Promise<T> {
    let client: DatabaseClient | null = null;
    let commitStarted = false;
    try {
      client = await this.#source.connect();
      await client.query('BEGIN');
      const result = await operation(client);
      commitStarted = true;
      await client.query('COMMIT');
      client.release();
      return result;
    } catch (error) {
      if (client !== null) {
        try { await client.query('ROLLBACK'); } catch { /* fixed redacted failure below */ }
        client.release(true);
      }
      if (error instanceof ExecutionLiveRepositoryError && INTERNAL_ERRORS.has(error)) throw error;
      if (commitStarted) throw failure('COMMIT_OUTCOME_UNKNOWN');
      if (databaseCode(error) === '23505' || databaseCode(error) === '23503'
        || databaseCode(error) === '55000') throw failure('CONFLICT');
      throw failure('DATABASE_FAILURE');
    }
  }
}

function persistInputFrom(input: ExecutionLivePersistSignedInputV1): ExecutionLivePersistSignedInputV1 {
  try {
    if (!/^execution_safety_qualification_[0-9a-f]{64}$/u.test(input.qualificationId)
      || input.reservationId === null
      || !/^execution_exposure_reservation_[0-9a-f]{64}$/u.test(input.reservationId)) {
      throw new TypeError();
    }
    const claim = claimFrom(input.claim);
    const artifact = recreateArtifact(input.artifact);
    const simulation = input.unsignedSimulation;
    if (artifact.artifactId !== input.artifact.artifactId
      || artifact.signedTransactionHash !== input.artifact.signedTransactionHash
      || artifact.intentId !== claim.intent.id || artifact.side !== 'BUY'
      || artifact.armamentId === null || artifact.exitAuthorizationId !== null
      || claim.intent.status !== 'PROCESSING'
      || simulation.messageHash !== artifact.messageHash
      || simulation.buildFingerprint !== artifact.buildFingerprint
      || simulation.snapshotFingerprint !== artifact.snapshotFingerprint
      || simulation.blockhash !== artifact.blockhash
      || simulation.lastValidBlockHeight !== artifact.lastValidBlockHeight) {
      throw new TypeError();
    }
    return Object.freeze({ ...input, claim, artifact });
  } catch (error) {
    if (error instanceof ExecutionLiveRepositoryError) throw error;
    throw failure('INVALID_INPUT');
  }
}

function claimFrom(claim: ClaimedExecutionIntent): ClaimedExecutionIntent {
  assertExecutionIntent(claim.intent);
  const intent = claim.intent;
  if (typeof claim.leaseOwner !== 'string' || claim.leaseOwner.length < 1
    || typeof claim.leaseToken !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(claim.leaseToken)
    || !Number.isSafeInteger(claim.leaseExpiresAtMs) || claim.leaseExpiresAtMs < 0) {
    throw failure('INVALID_INPUT');
  }
  return Object.freeze({ ...claim, intent });
}

function recreateArtifact(value: SignedTransactionArtifactV1): SignedTransactionArtifactV1 {
  return createSignedTransactionArtifact({
    payloadVersion: value.payloadVersion,
    specificationVersion: value.specificationVersion,
    intentId: value.intentId,
    attemptNumber: value.attemptNumber,
    generationId: value.generationId,
    armamentId: value.armamentId,
    exitAuthorizationId: value.exitAuthorizationId,
    providerId: value.providerId,
    walletPublicKey: value.walletPublicKey,
    side: value.side,
    effectiveVenue: value.effectiveVenue,
    messageHash: value.messageHash,
    buildFingerprint: value.buildFingerprint,
    snapshotFingerprint: value.snapshotFingerprint,
    quoteFingerprint: value.quoteFingerprint,
    blockhash: value.blockhash,
    lastValidBlockHeight: value.lastValidBlockHeight,
    signature: value.signature,
    signedTransactionBytes: Uint8Array.from(value.signedTransactionBytes),
    signedAtMs: value.signedAtMs,
  });
}

function validateBuyBinding(
  row: Row,
  input: ExecutionLivePersistSignedInputV1,
): void {
  const now = timestampText(row.now_ms);
  if (row.lease_owner !== input.claim.leaseOwner || row.lease_token !== input.claim.leaseToken
    || timestampText(row.lease_expires_at_ms) <= now) throw failure('LEASE_LOST');
  if (row.control_state !== 'RUNNING') throw failure('CONTROL_STOPPED');
  if (row.intent_status !== 'PROCESSING' || row.intent_side !== 'BUY'
    || row.attempt_status !== 'STARTED'
    || row.wallet_public_key !== input.artifact.walletPublicKey || row.retired_at !== null
    || row.qualification_id !== input.qualificationId
    || timestampText(row.qualification_expires_at_ms) <= now
    || row.armament_state !== 'ARMED'
    || row.armament_qualification_id !== input.qualificationId
    || row.provider_id !== input.artifact.providerId
    || timestampText(row.armament_expires_at_ms) <= now
    || integer(row.consumed_buys) >= integer(row.maximum_buys)
    || row.unknown_block !== false || row.reservation_id !== input.reservationId
    || row.reservation_state !== 'RESERVED'
    || row.reservation_generation_id !== input.artifact.generationId
    || row.reservation_intent_id !== input.artifact.intentId
    || row.admission_decision !== 'ADMITTED' || row.quota_state !== 'NORMAL'
    || row.provider_snapshot_fingerprint === null
    || row.provider_superseded_at !== null
    || timestampText(row.provider_expires_at_ms) <= now) {
    throw failure('PREFLIGHT_EXPIRED');
  }
}

async function insertArtifact(client: DatabaseClient, artifact: SignedTransactionArtifactV1): Promise<void> {
  const result = await client.query(`INSERT INTO execution_signed_transactions (
    artifact_id,payload_version,specification_version,intent_id,attempt_number,
    generation_id,armament_id,exit_authorization_id,provider_id,wallet_public_key,
    side,effective_venue,message_hash,build_fingerprint,snapshot_fingerprint,
    quote_fingerprint,blockhash,last_valid_block_height,signature,
    signed_transaction_bytes,signed_transaction_hash,state,state_revision,signed_at
  ) VALUES ($1,1,1,$2,$3,$4,$5,NULL,$6,$7,'BUY',$8,$9,$10,$11,$12,$13,$14::BIGINT,
    $15,$16,$17,'PERSISTED',0,
    TIMESTAMPTZ 'epoch'+($18::BIGINT*INTERVAL '1 millisecond'))`, [
    artifact.artifactId, artifact.intentId, artifact.attemptNumber,
    artifact.generationId, artifact.armamentId, artifact.providerId,
    artifact.walletPublicKey, artifact.effectiveVenue, artifact.messageHash,
    artifact.buildFingerprint, artifact.snapshotFingerprint, artifact.quoteFingerprint,
    artifact.blockhash, artifact.lastValidBlockHeight.toString(), artifact.signature,
    Buffer.from(artifact.signedTransactionBytes), artifact.signedTransactionHash,
    artifact.signedAtMs,
  ]);
  if (result.rowCount !== 1) throw failure('CONFLICT');
}

async function insertActivationEvent(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
  occurredAtMs: number,
): Promise<void> {
  const eventFingerprint = hash([
    'execution-activation-event-v1', artifact.armamentId, 'ARMED', 'LOCKED',
    'ARMAMENT_LOCKED', occurredAtMs,
  ]);
  const result = await client.query(`INSERT INTO execution_activation_events (
    event_id,payload_version,event_fingerprint,armament_id,generation_id,
    previous_state,next_state,reason_code,occurred_at
  ) VALUES ($1,1,$2,$3,$4,'ARMED','LOCKED','ARMAMENT_LOCKED',
    TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond'))`, [
    `execution_activation_event_${eventFingerprint}`, eventFingerprint,
    artifact.armamentId, artifact.generationId, occurredAtMs,
  ]);
  if (result.rowCount !== 1) throw failure('CONFLICT');
}

async function insertIntentTransitions(
  client: DatabaseClient,
  input: ExecutionLivePersistSignedInputV1,
  occurredAtMs: number,
): Promise<void> {
  const artifact = input.artifact;
  const result = await client.query(`INSERT INTO execution_intent_transitions (
    intent_id,previous_status,next_status,reason_code,human_message,activation_phase,
    attempt_number,evidence,occurred_at
  ) VALUES
    ($1,'PROCESSING','SIMULATED','SIMULATION_SUCCEEDED',
      'Unsigned live execution simulation succeeded.','CANARY',$2::INTEGER,
      jsonb_build_object('payloadVersion',1,'attemptNumber',$2::INTEGER,
        'sourceEventId',NULL,'observedAtMs',$3::BIGINT),
      TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')),
    ($1,'SIMULATED','SIGNED_NOT_SUBMITTED','SIGNATURE_PERSISTED',
      'Signed bytes persisted before submission.','CANARY',$2::INTEGER,
      jsonb_build_object('payloadVersion',1,'attemptNumber',$2::INTEGER,
        'sourceEventId',NULL,'observedAtMs',$3::BIGINT),
      TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'))`, [
    artifact.intentId, artifact.attemptNumber, occurredAtMs,
  ]);
  if (result.rowCount !== 2) throw failure('CONFLICT');
}

async function insertSubmissionEvent(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
  occurredAtMs: number,
): Promise<void> {
  const eventFingerprint = hash([
    'execution-submission-event-v1', artifact.artifactId, null, 'PERSISTED',
    'SIGNATURE_PERSISTED', occurredAtMs,
  ]);
  const result = await client.query(`INSERT INTO execution_submission_events (
    event_id,payload_version,event_fingerprint,artifact_id,generation_id,
    previous_state,next_state,reason_code,occurred_at
  ) VALUES ($1,1,$2,$3,$4,NULL,'PERSISTED','SIGNATURE_PERSISTED',
    TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond'))`, [
    `execution_submission_event_${eventFingerprint}`, eventFingerprint,
    artifact.artifactId, artifact.generationId, occurredAtMs,
  ]);
  if (result.rowCount !== 1) throw failure('CONFLICT');
}

async function findArtifact(
  client: DatabaseClient,
  artifactId: string,
  lock: boolean,
): Promise<Row | null> {
  const result = await client.query(`SELECT transaction.*,
    intent.status AS intent_status,intent.lease_owner,
    intent.lease_token::TEXT AS lease_token,
    trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT AS lease_expires_at_ms,
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms,
    trunc(EXTRACT(EPOCH FROM transaction.signed_at)*1000)::TEXT AS signed_at_ms
    FROM execution_signed_transactions transaction
    JOIN execution_intents intent ON intent.id=transaction.intent_id
    WHERE transaction.artifact_id=$1${lock ? ' FOR UPDATE OF transaction,intent' : ''}`, [artifactId]);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  return result.rows[0] ?? null;
}

function artifactFromRow(row: Row): SignedTransactionArtifactV1 {
  const bytes = row.signed_transaction_bytes;
  if (!Buffer.isBuffer(bytes)) throw failure('INVALID_DATA');
  return createSignedTransactionArtifact({
    payloadVersion: integer(row.payload_version),
    specificationVersion: integer(row.specification_version),
    intentId: row.intent_id,
    attemptNumber: integer(row.attempt_number),
    generationId: row.generation_id,
    armamentId: row.armament_id,
    exitAuthorizationId: row.exit_authorization_id,
    providerId: row.provider_id,
    walletPublicKey: row.wallet_public_key,
    side: row.side,
    effectiveVenue: row.effective_venue,
    messageHash: row.message_hash,
    buildFingerprint: row.build_fingerprint,
    snapshotFingerprint: row.snapshot_fingerprint,
    quoteFingerprint: row.quote_fingerprint,
    blockhash: row.blockhash,
    lastValidBlockHeight: unsignedBigint(row.last_valid_block_height),
    signature: row.signature,
    signedTransactionBytes: bytes,
    signedAtMs: timestampText(row.signed_at_ms),
  });
}

function sameArtifact(row: Row, artifact: SignedTransactionArtifactV1): boolean {
  try {
    const stored = artifactFromRow(row);
    return stored.artifactId === artifact.artifactId
      && stored.intentId === artifact.intentId
      && stored.attemptNumber === artifact.attemptNumber
      && stored.generationId === artifact.generationId
      && stored.armamentId === artifact.armamentId
      && stored.exitAuthorizationId === artifact.exitAuthorizationId
      && stored.providerId === artifact.providerId
      && stored.walletPublicKey === artifact.walletPublicKey
      && stored.side === artifact.side
      && stored.effectiveVenue === artifact.effectiveVenue
      && stored.messageHash === artifact.messageHash
      && stored.buildFingerprint === artifact.buildFingerprint
      && stored.snapshotFingerprint === artifact.snapshotFingerprint
      && stored.quoteFingerprint === artifact.quoteFingerprint
      && stored.blockhash === artifact.blockhash
      && stored.lastValidBlockHeight === artifact.lastValidBlockHeight
      && stored.signature === artifact.signature
      && stored.signedTransactionHash === artifact.signedTransactionHash
      && stored.signedAtMs === artifact.signedAtMs
      && stored.signedTransactionBytes.length === artifact.signedTransactionBytes.length
      && stored.signedTransactionBytes.every(
        (byte, index) => byte === artifact.signedTransactionBytes[index],
      );
  } catch { return false; }
}

async function lockGeneration(client: DatabaseClient, generationId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))', [generationId]);
}

function exactRow<const Keys extends readonly string[]>(
  value: Row,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (Reflect.ownKeys(value).length !== keys.length) throw failure('INVALID_DATA');
  for (const key of keys) if (!Object.hasOwn(value, key)) throw failure('INVALID_DATA');
  return value;
}

function singleRow(result: QueryResult): Row {
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) throw failure('CONFLICT');
  return row;
}

function timestampText(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw failure('INVALID_DATA');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw failure('INVALID_DATA');
  return parsed;
}

function unsignedBigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw failure('INVALID_DATA');
  }
  return BigInt(value);
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw failure('INVALID_DATA');
  }
  return value;
}

function hash(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function databaseCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value : null;
}

function failure(code: ExecutionLiveRepositoryErrorCode): ExecutionLiveRepositoryError {
  const error = new ExecutionLiveRepositoryError(code);
  INTERNAL_ERRORS.add(error);
  return error;
}
