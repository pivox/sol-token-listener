import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  createExecutionArmament,
  createExecutionArmamentRequestV2,
  createExecutionArmamentV2,
  createOperatorAuthorization,
  createOperatorAuthorizationV2,
  decideExecutionControlTransition,
  type ExecutionActivationArmamentV1,
  type ExecutionActivationArmamentV2,
  type ExecutionArmamentRequestV2,
  type ExecutionOperatorAuthorizationV1,
  type ExecutionOperatorAuthorizationV2,
} from '../domain/execution-operations.js';
import {
  createExecutionIntentDraft,
  type ExecutionIntentV1,
} from '../domain/execution-intent.js';
import { ExecutionAdmissionService } from '../executor-risk/admission-service.js';
import {
  createMainnetSimulationEvidenceFingerprint,
  createSafetyQualification,
  type ExecutionSafetyQualificationV1,
} from '../domain/execution-safety-qualification.js';
import type {
  ExecutionCanaryArmamentRepository,
  ExecutionCanaryTargetIntentV1,
  ExecutionControlCommandV1,
  ExecutionOperationsRepository,
  ExecutionOperationsStatusV1,
  ExecutionResumeCommandV1,
} from '../ports/execution-operations-repository.js';
import type {
  ExecutionBuyAdmissionInputV1,
  ExecutionBuyAdmissionResultV1,
} from '../ports/execution-risk-repository.js';
import {
  admitBuyInTransaction,
  appendProviderUsageInTransaction,
  appendWalletSnapshotInTransaction,
  ExecutionRiskRepositoryError,
} from './execution-risk.repository.js';

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

export class PostgresExecutionOperationsRepository implements
  ExecutionOperationsRepository, ExecutionCanaryArmamentRepository {
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
      await lockGeneration(client, authorization.generationId);
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

  public async readTargetIntent(intentId: string): Promise<ExecutionCanaryTargetIntentV1> {
    const parsed = patterned(intentId, /^execution_intent_[0-9a-f]{64}$/u);
    return this.transaction(async (client) => {
      const row = exactRow(singleRow(await client.query(`SELECT id,side,status,lease_owner,
        CASE WHEN lease_expires_at IS NULL THEN NULL
          ELSE trunc(EXTRACT(EPOCH FROM lease_expires_at)*1000)::TEXT END AS lease_expires_at_ms,
        state_revision::TEXT AS state_revision,strategy_id,strategy_version,decision_fingerprint,
        mint,quote_mint,quote_amount_raw::TEXT AS quote_amount_raw,
        trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms
        FROM execution_intents WHERE id=$1`, [parsed])), [
        'id', 'side', 'status', 'lease_owner', 'lease_expires_at_ms', 'state_revision',
        'strategy_id', 'strategy_version', 'decision_fingerprint', 'mint', 'quote_mint',
        'quote_amount_raw', 'expires_at_ms',
      ] as const);
      if (row.side !== 'BUY' || row.status !== 'PENDING'
        || (row.lease_owner !== null && typeof row.lease_owner !== 'string')
        || (row.lease_expires_at_ms !== null && typeof row.lease_expires_at_ms !== 'string')
        || typeof row.strategy_id !== 'string' || typeof row.strategy_version !== 'number'
        || !Number.isSafeInteger(row.strategy_version) || row.strategy_version < 1
        || typeof row.decision_fingerprint !== 'string' || typeof row.mint !== 'string'
        || typeof row.quote_mint !== 'string' || typeof row.quote_amount_raw !== 'string') {
        throw failure('CONFLICT');
      }
      return Object.freeze({
        intentId: patterned(row.id, /^execution_intent_[0-9a-f]{64}$/u),
        side: 'BUY', status: 'PENDING', leaseOwner: row.lease_owner,
        leaseExpiresAtMs: row.lease_expires_at_ms === null ? null : timestampText(row.lease_expires_at_ms),
        stateRevision: unsignedBigint(row.state_revision),
        strategyId: patterned(row.strategy_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
        strategyVersion: row.strategy_version,
        decisionFingerprint: patterned(row.decision_fingerprint, /^[0-9a-f]{64}$/u),
        mint: patterned(row.mint, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u),
        quoteMint: patterned(row.quote_mint, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u),
        quoteAmountRaw: unsignedBigint(row.quote_amount_raw),
        expiresAtMs: timestampText(row.expires_at_ms),
      });
    });
  }

  public async armCanary(input: Readonly<{
    request: ExecutionArmamentRequestV2;
    authorization: ExecutionOperatorAuthorizationV2;
  }>): Promise<ExecutionActivationArmamentV2> {
    const request = canaryRequestFrom(input.request);
    const authorization = canaryAuthorizationFrom(input.authorization);
    if (authorization.generationId !== request.qualification.generationId
      || authorization.action !== 'ARM' || authorization.phase !== 'CANARY'
      || authorization.contextFingerprint !== request.armamentRequestFingerprint
      || authorization.operatorId !== request.operatorId) throw failure('CONFLICT');
    const outcome = await this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(
        hashtextextended('execution-live-sell-presence:v1', 51008))`);
      await lockGeneration(client, request.qualification.generationId);
      const nowMs = await databaseNowMs(client);
      const replay = await findCanaryReplay(client, request, authorization);
      if (replay?.kind === 'REPLAY') return replay;
      if (replay?.kind === 'STALE') {
        await terminalizeActiveArmament(client, request.qualification.generationId, 'EXPIRED', true);
        return replay;
      }
      const target = await lockedCanaryTarget(client, request.target.intentId);
      assertCanaryRequestTarget(request, target, nowMs);
      await ensureControlState(client, request.qualification.generationId);
      const control = await lockedControlState(client, request.qualification.generationId);
      if (control.state !== 'RUNNING') throw failure('CONTROL_STOPPED');
      const qualification = await qualificationForArm(client, request.qualification.qualificationId);
      assertCanaryQualification(request, qualification, nowMs);
      await terminalizeActiveArmament(client, request.qualification.generationId, 'EXPIRED', true);
      const active = await client.query(`SELECT armament_id FROM execution_activation_armaments
        WHERE generation_id=$1 AND state IN ('ARMED','LOCKED')
          AND expires_at > statement_timestamp() FOR UPDATE`, [request.qualification.generationId]);
      if (active.rows.length !== 0) throw failure('CONFLICT');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51006))', [
        request.providerSnapshot.providerId,
      ]);
      const walletSnapshot = await appendWalletSnapshotInTransaction(
        client,
        request.walletSnapshot,
      );
      const providerSnapshot = await appendProviderUsageInTransaction(
        client,
        request.providerSnapshot,
      );
      await assertCanarySnapshotsCurrent(client, request, walletSnapshot, providerSnapshot, nowMs);
      let admission: ExecutionBuyAdmissionResultV1;
      try {
        admission = await new ExecutionAdmissionService({
          admitBuy: (value: ExecutionBuyAdmissionInputV1): Promise<ExecutionBuyAdmissionResultV1> => (
            admitBuyInTransaction(client, value)
          ),
        }).admit(Object.freeze({
          payloadVersion: 1,
          intent: target.intent,
          policy: request.policy,
          generationId: request.qualification.generationId,
          walletSnapshot,
          providerSnapshot,
          allEndpointsUnavailable: request.allEndpointsUnavailable,
          nowMs,
        }));
      } catch (error) {
        if (error instanceof ExecutionRiskRepositoryError) throw failure('CONFLICT');
        throw error;
      }
      if (admission.decision !== 'ADMITTED' || admission.reservationId === null) {
        throw failure('CONFLICT');
      }
      await consumeCanaryAuthorization(client, authorization, nowMs);
      const armament = createExecutionArmamentV2({
        payloadVersion: 2,
        request,
        authorizationId: authorization.authorizationId,
        authorizationFingerprint: authorization.authorizationFingerprint,
        admissionReportId: admission.reportId,
        reservationId: admission.reservationId,
      });
      await insertCanaryArmament(client, armament);
      await insertCanaryArmamentEvent(client, armament, nowMs);
      return Object.freeze({ kind: 'REPLAY' as const, armament });
    });
    if (outcome.kind === 'STALE') throw failure('CONFLICT');
    return outcome.armament;
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
      if (databaseCode(error) === '23505' || databaseCode(error) === '23503'
        || databaseCode(error) === '55000') {
        throw failure('CONFLICT');
      }
      throw failure('DATABASE_FAILURE');
    }
  }
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

interface LockedCanaryTarget {
  readonly intent: ExecutionIntentV1;
}

function canaryRequestFrom(input: ExecutionArmamentRequestV2): ExecutionArmamentRequestV2 {
  try {
    const canonical = createExecutionArmamentRequestV2({
      payloadVersion: input.payloadVersion,
      qualification: input.qualification,
      targetIntentId: input.targetIntentId,
      policy: input.policy,
      walletSnapshot: input.walletSnapshot,
      providerSnapshot: input.providerSnapshot,
      allEndpointsUnavailable: input.allEndpointsUnavailable,
      capturedAtMs: input.capturedAtMs,
      expiresAtMs: input.expiresAtMs,
      target: input.target,
      maximumBuys: input.maximumBuys,
      maximumCapitalLamports: input.maximumCapitalLamports,
      maximumExposureBps: input.maximumExposureBps,
      maximumOpenPositions: input.maximumOpenPositions,
      maximumHoldingMs: input.maximumHoldingMs,
      runtimeQuoteMaxAgeMs: input.runtimeQuoteMaxAgeMs,
      runtimeSlippageBps: input.runtimeSlippageBps,
      runtimeSnapshotMaxSlotLag: input.runtimeSnapshotMaxSlotLag,
      runtimeMaxComputeUnits: input.runtimeMaxComputeUnits,
      runtimeMaxFeeLamports: input.runtimeMaxFeeLamports,
      runtimeMaxFeePayerLamportDebit: input.runtimeMaxFeePayerLamportDebit,
      runtimeMaxRpcCallsPerAttempt: input.runtimeMaxRpcCallsPerAttempt,
      runtimeLeaseMs: input.runtimeLeaseMs,
      armedAtMs: input.armedAtMs,
      armamentExpiresAtMs: input.armamentExpiresAtMs,
      operatorId: input.operatorId,
      operatorReason: input.operatorReason,
    });
    if (!Object.isFrozen(input)
      || input.evidenceId !== canonical.evidenceId
      || input.evidenceFingerprint !== canonical.evidenceFingerprint
      || input.armamentRequestFingerprint !== canonical.armamentRequestFingerprint) {
      throw new TypeError();
    }
    return canonical;
  } catch {
    throw failure('CONFLICT');
  }
}

function canaryAuthorizationFrom(
  input: ExecutionOperatorAuthorizationV2,
): ExecutionOperatorAuthorizationV2 {
  try {
    const canonical = createOperatorAuthorizationV2({
      payloadVersion: input.payloadVersion,
      generationId: input.generationId,
      action: input.action,
      phase: input.phase,
      contextFingerprint: input.contextFingerprint,
      nonceHash: input.nonceHash,
      operatorId: input.operatorId,
      issuedAtMs: input.issuedAtMs,
      expiresAtMs: input.expiresAtMs,
    });
    if (!Object.isFrozen(input)
      || input.authorizationId !== canonical.authorizationId
      || input.authorizationFingerprint !== canonical.authorizationFingerprint) {
      throw new TypeError();
    }
    return canonical;
  } catch {
    throw failure('CONFLICT');
  }
}

async function databaseNowMs(client: DatabaseClient): Promise<number> {
  const row = exactRow(singleRow(await client.query(`SELECT
    trunc(EXTRACT(EPOCH FROM date_trunc('milliseconds',statement_timestamp()))*1000)::TEXT
      AS now_ms`)), ['now_ms'] as const);
  return timestampText(row.now_ms);
}

async function findCanaryReplay(
  client: DatabaseClient,
  request: ExecutionArmamentRequestV2,
  authorization: ExecutionOperatorAuthorizationV2,
): Promise<Readonly<{ kind: 'REPLAY'; armament: ExecutionActivationArmamentV2 }>
  | Readonly<{ kind: 'STALE' }> | null> {
  const result = await client.query(`SELECT armament_id,armament_fingerprint,payload_version,
    state,expires_at > statement_timestamp() AS fresh,authorization_id,
    target_admission_report_id,target_reservation_id
    FROM execution_activation_armaments
    WHERE armament_request_fingerprint=$1 FOR UPDATE`, [request.armamentRequestFingerprint]);
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw failure('INVALID_DATA');
  const row = exactRow(result.rows[0], [
    'armament_id', 'armament_fingerprint', 'payload_version', 'state', 'fresh',
    'authorization_id', 'target_admission_report_id', 'target_reservation_id',
  ] as const);
  if (row.payload_version !== 2 || row.state !== 'ARMED'
    || row.authorization_id !== authorization.authorizationId
    || row.target_admission_report_id === null || row.target_reservation_id === null
    || typeof row.target_admission_report_id !== 'string'
    || typeof row.target_reservation_id !== 'string') throw failure('CONFLICT');
  if (row.fresh !== true) return Object.freeze({ kind: 'STALE' as const });
  let canonical: ExecutionActivationArmamentV2;
  try {
    canonical = createExecutionArmamentV2({
      payloadVersion: 2,
      request,
      authorizationId: authorization.authorizationId,
      authorizationFingerprint: authorization.authorizationFingerprint,
      admissionReportId: row.target_admission_report_id,
      reservationId: row.target_reservation_id,
    });
  } catch {
    throw failure('INVALID_DATA');
  }
  if (row.armament_id !== canonical.armamentId
    || row.armament_fingerprint !== canonical.armamentFingerprint) throw failure('CONFLICT');
  return Object.freeze({ kind: 'REPLAY' as const, armament: canonical });
}

async function lockedCanaryTarget(
  client: DatabaseClient,
  intentId: string,
): Promise<LockedCanaryTarget> {
  const row = exactRow(singleRow(await client.query(`SELECT id,payload_version,logical_order_key,
    strategy_id,strategy_version,position_id,logical_command_id,mint,side,venue_policy,
    quote_mint,quote_token_program,quote_decimals,quote_amount_raw::TEXT AS quote_amount_raw,
    base_amount_raw::TEXT AS base_amount_raw,minimum_amount_out_raw::TEXT AS minimum_amount_out_raw,
    decision_event_id,decision_fingerprint,
    trunc(EXTRACT(EPOCH FROM requested_at)*1000)::TEXT AS requested_at_ms,
    trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms,status,attempt_count,
    state_revision::TEXT AS state_revision,last_reason_code,
    CASE WHEN terminal_at IS NULL THEN NULL ELSE trunc(EXTRACT(EPOCH FROM terminal_at)*1000)::TEXT END
      AS terminal_at_ms,
    CASE WHEN reconciliation_completed_at IS NULL THEN NULL
      ELSE trunc(EXTRACT(EPOCH FROM reconciliation_completed_at)*1000)::TEXT END
      AS reconciliation_completed_at_ms,
    CASE WHEN purge_after IS NULL THEN NULL ELSE trunc(EXTRACT(EPOCH FROM purge_after)*1000)::TEXT END
      AS purge_after_ms,
    trunc(EXTRACT(EPOCH FROM created_at)*1000)::TEXT AS created_at_ms,
    trunc(EXTRACT(EPOCH FROM updated_at)*1000)::TEXT AS updated_at_ms,
    lease_owner,lease_token::TEXT AS lease_token,
    CASE WHEN lease_expires_at IS NULL THEN NULL
      ELSE trunc(EXTRACT(EPOCH FROM lease_expires_at)*1000)::TEXT END AS lease_expires_at_ms
    FROM execution_intents WHERE id=$1 FOR UPDATE`, [intentId])), [
    'id', 'payload_version', 'logical_order_key', 'strategy_id', 'strategy_version',
    'position_id', 'logical_command_id', 'mint', 'side', 'venue_policy', 'quote_mint',
    'quote_token_program', 'quote_decimals', 'quote_amount_raw', 'base_amount_raw',
    'minimum_amount_out_raw', 'decision_event_id', 'decision_fingerprint',
    'requested_at_ms', 'expires_at_ms', 'status', 'attempt_count', 'state_revision',
    'last_reason_code', 'terminal_at_ms', 'reconciliation_completed_at_ms',
    'purge_after_ms', 'created_at_ms', 'updated_at_ms', 'lease_owner', 'lease_token',
    'lease_expires_at_ms',
  ] as const);
  try {
    const draft = createExecutionIntentDraft({
      strategyId: row.strategy_id,
      strategyVersion: row.strategy_version,
      positionId: row.position_id,
      logicalCommandId: row.logical_command_id,
      mint: row.mint,
      side: row.side,
      venuePolicy: row.venue_policy,
      quoteMint: row.quote_mint,
      quoteTokenProgram: row.quote_token_program,
      quoteDecimals: row.quote_decimals,
      quoteAmountRaw: row.quote_amount_raw === null ? null : unsignedBigint(row.quote_amount_raw),
      baseAmountRaw: row.base_amount_raw === null ? null : unsignedBigint(row.base_amount_raw),
      minimumAmountOutRaw: unsignedBigint(row.minimum_amount_out_raw),
      decisionEventId: row.decision_event_id,
      decisionFingerprint: row.decision_fingerprint,
      requestedAtMs: timestampText(row.requested_at_ms),
      expiresAtMs: timestampText(row.expires_at_ms),
    });
    if (row.id !== draft.id || row.payload_version !== 1
      || row.logical_order_key !== draft.logicalOrderKey || row.status !== 'PENDING'
      || row.attempt_count !== 0 || row.last_reason_code !== null
      || row.terminal_at_ms !== null || row.reconciliation_completed_at_ms !== null
      || row.purge_after_ms !== null || row.lease_owner !== null || row.lease_token !== null
      || row.lease_expires_at_ms !== null) throw new TypeError();
    const intent = Object.freeze({
      ...draft,
      status: 'PENDING' as const,
      attemptCount: 0,
      stateRevision: unsignedBigint(row.state_revision),
      lastReasonCode: null,
      terminalAtMs: null,
      reconciliationCompletedAtMs: null,
      purgeAfterMs: null,
      createdAtMs: timestampText(row.created_at_ms),
      updatedAtMs: timestampText(row.updated_at_ms),
    });
    return Object.freeze({ intent });
  } catch {
    throw failure('CONFLICT');
  }
}

function assertCanaryRequestTarget(
  request: ExecutionArmamentRequestV2,
  target: LockedCanaryTarget,
  nowMs: number,
): void {
  const intent = target.intent;
  const leaseMarginMs = request.runtimeLeaseMs * 2;
  if (request.targetIntentId !== intent.id || request.target.intentId !== intent.id
    || request.target.stateRevision !== intent.stateRevision
    || request.target.strategyId !== intent.strategyId
    || request.target.strategyVersion !== intent.strategyVersion
    || request.target.decisionFingerprint !== intent.decisionFingerprint
    || request.target.mint !== intent.mint || request.target.quoteMint !== intent.quoteMint
    || request.target.quoteAmountRaw !== intent.quoteAmountRaw
    || intent.side !== 'BUY' || intent.attemptCount !== 0
    || intent.quoteMint !== WSOL_MINT || intent.quoteTokenProgram !== 'SPL_TOKEN'
    || intent.quoteDecimals !== 9
    || intent.baseAmountRaw !== null || intent.requestedAtMs > nowMs
    || intent.expiresAtMs < nowMs + leaseMarginMs
    || request.maximumCapitalLamports < intent.quoteAmountRaw
    || request.policy.quoteMintAllowlist[0] !== WSOL_MINT
    || request.armedAtMs > nowMs || request.armamentExpiresAtMs < nowMs + leaseMarginMs
    || request.capturedAtMs > nowMs || request.expiresAtMs < nowMs + leaseMarginMs) {
    throw failure('CONFLICT');
  }
}

function assertCanaryQualification(
  request: ExecutionArmamentRequestV2,
  qualification: ExecutionSafetyQualificationV1,
  nowMs: number,
): void {
  const marginMs = request.runtimeLeaseMs * 2;
  if (qualification.qualificationId !== request.qualification.qualificationId
    || qualification.qualificationFingerprint !== request.qualification.qualificationFingerprint
    || qualification.phase !== 'CANARY'
    || qualification.generationId !== request.qualification.generationId
    || qualification.providerId !== request.providerSnapshot.providerId
    || qualification.expiresAtMs < nowMs + marginMs
    || qualification.qualifiedAtMs > nowMs
    || qualification.gates.some((gate) => gate.expiresAtMs < nowMs + marginMs)) {
    throw failure('PREFLIGHT_EXPIRED');
  }
  const walletGate = qualification.gates.find((gate) => gate.gateId === 'WALLET_CHAIN_LIMITS_VERIFIED');
  const providerGate = qualification.gates.find((gate) => gate.gateId === 'PROVIDER_EXIT_CAPACITY_VERIFIED');
  if (walletGate?.evidenceId !== request.walletSnapshot.snapshotId
    || walletGate.evidenceFingerprint !== request.walletSnapshot.snapshotFingerprint
    || providerGate?.evidenceId !== request.providerSnapshot.snapshotId
    || providerGate.evidenceFingerprint !== request.providerSnapshot.snapshotFingerprint) {
    throw failure('CONFLICT');
  }
}

async function assertCanarySnapshotsCurrent(
  client: DatabaseClient,
  request: ExecutionArmamentRequestV2,
  walletSnapshot: ExecutionArmamentRequestV2['walletSnapshot'],
  providerSnapshot: ExecutionArmamentRequestV2['providerSnapshot'],
  nowMs: number,
): Promise<void> {
  const marginMs = request.runtimeLeaseMs * 2;
  if (walletSnapshot.snapshotId !== request.walletSnapshot.snapshotId
    || walletSnapshot.snapshotFingerprint !== request.walletSnapshot.snapshotFingerprint
    || providerSnapshot.snapshotId !== request.providerSnapshot.snapshotId
    || providerSnapshot.snapshotFingerprint !== request.providerSnapshot.snapshotFingerprint
    || walletSnapshot.generationId !== request.qualification.generationId
    || walletSnapshot.providerId !== providerSnapshot.providerId
    || walletSnapshot.observedAtMs + request.policy.walletSnapshotMaxAgeMs < nowMs + marginMs
    || providerSnapshot.measuredAtMs + request.policy.providerUsageMaxAgeMs < nowMs + marginMs
    || providerSnapshot.expiresAtMs < nowMs + marginMs) throw failure('PREFLIGHT_EXPIRED');
  const snapshots = exactRow(singleRow(await client.query(`SELECT
    (SELECT superseded_at IS NULL FROM execution_wallet_snapshots WHERE snapshot_id=$1)
      AS wallet_current,
    (SELECT superseded_at IS NULL FROM execution_provider_usage_snapshots WHERE snapshot_id=$2)
      AS provider_current`, [walletSnapshot.snapshotId, providerSnapshot.snapshotId])), [
    'wallet_current', 'provider_current',
  ] as const);
  if (snapshots.wallet_current !== true || snapshots.provider_current !== true) throw failure('CONFLICT');
}

async function consumeCanaryAuthorization(
  client: DatabaseClient,
  authorization: ExecutionOperatorAuthorizationV2,
  nowMs: number,
): Promise<void> {
  const inserted = await client.query(`INSERT INTO execution_operator_authorizations (
    authorization_id,payload_version,authorization_fingerprint,generation_id,
    action,phase,context_fingerprint,nonce_hash,operator_id,issued_at,expires_at,
    consumed_at,purge_after
  ) SELECT $1,2,$2,generation_id,'ARM','CANARY',$3,$4,$5,
    TIMESTAMPTZ 'epoch'+($6::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($7::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($8::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+(($8::BIGINT+14400000)*INTERVAL '1 millisecond')
    FROM execution_wallet_generations WHERE generation_id=$9 AND retired_at IS NULL
      AND TIMESTAMPTZ 'epoch'+($6::BIGINT*INTERVAL '1 millisecond') <= statement_timestamp()
      AND TIMESTAMPTZ 'epoch'+($7::BIGINT*INTERVAL '1 millisecond') >= statement_timestamp()`, [
    authorization.authorizationId, authorization.authorizationFingerprint,
    authorization.contextFingerprint, authorization.nonceHash, authorization.operatorId,
    authorization.issuedAtMs, authorization.expiresAtMs, nowMs, authorization.generationId,
  ]);
  if (inserted.rowCount !== 1) throw failure('CONFLICT');
}

async function insertCanaryArmament(
  client: DatabaseClient,
  armament: ExecutionActivationArmamentV2,
): Promise<void> {
  const inserted = await client.query(`INSERT INTO execution_activation_armaments (
    armament_id,payload_version,armament_fingerprint,qualification_id,
    qualification_fingerprint,generation_id,authorization_id,state,state_revision,phase,
    build_hash,configuration_fingerprint,strategy_fingerprint,wallet_public_key,cluster,
    genesis_hash,provider_id,maximum_buys,consumed_buys,maximum_capital_lamports,
    maximum_exposure_bps,maximum_open_positions,maximum_holding_ms,operator_id,operator_reason,
    armed_at,expires_at,armament_request_fingerprint,canary_evidence_fingerprint,
    target_intent_id,target_intent_state_revision,target_strategy_id,target_strategy_version,
    target_decision_fingerprint,target_mint,target_quote_mint,target_quote_amount_raw,
    target_admission_report_id,target_reservation_id,target_policy_fingerprint,
    target_wallet_snapshot_fingerprint,target_provider_snapshot_fingerprint,
    runtime_quote_max_age_ms,runtime_slippage_bps,runtime_snapshot_max_slot_lag,
    runtime_max_compute_units,runtime_max_fee_lamports,runtime_max_fee_payer_lamport_debit,
    runtime_max_rpc_calls_per_attempt,runtime_lease_ms
  ) VALUES ($1,2,$2,$3,$4,$5,$6,'ARMED',0,'CANARY',$7,$8,$9,$10,'mainnet-beta',$11,
    $12,1,0,$13::NUMERIC,500,1,$14,$15,$16,
    TIMESTAMPTZ 'epoch'+($17::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($18::BIGINT*INTERVAL '1 millisecond'),
    $19,$20,$21,$22::BIGINT,$23,$24,$25,$26,$27,$28::NUMERIC,$29,$30,$31,$32,$33,
    $34,$35::BIGINT,$36::BIGINT,$37::BIGINT,$38::NUMERIC,$39::NUMERIC,$40,$41)`, [
    armament.armamentId, armament.armamentFingerprint, armament.qualification.qualificationId,
    armament.qualification.qualificationFingerprint, armament.qualification.generationId,
    armament.authorizationId, armament.qualification.buildHash,
    armament.qualification.configurationFingerprint, armament.qualification.strategyFingerprint,
    armament.qualification.walletPublicKey, armament.qualification.genesisHash,
    armament.qualification.providerId, armament.maximumCapitalLamports.toString(),
    armament.maximumHoldingMs, armament.operatorId, armament.operatorReason,
    armament.armedAtMs, armament.armamentExpiresAtMs, armament.armamentRequestFingerprint,
    armament.evidenceFingerprint, armament.target.intentId, armament.target.stateRevision.toString(),
    armament.target.strategyId, armament.target.strategyVersion, armament.target.decisionFingerprint,
    armament.target.mint, armament.target.quoteMint, armament.target.quoteAmountRaw.toString(),
    armament.admissionReportId, armament.reservationId, armament.policy.policyFingerprint,
    armament.walletSnapshot.snapshotFingerprint, armament.providerSnapshot.snapshotFingerprint,
    armament.runtimeQuoteMaxAgeMs, armament.runtimeSlippageBps.toString(),
    armament.runtimeSnapshotMaxSlotLag, armament.runtimeMaxComputeUnits.toString(),
    armament.runtimeMaxFeeLamports.toString(), armament.runtimeMaxFeePayerLamportDebit.toString(),
    armament.runtimeMaxRpcCallsPerAttempt, armament.runtimeLeaseMs,
  ]);
  if (inserted.rowCount !== 1) throw failure('CONFLICT');
}

async function insertCanaryArmamentEvent(
  client: DatabaseClient,
  armament: ExecutionActivationArmamentV2,
  occurredAtMs: number,
): Promise<void> {
  const eventFingerprint = hash([
    'execution-activation-event-v2', armament.armamentId, null,
    'ARMED', 'OPERATOR_ARMED', occurredAtMs,
  ]);
  const inserted = await client.query(`INSERT INTO execution_activation_events (
    event_id,payload_version,event_fingerprint,armament_id,generation_id,
    previous_state,next_state,reason_code,occurred_at
  ) VALUES ($1,1,$2,$3,$4,NULL,'ARMED','OPERATOR_ARMED',
    TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond'))`, [
    `execution_activation_event_${eventFingerprint}`, eventFingerprint,
    armament.armamentId, armament.qualification.generationId, occurredAtMs,
  ]);
  if (inserted.rowCount !== 1) throw failure('INVALID_DATA');
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
  const result = await client.query(`SELECT armament_id,payload_version,state,
    target_reservation_id,state_revision::TEXT AS revision,
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms
    FROM execution_activation_armaments WHERE generation_id=$1
      AND state IN ('ARMED','LOCKED')
      AND (payload_version=1 OR state='ARMED')
      AND ($2::BOOLEAN=FALSE OR expires_at <= statement_timestamp())
    FOR UPDATE`, [generationId, expiredOnly]);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  if (result.rows.length === 0) return;
  const row = exactRow(result.rows[0], [
    'armament_id', 'payload_version', 'state', 'target_reservation_id', 'revision', 'now_ms',
  ] as const);
  if ((row.state !== 'ARMED' && row.state !== 'LOCKED')
    || typeof row.armament_id !== 'string') throw failure('INVALID_DATA');
  const revision = unsignedBigint(row.revision);
  const occurredAtMs = timestampText(row.now_ms);
  if (row.payload_version === 2 && row.state === 'ARMED') {
    if (typeof row.target_reservation_id !== 'string') throw failure('INVALID_DATA');
    await releaseCanaryReservation(client, row.target_reservation_id, generationId, occurredAtMs);
  } else if (row.payload_version !== 1 && row.payload_version !== 2) {
    throw failure('INVALID_DATA');
  }
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

async function releaseCanaryReservation(
  client: DatabaseClient,
  reservationId: string,
  generationId: string,
  occurredAtMs: number,
): Promise<void> {
  const row = exactRow(singleRow(await client.query(`SELECT reservation.reservation_id,
    reservation.state,reservation.state_revision::TEXT AS reservation_revision,
    reservation.maximum_amount_raw::TEXT AS maximum_amount_raw,
    risk.state_revision::TEXT AS risk_revision,risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,
    risk.open_positions
    FROM execution_exposure_reservations AS reservation
    JOIN execution_wallet_risk_state AS risk ON risk.generation_id=reservation.generation_id
    WHERE reservation.reservation_id=$1 AND reservation.generation_id=$2
    FOR UPDATE OF reservation,risk`, [reservationId, generationId])), [
    'reservation_id', 'state', 'reservation_revision', 'maximum_amount_raw', 'risk_revision',
    'reserved_exposure_raw', 'open_positions',
  ] as const);
  if (row.state !== 'RESERVED') throw failure('CONFLICT');
  const reservationRevision = unsignedBigint(row.reservation_revision);
  const riskRevision = unsignedBigint(row.risk_revision);
  const maximumAmountRaw = unsignedBigint(row.maximum_amount_raw);
  const reservedExposureRaw = unsignedBigint(row.reserved_exposure_raw);
  if (reservedExposureRaw < maximumAmountRaw
    || typeof row.open_positions !== 'number' || row.open_positions < 1) {
    throw failure('INVALID_DATA');
  }
  const reservation = await client.query(`UPDATE execution_exposure_reservations SET
    state='RELEASED',state_revision=$2::BIGINT,
    reconciled_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond')
    WHERE reservation_id=$1 AND state='RESERVED' AND state_revision=$4::BIGINT`, [
    reservationId, (reservationRevision + 1n).toString(), occurredAtMs,
    reservationRevision.toString(),
  ]);
  if (reservation.rowCount !== 1) throw failure('CONFLICT');
  const risk = await client.query(`UPDATE execution_wallet_risk_state SET
    state_revision=$2::BIGINT,reserved_exposure_raw=$3::NUMERIC,open_positions=$4,
    unknown_block=EXISTS (SELECT 1 FROM execution_exposure_reservations
      WHERE generation_id=$1 AND state='UNKNOWN_HELD'),
    updated_at=TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond')
    WHERE generation_id=$1 AND state_revision=$6::BIGINT`, [
    generationId, (riskRevision + 1n).toString(),
    (reservedExposureRaw - maximumAmountRaw).toString(), row.open_positions - 1,
    occurredAtMs, riskRevision.toString(),
  ]);
  if (risk.rowCount !== 1) throw failure('CONFLICT');
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
    reason_code,qualification_id,authorization_id,operator_id,actor_type,actor_id,occurred_at
  ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,'OPERATOR',$9,
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
