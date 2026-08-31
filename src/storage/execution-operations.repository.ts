import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  createExecutionArmament,
  createOperatorAuthorization,
  decideExecutionControlTransition,
  type ExecutionActivationArmamentV1,
  type ExecutionOperatorAuthorizationV1,
} from '../domain/execution-operations.js';
import {
  createMainnetSimulationEvidenceFingerprint,
  createSafetyQualification,
  type ExecutionSafetyQualificationV1,
} from '../domain/execution-safety-qualification.js';
import type {
  ExecutionControlCommandV1,
  ExecutionOperationsRepository,
  ExecutionOperationsStatusV1,
  ExecutionResumeCommandV1,
} from '../ports/execution-operations-repository.js';

interface QueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number | null;
}

interface DatabaseClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(error?: boolean): void;
}

interface DatabaseSource {
  connect(): Promise<DatabaseClient>;
}

type RepositoryErrorCode =
  | 'CONFLICT' | 'INVALID_DATA' | 'DATABASE_FAILURE'
  | 'CONTROL_STOPPED' | 'PREFLIGHT_EXPIRED';

const INTERNAL_ERRORS = new WeakSet();

export class ExecutionOperationsRepositoryError extends Error {
  public readonly code: RepositoryErrorCode;

  public constructor(code: RepositoryErrorCode) {
    super('Execution operations repository operation failed.');
    this.name = 'ExecutionOperationsRepositoryError';
    this.code = code;
  }
}

export class PostgresExecutionOperationsRepository implements ExecutionOperationsRepository {
  readonly #source: DatabaseSource;

  public constructor(source: DatabaseSource | Pick<InstanceType<typeof pg.Pool>, 'connect'>) {
    this.#source = source;
  }

  public async persistQualification(
    input: ExecutionSafetyQualificationV1,
  ): Promise<ExecutionSafetyQualificationV1> {
    const qualification = qualificationFrom(input);
    return this.transaction(async (client) => {
      await lockGeneration(client, qualification.generationId);
      const existing = await client.query(`SELECT qualification_id
        FROM execution_safety_qualifications WHERE qualification_id=$1`,
      [qualification.qualificationId]);
      if (existing.rows.length === 1) {
        const row = exactRow(existing.rows[0], ['qualification_id'] as const);
        const stored = await qualificationForArm(client, String(row.qualification_id));
        if (stored.qualificationId !== qualification.qualificationId
          || stored.qualificationFingerprint !== qualification.qualificationFingerprint) {
          throw failure('CONFLICT');
        }
        return qualification;
      }
      if (existing.rows.length !== 0) throw failure('INVALID_DATA');
      const generation = exactRow(singleRow(await client.query(`SELECT wallet_public_key,cluster,
        genesis_hash,retired_at,
        trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS database_now_ms
        FROM execution_wallet_generations WHERE generation_id=$1`,
      [qualification.generationId])), [
        'wallet_public_key', 'cluster', 'genesis_hash', 'retired_at', 'database_now_ms',
      ] as const);
      const databaseNowMs = timestampText(generation.database_now_ms);
      if (generation.wallet_public_key !== qualification.walletPublicKey
        || generation.cluster !== qualification.cluster
        || generation.genesis_hash !== qualification.genesisHash
        || generation.retired_at !== null) throw failure('CONFLICT');
      if (qualification.qualifiedAtMs > databaseNowMs
        || qualification.expiresAtMs <= databaseNowMs) throw failure('PREFLIGHT_EXPIRED');
      await verifyMainnetSimulationEvidence(client, qualification);
      const inserted = await client.query(`INSERT INTO execution_safety_qualifications (
        qualification_id,payload_version,evaluator_version,qualification_fingerprint,
        phase,build_hash,configuration_fingerprint,strategy_fingerprint,generation_id,
        wallet_public_key,cluster,genesis_hash,provider_id,qualified_at,expires_at,purge_after
      ) VALUES ($1,1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        TIMESTAMPTZ 'epoch'+($12::BIGINT*INTERVAL '1 millisecond'),
        TIMESTAMPTZ 'epoch'+($13::BIGINT*INTERVAL '1 millisecond'),
        TIMESTAMPTZ 'epoch'+(($13::BIGINT+14400000)*INTERVAL '1 millisecond'))`, [
        qualification.qualificationId, qualification.qualificationFingerprint,
        qualification.phase, qualification.buildHash, qualification.configurationFingerprint,
        qualification.strategyFingerprint, qualification.generationId,
        qualification.walletPublicKey, qualification.cluster, qualification.genesisHash,
        qualification.providerId, qualification.qualifiedAtMs, qualification.expiresAtMs,
      ]);
      if (inserted.rowCount !== 1) throw failure('INVALID_DATA');
      for (const [index, gate] of qualification.gates.entries()) {
        const evidence = await client.query(`INSERT INTO execution_safety_gate_evidence (
          qualification_id,gate_index,payload_version,gate_id,status,evidence_type,
          evidence_id,evidence_fingerprint,observed_at,expires_at
        ) VALUES ($1,$2,1,$3,'PASSED',$4,$5,$6,
          TIMESTAMPTZ 'epoch'+($7::BIGINT*INTERVAL '1 millisecond'),
          TIMESTAMPTZ 'epoch'+($8::BIGINT*INTERVAL '1 millisecond'))`, [
          qualification.qualificationId, index, gate.gateId, gate.evidenceType,
          gate.evidenceId, gate.evidenceFingerprint, gate.observedAtMs, gate.expiresAtMs,
        ]);
        if (evidence.rowCount !== 1) throw failure('INVALID_DATA');
      }
      return qualification;
    });
  }

  public async recordAuthorization(
    input: ExecutionOperatorAuthorizationV1,
  ): Promise<'RECORDED' | 'REPLAYED'> {
    const authorization = authorizationFrom(input);
    return this.transaction(async (client) => {
      const existing = await client.query(`SELECT authorization_fingerprint
        FROM execution_operator_authorizations WHERE authorization_id=$1`,
      [authorization.authorizationId]);
      if (existing.rows.length === 1) {
        if (exactRow(existing.rows[0], ['authorization_fingerprint'] as const)
          .authorization_fingerprint !== authorization.authorizationFingerprint) {
          throw failure('CONFLICT');
        }
        return 'REPLAYED';
      }
      if (existing.rows.length !== 0) throw failure('INVALID_DATA');
      const result = await client.query(`INSERT INTO execution_operator_authorizations (
        authorization_id,payload_version,authorization_fingerprint,generation_id,
        action,phase,context_fingerprint,nonce_hash,operator_id,issued_at,expires_at,purge_after
      ) SELECT $1,1,$2,generation_id,$4,$5,$6,$7,$8,
        TIMESTAMPTZ 'epoch'+($9::BIGINT*INTERVAL '1 millisecond'),
        TIMESTAMPTZ 'epoch'+($10::BIGINT*INTERVAL '1 millisecond'),
        TIMESTAMPTZ 'epoch'+(($10::BIGINT+14400000)*INTERVAL '1 millisecond')
        FROM execution_wallet_generations
        WHERE generation_id=$3 AND retired_at IS NULL
          AND TIMESTAMPTZ 'epoch'+($9::BIGINT*INTERVAL '1 millisecond')
            <= statement_timestamp()
          AND TIMESTAMPTZ 'epoch'+($10::BIGINT*INTERVAL '1 millisecond')
            > statement_timestamp()`, [
        authorization.authorizationId, authorization.authorizationFingerprint,
        authorization.generationId, authorization.action, authorization.phase,
        authorization.contextFingerprint, authorization.nonceHash,
        authorization.operatorId, authorization.issuedAtMs, authorization.expiresAtMs,
      ]);
      if (result.rowCount !== 1) throw failure('CONFLICT');
      return 'RECORDED';
    });
  }

  public async readQualification(qualificationId: string): Promise<ExecutionSafetyQualificationV1> {
    const parsed = patterned(
      qualificationId,
      /^execution_safety_qualification_[0-9a-f]{64}$/u,
    );
    return this.transaction((client) => qualificationForArm(client, parsed));
  }

  public async setStop(
    input: ExecutionControlCommandV1,
    mode: 'ENTRY_STOP' | 'HARD_STOP',
  ): Promise<ExecutionOperationsStatusV1> {
    const command = controlCommandFrom(input);
    const identity = controlEventIdentity(command, mode);
    return this.transaction(async (client) => {
      await lockGeneration(client, command.generationId);
      const replay = await client.query(`SELECT event_fingerprint FROM execution_control_events
        WHERE event_id=$1`, [identity.eventId]);
      if (replay.rows.length === 1) {
        if (exactRow(replay.rows[0], ['event_fingerprint'] as const).event_fingerprint
          !== identity.eventFingerprint) throw failure('CONFLICT');
        return readStatus(client, command.generationId);
      }
      if (replay.rows.length !== 0) throw failure('INVALID_DATA');
      await ensureControlState(client, command.generationId);
      const state = await lockedControlState(client, command.generationId);
      let decision: ReturnType<typeof decideExecutionControlTransition>;
      try {
        decision = decideExecutionControlTransition({
          currentState: state.state,
          action: mode,
          freshQualification: false,
          unknownRisk: true,
        });
      } catch {
        throw failure('CONFLICT');
      }
      await insertControlEvent(client, identity, command, state.state, decision.nextState,
        decision.reasonCode ?? 'OPERATOR_ENTRY_STOP', null, null);
      await terminalizeActiveArmament(client, command.generationId, 'REVOKED', false);
      const updated = await client.query(`UPDATE execution_control_state SET
        state=$2,state_revision=$3::BIGINT,last_event_id=$4,
        updated_at=TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond')
        WHERE generation_id=$1 AND state_revision=$6::BIGINT`, [
        command.generationId, decision.nextState, (state.revision + 1n).toString(),
        identity.eventId, command.occurredAtMs, state.revision.toString(),
      ]);
      if (updated.rowCount !== 1) throw failure('CONFLICT');
      return readStatus(client, command.generationId);
    });
  }

  public async resume(input: ExecutionResumeCommandV1): Promise<ExecutionOperationsStatusV1> {
    const command = resumeCommandFrom(input);
    const identity = controlEventIdentity(command, 'RESUME');
    return this.transaction(async (client) => {
      await lockGeneration(client, command.generationId);
      const replay = await client.query(`SELECT event_fingerprint FROM execution_control_events
        WHERE event_id=$1`, [identity.eventId]);
      if (replay.rows.length === 1) {
        if (exactRow(replay.rows[0], ['event_fingerprint'] as const).event_fingerprint
          !== identity.eventFingerprint) throw failure('CONFLICT');
        return readStatus(client, command.generationId);
      }
      await ensureControlState(client, command.generationId);
      const state = await lockedControlState(client, command.generationId);
      const now = timestampText(exactRow(singleRow(await client.query(`SELECT
        trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms`)),
      ['now_ms'] as const).now_ms);
      const qualification = exactRow(singleRow(await client.query(`SELECT generation_id,
        qualification_fingerprint,
        trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms
        FROM execution_safety_qualifications WHERE qualification_id=$1`,
      [command.qualificationId])), [
        'generation_id', 'qualification_fingerprint', 'expires_at_ms',
      ] as const);
      if (qualification.generation_id !== command.generationId
        || timestampText(qualification.expires_at_ms) <= now
        || qualification.qualification_fingerprint !== command.authorization.contextFingerprint) {
        throw failure('PREFLIGHT_EXPIRED');
      }
      await consumeAuthorization(client, command.authorization, 'RESUME', null, now);
      const risk = exactRow(singleRow(await client.query(`SELECT unknown_block,
        EXISTS (SELECT 1 FROM execution_exposure_reservations reservation
          WHERE reservation.generation_id=risk.generation_id
            AND reservation.state='UNKNOWN_HELD') AS unknown_reservation
        FROM execution_wallet_risk_state risk WHERE generation_id=$1`,
      [command.generationId])), ['unknown_block', 'unknown_reservation'] as const);
      let decision: ReturnType<typeof decideExecutionControlTransition>;
      try {
        decision = decideExecutionControlTransition({
          currentState: state.state,
          action: 'RESUME',
          freshQualification: true,
          unknownRisk: risk.unknown_block === true || risk.unknown_reservation === true,
        });
      } catch {
        throw failure('CONFLICT');
      }
      await insertControlEvent(client, identity, command, state.state, decision.nextState,
        'OPERATOR_RESUME', command.qualificationId, command.authorization.authorizationId);
      await terminalizeActiveArmament(client, command.generationId, 'REVOKED', false);
      const updated = await client.query(`UPDATE execution_control_state SET
        state='RUNNING',state_revision=$2::BIGINT,last_event_id=$3,
        updated_at=TIMESTAMPTZ 'epoch'+($4::BIGINT*INTERVAL '1 millisecond')
        WHERE generation_id=$1 AND state_revision=$5::BIGINT`, [
        command.generationId, (state.revision + 1n).toString(), identity.eventId,
        command.occurredAtMs, state.revision.toString(),
      ]);
      if (updated.rowCount !== 1) throw failure('CONFLICT');
      return readStatus(client, command.generationId);
    });
  }

  public async arm(input: ExecutionActivationArmamentV1): Promise<ExecutionActivationArmamentV1> {
    return this.transaction(async (client) => {
      await lockGeneration(client, input.generationId);
      const existing = await client.query(`SELECT armament_fingerprint,state,
        expires_at > statement_timestamp() AS fresh
        FROM execution_activation_armaments WHERE armament_id=$1`, [input.armamentId]);
      if (existing.rows.length === 1) {
        const row = exactRow(existing.rows[0], [
          'armament_fingerprint', 'state', 'fresh',
        ] as const);
        if (row.armament_fingerprint !== input.armamentFingerprint
          || row.state !== 'ARMED' || row.fresh !== true) throw failure('CONFLICT');
        return input;
      }
      if (existing.rows.length !== 0) throw failure('INVALID_DATA');
      await terminalizeActiveArmament(client, input.generationId, 'EXPIRED', true);
      await ensureControlState(client, input.generationId);
      const state = await lockedControlState(client, input.generationId);
      if (state.state !== 'RUNNING') throw failure('CONTROL_STOPPED');
      const risk = exactRow(singleRow(await client.query(`SELECT unknown_block,
        EXISTS (SELECT 1 FROM execution_exposure_reservations reservation
          WHERE reservation.generation_id=risk.generation_id
            AND reservation.state='UNKNOWN_HELD') AS unknown_reservation
        FROM execution_wallet_risk_state risk WHERE generation_id=$1`,
      [input.generationId])), ['unknown_block', 'unknown_reservation'] as const);
      if (risk.unknown_block === true || risk.unknown_reservation === true) {
        throw failure('CONFLICT');
      }
      const now = timestampText(exactRow(singleRow(await client.query(`SELECT
        trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms`)),
      ['now_ms'] as const).now_ms);
      const qualification = await qualificationForArm(client, input.qualificationId);
      const armament = armamentFrom(input, qualification);
      if (armament.expiresAtMs <= now || qualification.expiresAtMs <= now) {
        throw failure('PREFLIGHT_EXPIRED');
      }
      await consumeAuthorization(client, authorizationForArm(armament), 'ARM', armament.phase, now);
      const result = await client.query(`INSERT INTO execution_activation_armaments (
        armament_id,payload_version,armament_fingerprint,qualification_id,
        qualification_fingerprint,generation_id,authorization_id,state,state_revision,phase,
        build_hash,configuration_fingerprint,strategy_fingerprint,wallet_public_key,
        cluster,genesis_hash,provider_id,maximum_buys,consumed_buys,
        maximum_capital_lamports,maximum_exposure_bps,maximum_open_positions,
        maximum_holding_ms,operator_id,operator_reason,armed_at,expires_at
      ) VALUES ($1,1,$2,$3,$4,$5,$6,'ARMED',0,$7,$8,$9,$10,$11,$12,$13,$14,
        $15,0,$16::NUMERIC,$17::NUMERIC,$18,$19,$20,$21,
        TIMESTAMPTZ 'epoch'+($22::BIGINT*INTERVAL '1 millisecond'),
        TIMESTAMPTZ 'epoch'+($23::BIGINT*INTERVAL '1 millisecond'))`, [
        armament.armamentId, armament.armamentFingerprint, armament.qualificationId,
        armament.qualificationFingerprint, armament.generationId, armament.authorizationId,
        armament.phase, armament.buildHash, armament.configurationFingerprint,
        armament.strategyFingerprint, armament.walletPublicKey, armament.cluster,
        armament.genesisHash, armament.providerId, armament.maximumBuys,
        armament.maximumCapitalLamports.toString(), armament.maximumExposureBps.toString(),
        armament.maximumOpenPositions, armament.maximumHoldingMs, armament.operatorId,
        armament.operatorReason, armament.armedAtMs, armament.expiresAtMs,
      ]);
      if (result.rowCount !== 1) throw failure('CONFLICT');
      const eventFingerprint = hash(['execution-activation-event-v1', armament.armamentId,
        null, 'ARMED', 'OPERATOR_ARMED', armament.armedAtMs]);
      const event = await client.query(`INSERT INTO execution_activation_events (
        event_id,payload_version,event_fingerprint,armament_id,generation_id,
        previous_state,next_state,reason_code,occurred_at
      ) VALUES ($1,1,$2,$3,$4,NULL,'ARMED','OPERATOR_ARMED',
        TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond'))`, [
        `execution_activation_event_${eventFingerprint}`, eventFingerprint,
        armament.armamentId, armament.generationId, armament.armedAtMs,
      ]);
      if (event.rowCount !== 1) throw failure('INVALID_DATA');
      return armament;
    });
  }

  public async readStatus(generationId: string): Promise<ExecutionOperationsStatusV1> {
    const parsed = generationIdFrom(generationId);
    return this.transaction((client) => readStatus(client, parsed));
  }

  private async transaction<T>(operation: (client: DatabaseClient) => Promise<T>): Promise<T> {
    let client: DatabaseClient | null = null;
    try {
      client = await this.#source.connect();
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      client.release();
      return result;
    } catch (error) {
      if (client !== null) {
        try { await client.query('ROLLBACK'); } catch { /* fixed redacted failure below */ }
        client.release(true);
      }
      if (error instanceof ExecutionOperationsRepositoryError && INTERNAL_ERRORS.has(error)) throw error;
      if (databaseCode(error) === '23505' || databaseCode(error) === '23503') {
        throw failure('CONFLICT');
      }
      throw failure('DATABASE_FAILURE');
    }
  }
}

async function verifyMainnetSimulationEvidence(
  client: DatabaseClient,
  qualification: ExecutionSafetyQualificationV1,
): Promise<void> {
  const gate = qualification.gates[10];
  if (gate?.gateId !== 'MAINNET_PREFLIGHT_SIMULATED') {
    throw failure('INVALID_DATA');
  }
  const artifact = exactRow(singleRow(await client.query(`SELECT result_fingerprint,result_kind,
    provider_id,executor_public_key,expected_genesis_hash,observed_genesis_hash,
    configuration_fingerprint,build_fingerprint,
    trunc(EXTRACT(EPOCH FROM recorded_at)*1000)::TEXT AS recorded_at_ms
    FROM execution_simulation_artifacts WHERE artifact_id=$1`, [gate.evidenceId])), [
    'result_fingerprint', 'result_kind', 'provider_id', 'executor_public_key',
    'expected_genesis_hash', 'observed_genesis_hash', 'configuration_fingerprint',
    'build_fingerprint', 'recorded_at_ms',
  ] as const);
  const recordedAtMs = timestampText(artifact.recorded_at_ms);
  const expectedFingerprint = createMainnetSimulationEvidenceFingerprint({
    artifactId: gate.evidenceId,
    resultFingerprint: artifact.result_fingerprint,
    buildHash: qualification.buildHash,
    configurationFingerprint: qualification.configurationFingerprint,
    strategyFingerprint: qualification.strategyFingerprint,
    walletPublicKey: qualification.walletPublicKey,
    genesisHash: qualification.genesisHash,
    providerId: qualification.providerId,
  });
  if (artifact.result_kind !== 'SUCCESS'
    || artifact.provider_id !== qualification.providerId
    || artifact.executor_public_key !== qualification.walletPublicKey
    || artifact.expected_genesis_hash !== qualification.genesisHash
    || artifact.observed_genesis_hash !== qualification.genesisHash
    || artifact.configuration_fingerprint !== qualification.configurationFingerprint
    || artifact.build_fingerprint !== qualification.buildHash
    || recordedAtMs !== gate.observedAtMs
    || recordedAtMs > qualification.qualifiedAtMs
    || gate.evidenceFingerprint !== expectedFingerprint) throw failure('CONFLICT');
}

async function readStatus(
  client: DatabaseClient,
  generationId: string,
): Promise<ExecutionOperationsStatusV1> {
  const generation = await client.query(`SELECT generation_id FROM execution_wallet_generations
    WHERE generation_id=$1 AND retired_at IS NULL`, [generationId]);
  if (generation.rows.length !== 1) throw failure('CONFLICT');
  const control = await client.query(`SELECT state,state_revision::TEXT AS state_revision
    FROM execution_control_state WHERE generation_id=$1`, [generationId]);
  if (control.rows.length > 1) throw failure('INVALID_DATA');
  const controlRow = control.rows.length === 0 ? null
    : exactRow(control.rows[0], ['state', 'state_revision'] as const);
  const qualification = await client.query(`SELECT qualification_id,
    trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms
    FROM execution_safety_qualifications WHERE generation_id=$1
    ORDER BY qualified_at DESC,qualification_id DESC LIMIT 1`, [generationId]);
  const armament = await client.query(`SELECT armament_id,phase,
    trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms
    FROM execution_activation_armaments WHERE generation_id=$1
      AND state IN ('ARMED','LOCKED') AND expires_at > statement_timestamp()
    ORDER BY armed_at DESC LIMIT 1`, [generationId]);
  const qualificationRow = qualification.rows.length === 0 ? null
    : exactRow(qualification.rows[0], ['qualification_id', 'expires_at_ms'] as const);
  const armamentRow = armament.rows.length === 0 ? null
    : exactRow(armament.rows[0], ['armament_id', 'phase', 'expires_at_ms'] as const);
  const state = controlRow?.state ?? 'ENTRY_STOP';
  if (state !== 'RUNNING' && state !== 'ENTRY_STOP' && state !== 'HARD_STOP') {
    throw failure('INVALID_DATA');
  }
  const phase = armamentRow?.phase ?? null;
  if (phase !== null && phase !== 'CANARY' && phase !== 'MICRO_LIVE' && phase !== 'PILOT') {
    throw failure('INVALID_DATA');
  }
  return Object.freeze({
    payloadVersion: 1,
    generationId,
    controlState: state,
    controlRevision: controlRow === null ? 0n : unsignedBigint(controlRow.state_revision),
    latestQualificationId: qualificationRow === null ? null : String(qualificationRow.qualification_id),
    latestQualificationExpiresAtMs: qualificationRow === null
      ? null : timestampText(qualificationRow.expires_at_ms),
    activeArmamentId: armamentRow === null ? null : String(armamentRow.armament_id),
    activeArmamentPhase: phase,
    activeArmamentExpiresAtMs: armamentRow === null ? null : timestampText(armamentRow.expires_at_ms),
  });
}

async function terminalizeActiveArmament(
  client: DatabaseClient,
  generationId: string,
  nextState: 'REVOKED' | 'EXPIRED',
  expiredOnly: boolean,
): Promise<void> {
  const result = await client.query(`SELECT armament_id,state,state_revision::TEXT AS revision,
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms
    FROM execution_activation_armaments WHERE generation_id=$1
      AND state IN ('ARMED','LOCKED')
      AND ($2::BOOLEAN=FALSE OR expires_at <= statement_timestamp())
    FOR UPDATE`, [generationId, expiredOnly]);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  if (result.rows.length === 0) return;
  const row = exactRow(result.rows[0], ['armament_id', 'state', 'revision', 'now_ms'] as const);
  if ((row.state !== 'ARMED' && row.state !== 'LOCKED')
    || typeof row.armament_id !== 'string') throw failure('INVALID_DATA');
  const revision = unsignedBigint(row.revision);
  const occurredAtMs = timestampText(row.now_ms);
  const updated = await client.query(`UPDATE execution_activation_armaments SET
    state=$2,state_revision=$3::BIGINT,
    terminal_at=TIMESTAMPTZ 'epoch'+($4::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($4::BIGINT+14400000)*INTERVAL '1 millisecond')
    WHERE armament_id=$1 AND state=$5 AND state_revision=$6::BIGINT`, [
    row.armament_id, nextState, (revision + 1n).toString(), occurredAtMs,
    row.state, revision.toString(),
  ]);
  if (updated.rowCount !== 1) throw failure('CONFLICT');
  const reasonCode = nextState === 'EXPIRED' ? 'ARMAMENT_EXPIRED' : 'ARMAMENT_REVOKED';
  const eventFingerprint = hash([
    'execution-activation-event-v1', row.armament_id, row.state,
    nextState, reasonCode, occurredAtMs,
  ]);
  const event = await client.query(`INSERT INTO execution_activation_events (
    event_id,payload_version,event_fingerprint,armament_id,generation_id,
    previous_state,next_state,reason_code,occurred_at
  ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,
    TIMESTAMPTZ 'epoch'+($8::BIGINT*INTERVAL '1 millisecond'))`, [
    `execution_activation_event_${eventFingerprint}`, eventFingerprint,
    row.armament_id, generationId, row.state, nextState, reasonCode, occurredAtMs,
  ]);
  if (event.rowCount !== 1) throw failure('INVALID_DATA');
}

async function ensureControlState(client: DatabaseClient, generationId: string): Promise<void> {
  await client.query(`INSERT INTO execution_control_state (generation_id)
    SELECT generation_id FROM execution_wallet_generations
    WHERE generation_id=$1 AND retired_at IS NULL ON CONFLICT DO NOTHING`, [generationId]);
}

async function lockedControlState(
  client: DatabaseClient,
  generationId: string,
): Promise<Readonly<{
  state: 'RUNNING' | 'ENTRY_STOP' | 'HARD_STOP';
  revision: bigint;
}>> {
  const row = exactRow(singleRow(await client.query(`SELECT state,state_revision::TEXT AS revision
    FROM execution_control_state WHERE generation_id=$1 FOR UPDATE`, [generationId])),
  ['state', 'revision'] as const);
  if (row.state !== 'RUNNING' && row.state !== 'ENTRY_STOP' && row.state !== 'HARD_STOP') {
    throw failure('INVALID_DATA');
  }
  return Object.freeze({ state: row.state, revision: unsignedBigint(row.revision) });
}

async function lockGeneration(client: DatabaseClient, generationId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))', [generationId]);
}

async function insertControlEvent(
  client: DatabaseClient,
  identity: Readonly<{ eventId: string; eventFingerprint: string }>,
  command: ExecutionControlCommandV1,
  previousState: string,
  nextState: string,
  reasonCode: string,
  qualificationId: string | null,
  authorizationId: string | null,
): Promise<void> {
  const result = await client.query(`INSERT INTO execution_control_events (
    event_id,payload_version,event_fingerprint,generation_id,previous_state,next_state,
    reason_code,qualification_id,authorization_id,operator_id,occurred_at
  ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,
    TIMESTAMPTZ 'epoch'+($10::BIGINT*INTERVAL '1 millisecond'))`, [
    identity.eventId, identity.eventFingerprint, command.generationId, previousState,
    nextState, reasonCode, qualificationId, authorizationId, command.operatorId,
    command.occurredAtMs,
  ]);
  if (result.rowCount !== 1) throw failure('INVALID_DATA');
}

async function consumeAuthorization(
  client: DatabaseClient,
  authorization: ExecutionOperatorAuthorizationV1,
  action: 'ARM' | 'RESUME',
  phase: string | null,
  consumedAtMs: number,
): Promise<void> {
  const result = await client.query(`UPDATE execution_operator_authorizations SET
    consumed_at=TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($5::BIGINT+14400000)*INTERVAL '1 millisecond')
    WHERE authorization_id=$1 AND authorization_fingerprint=$2
      AND generation_id=$3 AND action=$4 AND phase IS NOT DISTINCT FROM $6
      AND context_fingerprint=$7 AND operator_id=$8 AND consumed_at IS NULL
      AND issued_at <= TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond')
      AND expires_at >= TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond')`, [
    authorization.authorizationId, authorization.authorizationFingerprint,
    authorization.generationId, action, consumedAtMs, phase,
    authorization.contextFingerprint, authorization.operatorId,
  ]);
  if (result.rowCount !== 1) throw failure('CONFLICT');
}

async function qualificationForArm(
  client: DatabaseClient,
  qualificationId: string,
): Promise<ExecutionSafetyQualificationV1> {
  const row = exactRow(singleRow(await client.query(`SELECT
    qualification_id,payload_version,evaluator_version,qualification_fingerprint,
    phase,build_hash,configuration_fingerprint,strategy_fingerprint,generation_id,
    wallet_public_key,cluster,genesis_hash,provider_id,
    trunc(EXTRACT(EPOCH FROM qualified_at)*1000)::TEXT AS qualified_at_ms,
    trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms
    FROM execution_safety_qualifications WHERE qualification_id=$1`,
  [qualificationId])), [
    'qualification_id', 'payload_version', 'evaluator_version', 'qualification_fingerprint',
    'phase', 'build_hash', 'configuration_fingerprint', 'strategy_fingerprint',
    'generation_id', 'wallet_public_key', 'cluster', 'genesis_hash', 'provider_id',
    'qualified_at_ms', 'expires_at_ms',
  ] as const);
  const evidence = await client.query(`SELECT payload_version,gate_id,status,evidence_type,
    evidence_id,evidence_fingerprint,
    trunc(EXTRACT(EPOCH FROM observed_at)*1000)::TEXT AS observed_at_ms,
    trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms
    FROM execution_safety_gate_evidence WHERE qualification_id=$1 ORDER BY gate_index`,
  [qualificationId]);
  const canonical = createSafetyQualification({
    payloadVersion: row.payload_version, evaluatorVersion: row.evaluator_version,
    phase: row.phase, buildHash: row.build_hash,
    configurationFingerprint: row.configuration_fingerprint,
    strategyFingerprint: row.strategy_fingerprint, generationId: row.generation_id,
    walletPublicKey: row.wallet_public_key, cluster: row.cluster, genesisHash: row.genesis_hash,
    providerId: row.provider_id, qualifiedAtMs: timestampText(row.qualified_at_ms),
    expiresAtMs: timestampText(row.expires_at_ms),
    gates: evidence.rows.map((item) => {
      const gate = exactRow(item, [
        'payload_version', 'gate_id', 'status', 'evidence_type', 'evidence_id',
        'evidence_fingerprint', 'observed_at_ms', 'expires_at_ms',
      ] as const);
      return {
        payloadVersion: gate.payload_version, gateId: gate.gate_id, status: gate.status,
        evidenceType: gate.evidence_type, evidenceId: gate.evidence_id,
        evidenceFingerprint: gate.evidence_fingerprint,
        observedAtMs: timestampText(gate.observed_at_ms),
        expiresAtMs: timestampText(gate.expires_at_ms),
      };
    }),
  });
  if (canonical.qualificationId !== row.qualification_id
    || canonical.qualificationFingerprint !== row.qualification_fingerprint) {
    throw failure('INVALID_DATA');
  }
  return canonical;
}

function armamentFrom(
  input: ExecutionActivationArmamentV1,
  qualification: ExecutionSafetyQualificationV1,
): ExecutionActivationArmamentV1 {
  const canonical = createExecutionArmament({
    payloadVersion: input.payloadVersion, qualification,
    maximumBuys: input.maximumBuys, maximumCapitalLamports: input.maximumCapitalLamports,
    maximumExposureBps: input.maximumExposureBps,
    maximumOpenPositions: input.maximumOpenPositions, maximumHoldingMs: input.maximumHoldingMs,
    armedAtMs: input.armedAtMs, expiresAtMs: input.expiresAtMs,
    operatorId: input.operatorId, operatorReason: input.operatorReason,
    authorizationId: input.authorizationId,
    authorizationFingerprint: input.authorizationFingerprint,
  });
  if (canonical.armamentId !== input.armamentId
    || canonical.armamentFingerprint !== input.armamentFingerprint) throw failure('CONFLICT');
  return canonical;
}

function authorizationForArm(
  armament: ExecutionActivationArmamentV1,
): ExecutionOperatorAuthorizationV1 {
  return Object.freeze({
    authorizationId: armament.authorizationId,
    payloadVersion: 1,
    authorizationFingerprint: armament.authorizationFingerprint,
    generationId: armament.generationId,
    action: 'ARM',
    phase: armament.phase,
    contextFingerprint: armament.qualificationFingerprint,
    nonceHash: '0'.repeat(64),
    operatorId: armament.operatorId,
    issuedAtMs: armament.armedAtMs,
    expiresAtMs: armament.expiresAtMs,
  });
}

function qualificationFrom(input: ExecutionSafetyQualificationV1): ExecutionSafetyQualificationV1 {
  const canonical = createSafetyQualification({
    payloadVersion: input.payloadVersion, evaluatorVersion: input.evaluatorVersion,
    phase: input.phase, buildHash: input.buildHash,
    configurationFingerprint: input.configurationFingerprint,
    strategyFingerprint: input.strategyFingerprint, generationId: input.generationId,
    walletPublicKey: input.walletPublicKey, cluster: input.cluster, genesisHash: input.genesisHash,
    providerId: input.providerId, qualifiedAtMs: input.qualifiedAtMs,
    expiresAtMs: input.expiresAtMs, gates: input.gates,
  });
  if (canonical.qualificationId !== input.qualificationId
    || canonical.qualificationFingerprint !== input.qualificationFingerprint) throw failure('CONFLICT');
  return canonical;
}

function authorizationFrom(input: ExecutionOperatorAuthorizationV1): ExecutionOperatorAuthorizationV1 {
  const canonical = createOperatorAuthorization({
    payloadVersion: input.payloadVersion, generationId: input.generationId,
    action: input.action, phase: input.phase, contextFingerprint: input.contextFingerprint,
    nonceHash: input.nonceHash, operatorId: input.operatorId,
    issuedAtMs: input.issuedAtMs, expiresAtMs: input.expiresAtMs,
  });
  if (canonical.authorizationId !== input.authorizationId
    || canonical.authorizationFingerprint !== input.authorizationFingerprint) {
    throw failure('CONFLICT');
  }
  return canonical;
}

function controlCommandFrom(input: ExecutionControlCommandV1): ExecutionControlCommandV1 {
  return Object.freeze({
    payloadVersion: 1,
    commandId: patterned(input.commandId, /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u),
    generationId: generationIdFrom(input.generationId),
    operatorId: patterned(input.operatorId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    occurredAtMs: timestamp(input.occurredAtMs),
  });
}

function resumeCommandFrom(input: ExecutionResumeCommandV1): ExecutionResumeCommandV1 {
  const base = controlCommandFrom(input);
  const authorization = authorizationFrom(input.authorization);
  if (authorization.action !== 'RESUME' || authorization.generationId !== base.generationId
    || authorization.operatorId !== base.operatorId) throw failure('CONFLICT');
  return Object.freeze({
    ...base,
    qualificationId: patterned(
      input.qualificationId,
      /^execution_safety_qualification_[0-9a-f]{64}$/u,
    ),
    authorization,
  });
}

function controlEventIdentity(
  command: ExecutionControlCommandV1,
  action: string,
): Readonly<{ eventId: string; eventFingerprint: string }> {
  const eventFingerprint = hash(['execution-control-event-v1', command.commandId,
    command.generationId, command.operatorId, command.occurredAtMs, action]);
  return Object.freeze({
    eventId: `execution_control_event_${eventFingerprint}`,
    eventFingerprint,
  });
}

function generationIdFrom(value: string): string {
  return patterned(value, /^execution_wallet_generation_[0-9a-f]{64}$/u);
}

function patterned(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw failure('INVALID_DATA');
  return value;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > 8_640_000_000_000_000) throw failure('INVALID_DATA');
  return value as number;
}

function timestampText(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw failure('INVALID_DATA');
  }
  return timestamp(Number(value));
}

function unsignedBigint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw failure('INVALID_DATA');
  }
  return BigInt(value);
}

function exactRow<const Keys extends readonly string[]>(
  value: Readonly<Record<string, unknown>> | undefined,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (value === undefined || Reflect.ownKeys(value).length !== keys.length) throw failure('INVALID_DATA');
  for (const key of keys) if (!Object.hasOwn(value, key)) throw failure('INVALID_DATA');
  return value;
}

function singleRow(result: QueryResult): Readonly<Record<string, unknown>> {
  const [row] = result.rows;
  if (result.rows.length !== 1 || row === undefined) throw failure('INVALID_DATA');
  return row;
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

function failure(code: RepositoryErrorCode): ExecutionOperationsRepositoryError {
  const error = new ExecutionOperationsRepositoryError(code);
  INTERNAL_ERRORS.add(error);
  return error;
}
