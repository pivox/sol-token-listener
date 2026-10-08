import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  createExecutionArmament,
  createExecutionArmamentRequestV2,
  createExecutionArmamentRequestV3,
  createExecutionArmamentV2,
  createOperatorAuthorization,
  createOperatorAuthorizationV2,
  decideExecutionControlTransition,
  type ExecutionActivationArmamentV1,
  type ExecutionActivationArmamentV2,
  type ExecutionArmamentRequestV2,
  type ExecutionArmamentRequestV3,
  type ExecutionControlState,
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
  ENVELOPE_QUALIFICATION_MAXIMUM_TTL_MS,
  type ExecutionSafetyQualification,
  type ExecutionSafetyQualificationV1,
  type ExecutionSafetyQualificationV2,
} from '../domain/execution-safety-qualification.js';
import {
  createEntryEnvelope,
  createEnvelopeProviderSnapshot,
  ENVELOPE_ARMAMENT_MAXIMUM_TTL_MS,
  ENVELOPE_EXIT_MARGIN_MS,
  type EntryEnvelopeV2,
} from '../domain/execution-entry-envelope.js';
import {
  createProviderUsageSnapshot,
  type ProviderUsageSnapshotV1,
} from '../domain/execution-provider-quota.js';
import {
  createExecutionRiskPolicy,
  type ExecutionRiskPolicyV1,
} from '../domain/execution-risk-policy.js';
import type {
  ExecutionAutoArmContextQueryV1,
  ExecutionAutoArmContextV1,
  ExecutionCanaryArmamentRepository,
  ExecutionCanaryTargetIntentV1,
  ExecutionControlCommandV1,
  ExecutionEntryEnvelopeRepository,
  ExecutionEntryEnvelopeState,
  ExecutionEntryEnvelopeSummaryV1,
  ExecutionEnvelopeArmamentRepository,
  ExecutionEnvelopeCreationV1,
  ExecutionEnvelopeExpiryV1,
  ExecutionEnvelopeFactsQueryV1,
  ExecutionEnvelopeFactsV1,
  ExecutionEnvelopeProviderRefreshCommandV1,
  ExecutionEnvelopeProviderRefreshV1,
  ExecutionEnvelopeRevocationV1,
  ExecutionEnvelopeRevokeCommandV1,
  ExecutionOperationsRepository,
  ExecutionOperationsStatusV1,
  ExecutionResumeCommandV1,
} from '../ports/execution-operations-repository.js';
import { canonicalStringifyJson, parseJson } from '../utils/json.js';
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
import {
  assertExecutionIntentLineageCurrentInTransaction,
  ExecutionIntentLineageRepositoryError,
} from './execution-intent-lineage.repository.js';
import {
  createExecutionPreflightDraftSource,
  type ExecutionPreflightDraftSourceV2,
} from '../domain/execution-preflight-draft.js';
import { lockWorkerTrackingMints } from './worker-tracking-mint-lock.js';

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

/**
 * Envelope arming only (CANARY codes are unchanged):
 * - ENVELOPE_NOT_ARMABLE: the envelope refuses any arm now (not ACTIVE, cut-off, caps, loss,
 *   operator/policy/holding/capital mismatch, qualification bound to another envelope).
 * - ARMAMENT_CONTENDED (transient): another armament is active (K=1), a snapshot was
 *   superseded concurrently, or a unique violation.
 * - PROVIDER_CARRY_FORWARD_STALE (transient): the executor counters moved since the context.
 * - PROVIDER_CARRY_FORWARD_REJECTED: the refresh snapshot cannot be built (over the limit,
 *   outside the billing period).
 * CONFLICT stays for intent-specific and admission refusals.
 */
export type ExecutionOperationsRepositoryErrorCode =
  | 'CONFLICT' | 'INVALID_DATA' | 'DATABASE_FAILURE'
  | 'CONTROL_STOPPED' | 'PREFLIGHT_EXPIRED'
  | 'ENVELOPE_NOT_ARMABLE' | 'ARMAMENT_CONTENDED'
  | 'PROVIDER_CARRY_FORWARD_STALE' | 'PROVIDER_CARRY_FORWARD_REJECTED';
type RepositoryErrorCode = ExecutionOperationsRepositoryErrorCode;

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
  ExecutionOperationsRepository, ExecutionCanaryArmamentRepository,
  ExecutionEntryEnvelopeRepository, ExecutionEnvelopeArmamentRepository {
  readonly #source: DatabaseSource;

  public constructor(source: DatabaseSource | Pick<InstanceType<typeof pg.Pool>, 'connect'>) {
    this.#source = source;
  }

  public async persistQualification(
    input: ExecutionSafetyQualification,
  ): Promise<ExecutionSafetyQualificationV1> {
    const qualification = qualificationFrom(input);
    // An ENVELOPE qualification is only ever written by createEnvelope, bound to its envelope.
    if (qualification.payloadVersion !== 1) throw failure('CONFLICT');
    return this.transaction(async (client) => {
      await lockGeneration(client, qualification.generationId);
      const existing = await client.query(`SELECT qualification_id
        FROM execution_safety_qualifications WHERE qualification_id=$1`,
      [qualification.qualificationId]);
      if (existing.rows.length === 1) {
        const row = exactRow(existing.rows[0], ['qualification_id'] as const);
        const stored = (await qualificationForArm(client, String(row.qualification_id))).qualification;
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
      await verifyMainnetSimulationEvidence(client, qualification, null);
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

  public async readQualification(qualificationId: string): Promise<ExecutionSafetyQualification> {
    const parsed = patterned(
      qualificationId,
      /^execution_safety_qualification_[0-9a-f]{64}$/u,
    );
    return this.transaction(async (client) => (await qualificationForArm(client, parsed)).qualification);
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
      const qualification = (await qualificationForArm(client, input.qualificationId)).qualification;
      if (qualification.payloadVersion !== 1) throw failure('CONFLICT');
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
    return this.transaction(async (client) => targetIntentFrom(singleRow(await client.query(
      `SELECT ${TARGET_INTENT_PROJECTION} FROM execution_intents WHERE id=$1`, [parsed],
    ))));
  }

  public async armCanary(input: Readonly<{
    request: ExecutionArmamentRequestV2;
    authorization: ExecutionOperatorAuthorizationV2;
    preflightSource?: never;
  }> | Readonly<{
    request: ExecutionArmamentRequestV3;
    authorization: ExecutionOperatorAuthorizationV2;
    preflightSource: ExecutionPreflightDraftSourceV2;
  }>): Promise<ExecutionActivationArmamentV2> {
    const request = canaryRequestFrom(input.request);
    const preflightSource = preflightSourceForRequest(request,
      'preflightSource' in input ? input.preflightSource : undefined);
    const authorization = canaryAuthorizationFrom(input.authorization);
    if (authorization.generationId !== request.qualification.generationId
      || authorization.action !== 'ARM' || authorization.phase !== 'CANARY'
      || authorization.contextFingerprint !== request.armamentRequestFingerprint
      || authorization.operatorId !== request.operatorId) throw failure('CONFLICT');
    const outcome = await this.transaction((client) => armV2InTransaction(
      client, request, authorization, { preflightSource, envelopeId: null },
    ));
    if (outcome.kind === 'STALE') throw failure('CONFLICT');
    return outcome.armament;
  }

  /**
   * Arms one fast-entry BUY inside the ACTIVE envelope: the v2 CANARY path with the envelope
   * bound. The ENVELOPE qualification, the envelope caps and the executor-counter provider
   * carry-forward are checked under the envelope row lock; the 065 trigger counts the buy.
   */
  public async armEnvelope(input: Readonly<{
    request: ExecutionArmamentRequestV2;
    authorization: ExecutionOperatorAuthorizationV2;
    envelopeId: string;
  }>): Promise<ExecutionActivationArmamentV2> {
    const request = canaryRequestFrom(input.request);
    const envelopeId = patterned(input.envelopeId, ENVELOPE_ID_PATTERN);
    const authorization = canaryAuthorizationFrom(input.authorization);
    if (request.payloadVersion !== 2 || request.qualification.payloadVersion !== 2
      || authorization.generationId !== request.qualification.generationId
      || authorization.action !== 'ARM' || authorization.phase !== 'CANARY'
      || authorization.contextFingerprint !== request.armamentRequestFingerprint
      || authorization.operatorId !== request.operatorId) throw failure('CONFLICT');
    const outcome = await this.transaction((client) => armV2InTransaction(
      client, request, authorization, { preflightSource: null, envelopeId },
    ), { uniqueViolation: 'ARMAMENT_CONTENDED' });
    if (outcome.kind === 'STALE') throw failure('CONFLICT');
    return outcome.armament;
  }

  public async readAutoArmContext(
    input: ExecutionAutoArmContextQueryV1,
  ): Promise<ExecutionAutoArmContextV1> {
    const query = autoArmContextQueryFrom(input);
    return this.transaction(async (client) => {
      const nowMs = await databaseNowMs(client);
      const generation = await client.query(`SELECT generation_id FROM execution_wallet_generations
        WHERE generation_id=$1 AND retired_at IS NULL`, [query.generationId]);
      if (generation.rows.length !== 1) throw failure('CONFLICT');
      const control = await client.query(`SELECT state FROM execution_control_state
        WHERE generation_id=$1`, [query.generationId]);
      if (control.rows.length > 1) throw failure('INVALID_DATA');
      const controlState = control.rows.length === 0 ? 'ENTRY_STOP'
        : controlStateFrom(exactRow(control.rows[0], ['state'] as const).state);
      const risk = exactRow(singleRowOr(await client.query(`SELECT
        state_revision::TEXT AS state_revision,open_positions,unknown_block
        FROM execution_wallet_risk_state WHERE generation_id=$1`, [query.generationId]), 'CONFLICT'),
      ['state_revision', 'open_positions', 'unknown_block'] as const);
      if (typeof risk.unknown_block !== 'boolean') throw failure('INVALID_DATA');
      const active = await activeEnvelopeOf(client, query.generationId);
      const armament = await activeArmamentOf(client, query.generationId, nowMs);
      const providerId = armament?.envelopeBound === true && armament.state === 'LOCKED'
        ? armament.providerId : active?.qualification.providerId ?? null;
      const provider = providerId === null ? null : await currentProviderOf(client, providerId, false);
      // The refresh policy outlives the ACTIVE state: the last buy makes its envelope EXHAUSTED.
      const refreshPolicy = armament?.state === 'LOCKED' && armament.envelopeId !== null
        ? await envelopePolicyOf(client, armament.envelopeId, query.generationId)
        : active?.envelope.policy ?? null;
      const refreshProviderUsageMaxAgeMs = refreshPolicy?.providerUsageMaxAgeMs ?? null;
      const candidate = active === null ? null : await client.query(`SELECT ${TARGET_INTENT_PROJECTION}
        FROM execution_intents
        WHERE strategy_id=$1 AND side='BUY' AND status='PENDING' AND live_reserved=FALSE
          AND payload_version=1 AND attempt_count=0 AND last_reason_code IS NULL
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
          AND terminal_at IS NULL AND reconciliation_completed_at IS NULL AND purge_after IS NULL
          AND base_amount_raw IS NULL
          AND quote_mint=$2 AND quote_token_program='SPL_TOKEN' AND quote_decimals=9
          AND quote_amount_raw=$3::NUMERIC
          AND requested_at >= TIMESTAMPTZ 'epoch'+($4::BIGINT*INTERVAL '1 millisecond')
          AND requested_at <= TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond')
          AND expires_at >= TIMESTAMPTZ 'epoch'+(($5::BIGINT+$6::BIGINT)*INTERVAL '1 millisecond')
          AND id <> ALL($7::TEXT[])
        ORDER BY requested_at,id LIMIT 1`, [
        FAST_ENTRY_STRATEGY_ID, WSOL_MINT, active.envelope.perBuyQuoteAmountRaw.toString(),
        active.envelope.validFromMs, nowMs, query.minimumRemainingMs, [...query.excludedIntentIds],
      ]);
      const [candidateRow] = candidate?.rows ?? [];
      return Object.freeze({
        payloadVersion: 1,
        databaseNowMs: nowMs,
        envelope: active?.envelope ?? null,
        qualification: active?.qualification ?? null,
        buysArmed: active?.buysArmed ?? 0,
        realizedLossRaw: active?.realizedLossRaw ?? 0n,
        controlState,
        riskStateRevision: unsignedBigint(risk.state_revision),
        openPositions: safeInteger(risk.open_positions),
        unknownBlock: risk.unknown_block,
        activeArmament: armament?.state ?? null,
        provider,
        candidateIntent: candidateRow === undefined ? null : targetIntentFrom(candidateRow),
        refreshProviderUsageMaxAgeMs,
        // A12: half the policy max age; without a policy, only an expired snapshot is due.
        providerRefreshDue: refreshDue(armament, provider, nowMs, refreshProviderUsageMaxAgeMs === null
          ? 1 : Math.floor(refreshProviderUsageMaxAgeMs / 2)),
      });
    }, { begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' });
  }

  /**
   * Carries the provider snapshot forward with the executor counters while the envelope BUY
   * is reconciled and its position open (SELL submission needs an unexpired snapshot). It
   * never supersedes while a BUY is in flight: the refresh must still be due under the locks.
   */
  public async refreshEnvelopeProviderSnapshot(
    input: ExecutionEnvelopeProviderRefreshCommandV1,
  ): Promise<ExecutionEnvelopeProviderRefreshV1> {
    const generationId = generationIdFrom(input.generationId);
    const maximumAgeMs = boundedInteger(input.maximumAgeMs, 30_000, 900_000);
    const thresholdMs = boundedInteger(input.providerRefreshThresholdMs, 1, maximumAgeMs);
    return this.transaction(async (client) => {
      await lockGeneration(client, generationId);
      const nowMs = await databaseNowMs(client);
      const notRefreshed = Object.freeze({
        payloadVersion: 1, refreshed: false, snapshot: null, databaseNowMs: nowMs,
      } as const);
      const armament = await activeArmamentOf(client, generationId, nowMs);
      if (armament?.state !== 'LOCKED' || !armament.envelopeBound
        || !armament.buySucceeded) return notRefreshed;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51006))', [
        armament.providerId,
      ]);
      const provider = await currentProviderOf(client, armament.providerId, true);
      if (!refreshDue(armament, provider, nowMs, thresholdMs) || provider === null) return notRefreshed;
      let carried: ProviderUsageSnapshotV1;
      try {
        carried = createEnvelopeProviderSnapshot(Object.freeze({
          latest: provider.snapshot, localUsedUnits: provider.localUsedUnits,
          measuredAtMs: nowMs, maximumAgeMs,
        }));
      } catch {
        throw failure('PROVIDER_CARRY_FORWARD_REJECTED');
      }
      const snapshot = await appendProviderUsageInTransaction(client, carried);
      return Object.freeze({ payloadVersion: 1, refreshed: true, snapshot, databaseNowMs: nowMs });
    });
  }

  public async prepareEnvelopeFacts(
    generationId: string,
    query: ExecutionEnvelopeFactsQueryV1,
  ): Promise<ExecutionEnvelopeFactsV1 | null> {
    const parsed = generationIdFrom(generationId);
    const facts = envelopeFactsQueryFrom(query);
    return this.transaction(async (client) => {
      const generation = exactRow(singleRowOr(await client.query(`SELECT wallet_public_key,cluster,
        genesis_hash,retired_at,
        trunc(EXTRACT(EPOCH FROM date_trunc('milliseconds',statement_timestamp()))*1000)::TEXT
          AS database_now_ms
        FROM execution_wallet_generations WHERE generation_id=$1`, [parsed]), 'CONFLICT'), [
        'wallet_public_key', 'cluster', 'genesis_hash', 'retired_at', 'database_now_ms',
      ] as const);
      if (generation.wallet_public_key !== facts.walletPublicKey
        || generation.cluster !== 'mainnet-beta'
        || generation.genesis_hash !== facts.genesisHash
        || generation.retired_at !== null) throw failure('CONFLICT');
      // Safety point 1: gate 10 evidence older than 24 hours is never offered.
      const artifacts = await client.query(`SELECT artifact_id,result_fingerprint,
        build_fingerprint,configuration_fingerprint,
        trunc(EXTRACT(EPOCH FROM recorded_at)*1000)::TEXT AS recorded_at_ms
        FROM execution_simulation_artifacts
        WHERE result_kind='SUCCESS' AND provider_id=$1 AND executor_public_key=$2
          AND expected_genesis_hash=$3 AND observed_genesis_hash=$3
          AND configuration_fingerprint=$4 AND build_fingerprint=$5
          AND recorded_at <= statement_timestamp()
          AND recorded_at >= statement_timestamp()-($6::BIGINT*INTERVAL '1 millisecond')
        ORDER BY recorded_at DESC,artifact_id DESC LIMIT 1`, [
        facts.providerId, facts.walletPublicKey, facts.genesisHash,
        facts.configurationFingerprint, facts.buildHash, ENVELOPE_QUALIFICATION_MAXIMUM_TTL_MS,
      ]);
      if (artifacts.rows.length === 0) return null;
      const artifact = exactRow(singleRow(artifacts), [
        'artifact_id', 'result_fingerprint', 'build_fingerprint', 'configuration_fingerprint',
        'recorded_at_ms',
      ] as const);
      return Object.freeze({
        payloadVersion: 1,
        databaseNowMs: timestampText(generation.database_now_ms),
        generation: Object.freeze({
          generationId: parsed,
          walletPublicKey: facts.walletPublicKey,
          genesisHash: facts.genesisHash,
        }),
        simulation: Object.freeze({
          artifactId: patterned(artifact.artifact_id, /^execution_simulation_artifact_[0-9a-f]{64}$/u),
          resultFingerprint: patterned(artifact.result_fingerprint, /^[0-9a-f]{64}$/u),
          recordedAtMs: timestampText(artifact.recorded_at_ms),
          buildFingerprint: patterned(artifact.build_fingerprint, /^[0-9a-f]{64}$/u),
          configurationFingerprint: patterned(artifact.configuration_fingerprint, /^[0-9a-f]{64}$/u),
        }),
      });
    });
  }

  public async createEnvelope(input: ExecutionEnvelopeCreationV1): Promise<EntryEnvelopeV2> {
    const qualification = qualificationFrom(input.qualification);
    if (qualification.payloadVersion !== 2) throw failure('CONFLICT');
    const envelope = entryEnvelopeFrom(input.envelope, qualification);
    const authorization = authorizationFrom(input.authorization);
    if (authorization.action !== 'ENVELOPE' || authorization.phase !== null
      || authorization.generationId !== envelope.generationId
      || authorization.contextFingerprint !== envelope.fingerprint
      || authorization.operatorId !== envelope.operatorId) throw failure('CONFLICT');
    return this.transaction(async (client) => {
      // A24: the generation lock (51005) precedes every envelope and armament row.
      await lockGeneration(client, envelope.generationId);
      const nowMs = await assertCurrentGeneration(client, qualification);
      if (qualification.qualifiedAtMs > nowMs
        || qualification.expiresAtMs <= nowMs) throw failure('PREFLIGHT_EXPIRED');
      if (envelope.validFromMs > nowMs) throw failure('CONFLICT');
      // Safety point 1, anchored on the DB now: an old qualification cannot carry older evidence.
      await verifyMainnetSimulationEvidence(client, qualification,
        nowMs - ENVELOPE_QUALIFICATION_MAXIMUM_TTL_MS);
      await expireActiveEnvelopes(client, envelope.generationId);
      await consumeAuthorization(client, authorization, 'ENVELOPE', null, nowMs);
      await insertEntryEnvelope(client, envelope, authorization.authorizationId);
      await insertEnvelopeQualification(client, qualification, envelope.envelopeId);
      return envelope;
    });
  }

  public async revokeEnvelope(
    input: ExecutionEnvelopeRevokeCommandV1,
  ): Promise<ExecutionEnvelopeRevocationV1> {
    const command = envelopeRevokeCommandFrom(input);
    return this.transaction(async (client) => {
      // A24: revoking under 51005 cannot lose against a concurrent arm of this generation.
      await lockGeneration(client, command.generationId);
      const nowMs = await databaseNowMs(client);
      const existing = exactRow(singleRowOr(await client.query(`SELECT state
        FROM execution_entry_envelopes WHERE envelope_id=$1 AND generation_id=$2`,
      [command.envelopeId, command.generationId]), 'CONFLICT'), ['state'] as const);
      const previousState = envelopeState(existing.state);
      if (previousState === 'ACTIVE') {
        const updated = await client.query(`UPDATE execution_entry_envelopes SET state='REVOKED',
          revoked_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
          updated_at=GREATEST(updated_at,TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'))
          WHERE envelope_id=$1 AND generation_id=$2 AND state='ACTIVE'`, [
          command.envelopeId, command.generationId, nowMs,
        ]);
        if (updated.rowCount !== 1) throw failure('CONFLICT');
      }
      // A10: only an ARMED armament of this envelope; a CANARY armament is never touched. The
      // armament of an EXHAUSTED or EXPIRED envelope is revoked too: this is the kill switch.
      const armamentRevoked = await terminalizeActiveArmament(
        client, command.generationId, 'REVOKED', false, command.envelopeId,
      );
      return Object.freeze({
        payloadVersion: 1,
        envelopeId: command.envelopeId,
        state: previousState === 'ACTIVE' ? 'REVOKED' : previousState,
        replayed: previousState === 'REVOKED',
        armamentRevoked,
        databaseNowMs: nowMs,
      });
    });
  }

  /**
   * Expires the ACTIVE envelope past valid_until and the ARMED armament past expires_at
   * (nobody claimed it: its exposure reservation is released, so the envelope can re-arm;
   * its buy stays counted). A LOCKED armament belongs to H2b and is never touched here.
   */
  public async expireEnvelopes(generationId: string): Promise<ExecutionEnvelopeExpiryV1> {
    const parsed = generationIdFrom(generationId);
    return this.transaction(async (client) => {
      await lockGeneration(client, parsed);
      const nowMs = await databaseNowMs(client);
      const expiredCount = await expireActiveEnvelopes(client, parsed);
      await terminalizeActiveArmament(client, parsed, 'EXPIRED', true);
      return Object.freeze({ payloadVersion: 1, expiredCount, databaseNowMs: nowMs });
    });
  }

  public async readEnvelopes(
    generationId: string,
  ): Promise<readonly ExecutionEntryEnvelopeSummaryV1[]> {
    const parsed = generationIdFrom(generationId);
    return this.transaction(async (client) => {
      const result = await client.query(`SELECT envelope.envelope_id,envelope.payload_version,
        envelope.fingerprint,envelope.generation_id,envelope.operator_id,
        envelope.per_buy_quote_amount_raw::TEXT AS per_buy_quote_amount_raw,envelope.max_buys,
        envelope.max_open_positions,envelope.max_total_exposure_raw::TEXT AS max_total_exposure_raw,
        envelope.max_realized_loss_raw::TEXT AS max_realized_loss_raw,
        trunc(EXTRACT(EPOCH FROM envelope.valid_from)*1000)::TEXT AS valid_from_ms,
        trunc(EXTRACT(EPOCH FROM envelope.valid_until)*1000)::TEXT AS valid_until_ms,
        envelope.state,envelope.buys_armed,envelope.realized_loss_raw::TEXT AS realized_loss_raw,
        CASE WHEN envelope.revoked_at IS NULL THEN NULL
          ELSE trunc(EXTRACT(EPOCH FROM envelope.revoked_at)*1000)::TEXT END AS revoked_at_ms,
        trunc(EXTRACT(EPOCH FROM envelope.created_at)*1000)::TEXT AS created_at_ms,
        trunc(EXTRACT(EPOCH FROM envelope.updated_at)*1000)::TEXT AS updated_at_ms,
        envelope.authorization_id,envelope.policy_fingerprint,envelope.maximum_holding_ms,
        (SELECT qualification.qualification_id FROM execution_safety_qualifications qualification
          WHERE qualification.envelope_id=envelope.envelope_id
          ORDER BY qualification.qualified_at DESC,qualification.qualification_id DESC LIMIT 1)
          AS qualification_id
        FROM execution_entry_envelopes envelope WHERE envelope.generation_id=$1
        ORDER BY envelope.created_at DESC,envelope.envelope_id DESC LIMIT 5`, [parsed]);
      return Object.freeze(result.rows.map((row) => envelopeSummaryFrom(row)));
    });
  }

  public async readStatus(generationId: string): Promise<ExecutionOperationsStatusV1> {
    const parsed = generationIdFrom(generationId);
    return this.transaction((client) => readStatus(client, parsed));
  }

  private async transaction<T>(
    operation: (client: DatabaseClient) => Promise<T>,
    options: Readonly<{ begin?: string; uniqueViolation?: RepositoryErrorCode }> = {},
  ): Promise<T> {
    let client: DatabaseClient | null = null;
    try {
      client = await this.#source.connect();
      await client.query(options.begin ?? 'BEGIN');
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
      if (databaseCode(error) === '23505' && options.uniqueViolation !== undefined) {
        throw failure(options.uniqueViolation);
      }
      if (databaseCode(error) === '23505' || databaseCode(error) === '23503'
        || databaseCode(error) === '55000') {
        throw failure('CONFLICT');
      }
      throw failure('DATABASE_FAILURE');
    }
  }
}

/**
 * The v2/v3 arming transaction body. CANARY passes `envelopeId` null and keeps its exact
 * statement order; every envelope step is guarded by `envelopeId !== null`.
 */
async function armV2InTransaction(
  client: DatabaseClient,
  request: CanaryArmamentRequest,
  authorization: ExecutionOperatorAuthorizationV2,
  options: Readonly<{
    preflightSource: ExecutionPreflightDraftSourceV2 | null;
    envelopeId: string | null;
  }>,
): Promise<ArmV2Outcome> {
  const { preflightSource, envelopeId } = options;
  await lockWorkerTrackingMints(client, [request.target.mint]);
  await client.query(`SELECT pg_advisory_xact_lock(
    hashtextextended('execution-live-sell-presence:v1', 51008))`);
  await lockGeneration(client, request.qualification.generationId);
  const nowMs = await databaseNowMs(client);
  // A24: the envelope row is locked only once the generation lock (51005) is held.
  let envelope: LockedEnvelope | null = null;
  if (envelopeId !== null) {
    envelope = await lockedEnvelope(client, envelopeId, request.qualification.generationId);
    assertEnvelopeRequest(request, envelope, nowMs);
  }
  let target: LockedCanaryTarget | null = null;
  if (request.payloadVersion === 3) {
    const pair = await lockAndAssertPairedPreflightPair(
      client, request, preflightSource, nowMs,
    );
    target = await lockedCanaryTarget(client, request.target.intentId, pair.pairId, null);
    await lockAndAssertPairedPreflightEvidence(client, request, pair, nowMs);
  }
  // An envelope arm replayed after its envelope left ACTIVE fails closed above (no replay).
  const replay = await findCanaryReplay(client, request, authorization);
  if (replay?.kind === 'REPLAY') {
    if (target !== null) {
      if (!target.liveReserved) throw failure('CONFLICT');
      await assertCurrentCanaryLineage(client, request.target.intentId);
    }
    return replay;
  }
  if (replay?.kind === 'STALE') {
    await terminalizeActiveArmament(client, request.qualification.generationId, 'EXPIRED', true);
    return replay;
  }
  target ??= await lockedCanaryTarget(client, request.target.intentId, null, false);
  if (envelope !== null && (target.intent.strategyId !== FAST_ENTRY_STRATEGY_ID
    || target.intent.requestedAtMs < envelope.validFromMs)) throw failure('CONFLICT');
  if (target.liveReserved) throw failure('CONFLICT');
  assertCanaryRequestTarget(request, target, nowMs);
  if (request.payloadVersion === 3) {
    await assertCurrentCanaryLineage(client, request.target.intentId);
  }
  await promoteCanaryTarget(client, target.intent.id);
  await ensureControlState(client, request.qualification.generationId);
  const control = await lockedControlState(client, request.qualification.generationId);
  if (control.state !== 'RUNNING') throw failure('CONTROL_STOPPED');
  const stored = await qualificationForArm(client, request.qualification.qualificationId);
  if (envelopeId !== null && stored.envelopeId !== envelopeId) throw failure('ENVELOPE_NOT_ARMABLE');
  assertCanaryQualification(request, stored.qualification, nowMs, envelopeId);
  await terminalizeActiveArmament(client, request.qualification.generationId, 'EXPIRED', true);
  const active = await client.query(`SELECT armament_id FROM execution_activation_armaments
    WHERE generation_id=$1 AND state IN ('ARMED','LOCKED')
      AND expires_at > statement_timestamp() FOR UPDATE`, [request.qualification.generationId]);
  if (active.rows.length !== 0) {
    throw failure(envelope === null ? 'CONFLICT' : 'ARMAMENT_CONTENDED');
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51006))', [
    request.providerSnapshot.providerId,
  ]);
  const walletSnapshot = await envelopeContended(envelope, () => appendWalletSnapshotInTransaction(
    client,
    request.walletSnapshot,
  ));
  if (envelope !== null) await assertEnvelopeProviderCarryForward(client, request, envelope, nowMs);
  const providerSnapshot = await envelopeContended(envelope, () => appendProviderUsageInTransaction(
    client,
    request.providerSnapshot,
  ));
  await envelopeContended(envelope, () => assertCanarySnapshotsCurrent(
    client, request, walletSnapshot, providerSnapshot, nowMs,
  ));
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
  await insertCanaryArmament(client, armament, envelopeId);
  await insertCanaryArmamentEvent(client, armament, nowMs);
  return Object.freeze({ kind: 'REPLAY' as const, armament });
}

type ArmV2Outcome =
  | Readonly<{ kind: 'REPLAY'; armament: ExecutionActivationArmamentV2 }>
  | Readonly<{ kind: 'STALE' }>;

const ENVELOPE_ID_PATTERN = /^execution_entry_envelope_[0-9a-f]{64}$/u;
/**
 * FAST_ENTRY_STRATEGY_ID of src/domain/fast-entry.ts, also hard-coded in the 065 trigger. It is
 * not imported: the operations graph must not reach the paper/quote modules fast-entry pulls in.
 */
const FAST_ENTRY_STRATEGY_ID = 'fast-entry-v1';
const INTENT_ID_PATTERN = /^execution_intent_[0-9a-f]{64}$/u;

const TARGET_INTENT_PROJECTION = `id,side,status,lease_owner,
  CASE WHEN lease_expires_at IS NULL THEN NULL
    ELSE trunc(EXTRACT(EPOCH FROM lease_expires_at)*1000)::TEXT END AS lease_expires_at_ms,
  state_revision::TEXT AS state_revision,strategy_id,strategy_version,decision_fingerprint,
  mint,quote_mint,quote_amount_raw::TEXT AS quote_amount_raw,
  trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms`;

function targetIntentFrom(value: Readonly<Record<string, unknown>>): ExecutionCanaryTargetIntentV1 {
  const row = exactRow(value, [
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
    intentId: patterned(row.id, INTENT_ID_PATTERN),
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
}

/** An envelope row as arming reads it; the policy is rebuilt and matches its fingerprint. */
interface StoredEnvelope {
  readonly envelopeId: string;
  readonly payloadVersion: number;
  readonly fingerprint: string;
  readonly generationId: string;
  readonly operatorId: string;
  readonly state: ExecutionEntryEnvelopeState;
  readonly perBuyQuoteAmountRaw: bigint;
  readonly maxBuys: number;
  readonly maxTotalExposureRaw: bigint;
  readonly maxRealizedLossRaw: bigint;
  readonly buysArmed: number;
  readonly realizedLossRaw: bigint;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly maximumHoldingMs: number;
  readonly policy: ExecutionRiskPolicyV1;
}

type LockedEnvelope = StoredEnvelope;

const ENVELOPE_ROW_PROJECTION = `envelope_id,payload_version,fingerprint,generation_id,
  operator_id,state,per_buy_quote_amount_raw::TEXT AS per_buy_quote_amount_raw,max_buys,
  max_total_exposure_raw::TEXT AS max_total_exposure_raw,
  max_realized_loss_raw::TEXT AS max_realized_loss_raw,buys_armed,
  realized_loss_raw::TEXT AS realized_loss_raw,
  trunc(EXTRACT(EPOCH FROM valid_from)*1000)::TEXT AS valid_from_ms,
  trunc(EXTRACT(EPOCH FROM valid_until)*1000)::TEXT AS valid_until_ms,
  maximum_holding_ms,policy_fingerprint,risk_policy::TEXT AS risk_policy`;

function storedEnvelopeFrom(value: Readonly<Record<string, unknown>> | undefined): StoredEnvelope {
  const row = exactRow(value, [
    'envelope_id', 'payload_version', 'fingerprint', 'generation_id', 'operator_id', 'state',
    'per_buy_quote_amount_raw', 'max_buys', 'max_total_exposure_raw', 'max_realized_loss_raw',
    'buys_armed', 'realized_loss_raw', 'valid_from_ms', 'valid_until_ms', 'maximum_holding_ms',
    'policy_fingerprint', 'risk_policy',
  ] as const);
  if (row.payload_version !== 2) throw failure('ENVELOPE_NOT_ARMABLE');
  return Object.freeze({
    envelopeId: patterned(row.envelope_id, ENVELOPE_ID_PATTERN),
    payloadVersion: 2,
    fingerprint: patterned(row.fingerprint, /^[0-9a-f]{64}$/u),
    generationId: generationIdFrom(String(row.generation_id)),
    operatorId: patterned(row.operator_id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    state: envelopeState(row.state),
    perBuyQuoteAmountRaw: unsignedBigint(row.per_buy_quote_amount_raw),
    maxBuys: safeInteger(row.max_buys),
    maxTotalExposureRaw: unsignedBigint(row.max_total_exposure_raw),
    maxRealizedLossRaw: unsignedBigint(row.max_realized_loss_raw),
    buysArmed: safeInteger(row.buys_armed),
    realizedLossRaw: unsignedBigint(row.realized_loss_raw),
    validFromMs: timestampText(row.valid_from_ms),
    validUntilMs: timestampText(row.valid_until_ms),
    maximumHoldingMs: safeInteger(row.maximum_holding_ms),
    policy: storedPolicyFrom(row.risk_policy, row.policy_fingerprint),
  });
}

/** The risk policy is stored with canonicalStringifyJson: parseJson restores its bigints. */
function storedPolicyFrom(text: unknown, fingerprint: unknown): ExecutionRiskPolicyV1 {
  const expected = patterned(fingerprint, /^[0-9a-f]{64}$/u);
  let policy: ExecutionRiskPolicyV1;
  try {
    if (typeof text !== 'string') throw new TypeError();
    const parsed = parseJson(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError();
    const { payloadVersion, policyFingerprint, ...fields } = parsed as Record<string, unknown>;
    policy = createExecutionRiskPolicy(fields);
    if (payloadVersion !== 1 || policyFingerprint !== policy.policyFingerprint) throw new TypeError();
  } catch {
    throw failure('INVALID_DATA');
  }
  if (policy.policyFingerprint !== expected) throw failure('INVALID_DATA');
  return policy;
}

/** Callers hold the generation lock (51005): A24. */
async function lockedEnvelope(
  client: DatabaseClient,
  envelopeId: string,
  generationId: string,
): Promise<LockedEnvelope> {
  const envelope = storedEnvelopeFrom(singleRowOr(await client.query(`SELECT
    ${ENVELOPE_ROW_PROJECTION} FROM execution_entry_envelopes
    WHERE envelope_id=$1 AND generation_id=$2 FOR UPDATE`, [envelopeId, generationId]),
  'ENVELOPE_NOT_ARMABLE'));
  if (envelope.state !== 'ACTIVE') throw failure('ENVELOPE_NOT_ARMABLE');
  return envelope;
}

/**
 * On the envelope path, a snapshot superseded concurrently (CONFLICT from the snapshot checks,
 * or a refused risk append) is transient. The CANARY path (`envelope` null) is untouched.
 */
async function envelopeContended<T>(
  envelope: LockedEnvelope | null,
  operation: () => Promise<T>,
): Promise<T> {
  if (envelope === null) return operation();
  try {
    return await operation();
  } catch (error) {
    if ((error instanceof ExecutionOperationsRepositoryError && INTERNAL_ERRORS.has(error)
        && error.code === 'CONFLICT')
      || (error instanceof ExecutionRiskRepositoryError
        && (error.code === 'CONFLICT' || error.code === 'STALE_MEASUREMENT'))) {
      throw failure('ARMAMENT_CONTENDED');
    }
    throw error;
  }
}

/** The request must be exactly what the envelope allows, now (mirrors the 065 trigger). */
function assertEnvelopeRequest(
  request: CanaryArmamentRequest,
  envelope: LockedEnvelope,
  nowMs: number,
): void {
  // Intent-specific: this intent's quote is not the envelope's per-buy amount.
  if (request.payloadVersion !== 2
    || request.target.quoteAmountRaw !== envelope.perBuyQuoteAmountRaw) throw failure('CONFLICT');
  if (request.operatorId !== envelope.operatorId
    || request.maximumCapitalLamports !== envelope.perBuyQuoteAmountRaw
    || request.maximumHoldingMs !== envelope.maximumHoldingMs
    || request.policy.policyFingerprint !== envelope.policy.policyFingerprint
    || nowMs < envelope.validFromMs
    || envelope.validUntilMs < nowMs + envelope.maximumHoldingMs + ENVELOPE_EXIT_MARGIN_MS
    || request.armamentExpiresAtMs > envelope.validUntilMs
    || request.armamentExpiresAtMs - request.armedAtMs > ENVELOPE_ARMAMENT_MAXIMUM_TTL_MS
    || envelope.buysArmed >= envelope.maxBuys
    || BigInt(envelope.buysArmed + 1) * envelope.perBuyQuoteAmountRaw > envelope.maxTotalExposureRaw
    || envelope.realizedLossRaw >= envelope.maxRealizedLossRaw) throw failure('ENVELOPE_NOT_ARMABLE');
}

/**
 * The request carries the current snapshot forward with the executor counters of its billing
 * period (A11, like admission). Anything else is stale: the daemon reads a new context.
 */
async function assertEnvelopeProviderCarryForward(
  client: DatabaseClient,
  request: CanaryArmamentRequest,
  envelope: LockedEnvelope,
  nowMs: number,
): Promise<void> {
  const snapshot = request.providerSnapshot;
  if (snapshot.provenance !== 'EXECUTOR_COUNTERS'
    || snapshot.expiresAtMs > snapshot.measuredAtMs + envelope.policy.providerUsageMaxAgeMs) {
    throw failure('CONFLICT');
  }
  const current = await currentProviderOf(client, snapshot.providerId, true);
  if (current === null) throw failure('PROVIDER_CARRY_FORWARD_STALE');
  const latest = current.snapshot;
  if (snapshot.planId !== latest.planId || snapshot.billingPeriodId !== latest.billingPeriodId
    || snapshot.billingPeriodStartedAtMs !== latest.billingPeriodStartedAtMs
    || snapshot.billingPeriodEndsAtMs !== latest.billingPeriodEndsAtMs
    || snapshot.limitUnits !== latest.limitUnits
    || snapshot.measuredAtMs <= latest.measuredAtMs || snapshot.measuredAtMs > nowMs
    || snapshot.usedUnits !== latest.usedUnits + current.localUsedUnits) {
    throw failure('PROVIDER_CARRY_FORWARD_STALE');
  }
}

const PROVIDER_ROW_PROJECTION = `snapshot_id,payload_version,snapshot_fingerprint,provider_id,
  plan_id,billing_period_id,
  trunc(EXTRACT(EPOCH FROM billing_period_started_at)*1000)::TEXT AS billing_period_started_at_ms,
  trunc(EXTRACT(EPOCH FROM billing_period_ends_at)*1000)::TEXT AS billing_period_ends_at_ms,
  limit_units::TEXT AS limit_units,used_units::TEXT AS used_units,
  trunc(EXTRACT(EPOCH FROM measured_at)*1000)::TEXT AS measured_at_ms,
  trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms,provenance`;

interface CurrentProvider {
  readonly snapshot: ProviderUsageSnapshotV1;
  readonly localUsedUnits: bigint;
}

/** The provider's current snapshot (row-locked when `lock`) and its local counter units. */
async function currentProviderOf(
  client: DatabaseClient,
  providerId: string,
  lock: boolean,
): Promise<CurrentProvider | null> {
  const result = await client.query(`SELECT ${PROVIDER_ROW_PROJECTION}
    FROM execution_provider_usage_snapshots WHERE provider_id=$1 AND superseded_at IS NULL
    ${lock ? 'FOR UPDATE' : ''}`, [providerId]);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  if (result.rows.length === 0) return null;
  const row = exactRow(result.rows[0], [
    'snapshot_id', 'payload_version', 'snapshot_fingerprint', 'provider_id', 'plan_id',
    'billing_period_id', 'billing_period_started_at_ms', 'billing_period_ends_at_ms',
    'limit_units', 'used_units', 'measured_at_ms', 'expires_at_ms', 'provenance',
  ] as const);
  let snapshot: ProviderUsageSnapshotV1;
  try {
    snapshot = createProviderUsageSnapshot({
      providerId: row.provider_id, planId: row.plan_id, billingPeriodId: row.billing_period_id,
      billingPeriodStartedAtMs: timestampText(row.billing_period_started_at_ms),
      billingPeriodEndsAtMs: timestampText(row.billing_period_ends_at_ms),
      limitUnits: unsignedBigint(row.limit_units), usedUnits: unsignedBigint(row.used_units),
      measuredAtMs: timestampText(row.measured_at_ms),
      expiresAtMs: timestampText(row.expires_at_ms), provenance: row.provenance,
    });
  } catch {
    throw failure('INVALID_DATA');
  }
  if (row.payload_version !== 1 || row.snapshot_id !== snapshot.snapshotId
    || row.snapshot_fingerprint !== snapshot.snapshotFingerprint) throw failure('INVALID_DATA');
  const local = exactRow(singleRow(await client.query(`SELECT COALESCE(SUM(units),0)::TEXT AS local_units
    FROM execution_provider_usage_counters
    WHERE provider_id=$1 AND billing_period_id=$2
      AND recorded_at >= TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')`, [
    snapshot.providerId, snapshot.billingPeriodId, snapshot.measuredAtMs,
  ])), ['local_units'] as const);
  return Object.freeze({ snapshot, localUsedUnits: unsignedBigint(local.local_units) });
}

interface ActiveEnvelope {
  readonly envelope: EntryEnvelopeV2;
  readonly qualification: ExecutionSafetyQualificationV2;
  readonly buysArmed: number;
  readonly realizedLossRaw: bigint;
}

/** The ACTIVE v2 envelope, rebuilt from its row and its ENVELOPE qualification (A23). */
async function activeEnvelopeOf(
  client: DatabaseClient,
  generationId: string,
): Promise<ActiveEnvelope | null> {
  const result = await client.query(`SELECT ${ENVELOPE_ROW_PROJECTION}
    FROM execution_entry_envelopes WHERE generation_id=$1 AND state='ACTIVE' AND payload_version=2`,
  [generationId]);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  if (result.rows.length === 0) return null;
  const row = storedEnvelopeFrom(result.rows[0]);
  const qualifications = await client.query(`SELECT qualification_id
    FROM execution_safety_qualifications WHERE envelope_id=$1`, [row.envelopeId]);
  if (qualifications.rows.length !== 1) throw failure('INVALID_DATA');
  const stored = await qualificationForArm(client, patterned(
    exactRow(qualifications.rows[0], ['qualification_id'] as const).qualification_id,
    /^execution_safety_qualification_[0-9a-f]{64}$/u,
  ));
  const qualification = stored.qualification;
  if (qualification.payloadVersion !== 2 || stored.envelopeId !== row.envelopeId) {
    throw failure('INVALID_DATA');
  }
  let envelope: EntryEnvelopeV2;
  try {
    envelope = createEntryEnvelope(Object.freeze({
      payloadVersion: 2, qualification, operatorId: row.operatorId,
      perBuyQuoteAmountRaw: row.perBuyQuoteAmountRaw, maxBuys: row.maxBuys,
      maxTotalExposureRaw: row.maxTotalExposureRaw, maxRealizedLossRaw: row.maxRealizedLossRaw,
      maximumHoldingMs: row.maximumHoldingMs, validFromMs: row.validFromMs,
      validUntilMs: row.validUntilMs, policy: row.policy,
    }));
  } catch {
    throw failure('INVALID_DATA');
  }
  if (envelope.envelopeId !== row.envelopeId || envelope.fingerprint !== row.fingerprint
    || envelope.generationId !== row.generationId) throw failure('INVALID_DATA');
  return Object.freeze({
    envelope, qualification, buysArmed: row.buysArmed, realizedLossRaw: row.realizedLossRaw,
  });
}

interface ActiveArmament {
  readonly state: 'ARMED' | 'LOCKED';
  readonly providerId: string;
  readonly envelopeBound: boolean;
  readonly envelopeId: string | null;
  readonly buySucceeded: boolean;
}

/** An ARMED armament not yet expired, or a LOCKED one whatever its expiry (K=1). */
async function activeArmamentOf(
  client: DatabaseClient,
  generationId: string,
  nowMs: number,
): Promise<ActiveArmament | null> {
  const result = await client.query(`SELECT armament.state,armament.provider_id,
    armament.envelope_id,armament.envelope_id IS NOT NULL AS envelope_bound,intent.status='SUCCEEDED' AS buy_succeeded
    FROM execution_activation_armaments armament
    JOIN execution_intents intent ON intent.id=armament.target_intent_id
    WHERE armament.generation_id=$1 AND (armament.state='LOCKED' OR (armament.state='ARMED'
      AND armament.expires_at > TIMESTAMPTZ 'epoch'+($2::BIGINT*INTERVAL '1 millisecond')))`,
  [generationId, nowMs]);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  if (result.rows.length === 0) return null;
  const row = exactRow(result.rows[0], [
    'state', 'provider_id', 'envelope_id', 'envelope_bound', 'buy_succeeded',
  ] as const);
  if ((row.state !== 'ARMED' && row.state !== 'LOCKED') || typeof row.provider_id !== 'string'
    || typeof row.envelope_bound !== 'boolean' || typeof row.buy_succeeded !== 'boolean'
    || row.envelope_bound !== (row.envelope_id !== null)) {
    throw failure('INVALID_DATA');
  }
  return Object.freeze({
    state: row.state, providerId: row.provider_id,
    envelopeId: row.envelope_id === null ? null : patterned(row.envelope_id, ENVELOPE_ID_PATTERN),
    envelopeBound: row.envelope_bound, buySucceeded: row.buy_succeeded,
  });
}

/** The stored risk policy of one envelope of the generation, whatever its state. */
async function envelopePolicyOf(
  client: DatabaseClient,
  envelopeId: string,
  generationId: string,
): Promise<ExecutionRiskPolicyV1> {
  const row = exactRow(singleRowOr(await client.query(`SELECT policy_fingerprint,
    risk_policy::TEXT AS risk_policy FROM execution_entry_envelopes
    WHERE envelope_id=$1 AND generation_id=$2 AND payload_version=2`, [envelopeId, generationId]),
  'INVALID_DATA'), ['policy_fingerprint', 'risk_policy'] as const);
  return storedPolicyFrom(row.risk_policy, row.policy_fingerprint);
}

/** No ARMED armament, a LOCKED envelope armament whose BUY SUCCEEDED, a snapshot near expiry. */
function refreshDue(
  armament: ActiveArmament | null,
  provider: CurrentProvider | null,
  nowMs: number,
  thresholdMs: number,
): boolean {
  return armament !== null && armament.state === 'LOCKED' && armament.envelopeBound
    && armament.buySucceeded && provider !== null
    && provider.snapshot.providerId === armament.providerId
    && provider.snapshot.expiresAtMs < nowMs + thresholdMs;
}

function autoArmContextQueryFrom(input: ExecutionAutoArmContextQueryV1): ExecutionAutoArmContextQueryV1 {
  const excluded = input.excludedIntentIds;
  if (!Array.isArray(excluded) || excluded.length > 10_000) throw failure('INVALID_DATA');
  return Object.freeze({
    generationId: generationIdFrom(input.generationId),
    minimumRemainingMs: boundedInteger(input.minimumRemainingMs, 0, 3_600_000),
    excludedIntentIds: Object.freeze(excluded.map((id: unknown) => patterned(id, INTENT_ID_PATTERN))),
  });
}

function controlStateFrom(value: unknown): ExecutionControlState {
  if (value !== 'RUNNING' && value !== 'ENTRY_STOP' && value !== 'HARD_STOP') {
    throw failure('INVALID_DATA');
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw failure('INVALID_DATA');
  }
  return value as number;
}

function preflightSourceForRequest(
  request: CanaryArmamentRequest,
  input: ExecutionPreflightDraftSourceV2 | undefined,
): ExecutionPreflightDraftSourceV2 | null {
  if (request.payloadVersion === 2) {
    if (input !== undefined) throw failure('CONFLICT');
    return null;
  }
  if (input === undefined) throw failure('CONFLICT');
  try {
    const source = createExecutionPreflightDraftSource(input);
    if (source.schemaVersion !== 'execution-preflight-draft-source.v2'
      || source.proofFingerprint !== request.lineageProof.proofFingerprint
      || source.lineage.preparationRunId !== request.lineageProof.preparationRunId
      || source.lineage.preparationRunFingerprint !== request.lineageProof.preparationRunFingerprint
      || source.lineage.pairId !== request.lineageProof.pairId
      || source.lineage.pairFingerprint !== request.lineageProof.pairFingerprint
      || source.lineage.targetAssessmentId !== request.lineageProof.targetAssessmentId
      || source.lineage.targetAssessmentFingerprint !== request.lineageProof.targetAssessmentFingerprint
      || source.lineage.simulationArtifactId !== request.lineageProof.simulationArtifactId
      || source.lineage.simulationArtifactFingerprint !== request.lineageProof.simulationArtifactFingerprint
      || source.lineage.preparationManifestFingerprint
        !== request.lineageProof.preparationManifestFingerprint
      || source.lineage.candidateId !== request.lineageProof.candidateId
      || source.lineage.candidateEvidenceFingerprint
        !== request.lineageProof.candidateEvidenceFingerprint
      || source.capturedAtMs !== request.lineageProof.sourceCapturedAtMs
      || source.expiresAtMs !== request.lineageProof.sourceExpiresAtMs
      || source.target.intent.id !== request.target.intentId
      || source.generation.generationId !== request.qualification.generationId
      || source.walletSnapshot.snapshotFingerprint !== request.walletSnapshot.snapshotFingerprint
      || source.providerSnapshot.snapshotFingerprint !== request.providerSnapshot.snapshotFingerprint) {
      throw new TypeError();
    }
    return source;
  } catch { throw failure('CONFLICT'); }
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

interface LockedCanaryTarget {
  readonly intent: ExecutionIntentV1;
  readonly liveReserved: boolean;
}

interface LockedPairedPreflight {
  readonly pairId: string;
  readonly simulationIntentId: string;
}

type CanaryArmamentRequest = ExecutionArmamentRequestV2 | ExecutionArmamentRequestV3;

function canaryRequestFrom(input: CanaryArmamentRequest): CanaryArmamentRequest {
  try {
    const common = {
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
    };
    const canonical = input.payloadVersion === 3
      ? createExecutionArmamentRequestV3({ ...common, payloadVersion: 3,
        lineageProof: input.lineageProof })
      : createExecutionArmamentRequestV2(common);
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
  request: CanaryArmamentRequest,
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

async function lockAndAssertPairedPreflightPair(
  client: DatabaseClient,
  request: ExecutionArmamentRequestV3,
  source: ExecutionPreflightDraftSourceV2 | null,
  nowMs: number,
): Promise<LockedPairedPreflight> {
  if (source?.proofFingerprint !== request.lineageProof.proofFingerprint) {
    throw failure('CONFLICT');
  }
  const proof = request.lineageProof;
  const pair = exactRow(singleRow(await client.query(`SELECT pair_fingerprint,target_intent_id,
    simulation_intent_id,decision_fingerprint,
    trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms,
    expires_at > statement_timestamp() AS fresh
    FROM execution_preflight_intent_pairs WHERE pair_id=$1 FOR UPDATE`, [proof.pairId])), [
    'pair_fingerprint', 'target_intent_id', 'simulation_intent_id', 'decision_fingerprint',
    'expires_at_ms', 'fresh',
  ] as const);
  if (pair.pair_fingerprint !== proof.pairFingerprint
    || pair.target_intent_id !== request.target.intentId
    || pair.decision_fingerprint !== request.target.decisionFingerprint
    || typeof pair.simulation_intent_id !== 'string' || pair.fresh !== true
    || timestampText(pair.expires_at_ms) < proof.sourceExpiresAtMs
    || proof.sourceCapturedAtMs > nowMs || proof.sourceExpiresAtMs <= nowMs) {
    throw failure('CONFLICT');
  }
  return Object.freeze({ pairId: proof.pairId, simulationIntentId: pair.simulation_intent_id });
}

async function lockAndAssertPairedPreflightEvidence(
  client: DatabaseClient,
  request: ExecutionArmamentRequestV3,
  pair: LockedPairedPreflight,
  nowMs: number,
): Promise<void> {
  const proof = request.lineageProof;
  const run = exactRow(singleRow(await client.query(`SELECT run_fingerprint,state,pair_id,
    assessment_id,assessment_fingerprint,artifact_id,artifact_fingerprint,manifest_fingerprint,
    trunc(EXTRACT(EPOCH FROM deadline_at)*1000)::TEXT AS deadline_at_ms,
    deadline_at > statement_timestamp() AS deadline_fresh,
    purge_after > statement_timestamp() AS retained
    FROM execution_preflight_intent_preparation_runs WHERE run_id=$1 FOR UPDATE`,
  [proof.preparationRunId])), [
    'run_fingerprint', 'state', 'pair_id', 'assessment_id', 'assessment_fingerprint',
    'artifact_id', 'artifact_fingerprint', 'manifest_fingerprint', 'deadline_at_ms',
    'deadline_fresh', 'retained',
  ] as const);
  if (run.run_fingerprint !== proof.preparationRunFingerprint || run.state !== 'PREPARED'
    || run.pair_id !== proof.pairId || run.assessment_id !== proof.targetAssessmentId
    || run.assessment_fingerprint !== proof.targetAssessmentFingerprint
    || run.artifact_id !== proof.simulationArtifactId
    || run.artifact_fingerprint !== proof.simulationArtifactFingerprint
    || run.manifest_fingerprint !== proof.preparationManifestFingerprint
    || run.deadline_fresh !== true || run.retained !== true
    || timestampText(run.deadline_at_ms) < proof.sourceExpiresAtMs) throw failure('CONFLICT');

  const evidence = exactRow(singleRow(await client.query(`SELECT
    assessment.intent_id AS assessment_intent_id,
    assessment.result_fingerprint AS assessment_fingerprint,
    assessment.evaluator_version AS assessment_evaluator_version,
    artifact.intent_id AS artifact_intent_id,artifact.attempt_number,
    artifact.result_fingerprint AS artifact_fingerprint,artifact.result_kind,
    artifact.provider_id,artifact.executor_public_key,artifact.expected_genesis_hash,
    artifact.observed_genesis_hash,
    trunc(EXTRACT(EPOCH FROM artifact.recorded_at)*1000)::TEXT AS artifact_recorded_at_ms,
    simulation.status AS simulation_status,simulation.attempt_count AS simulation_attempt_count,
    simulation.live_reserved AS simulation_live_reserved,
    candidate.candidate_id,candidate.evidence_fingerprint AS candidate_evidence_fingerprint,
    candidate.confirmation_status,candidate.state AS candidate_state,
    candidate.superseded_at IS NULL AS candidate_current,
    trunc(EXTRACT(EPOCH FROM candidate.eligible_until)*1000)::TEXT AS candidate_eligible_until_ms,
    candidate.eligible_until > statement_timestamp() AS candidate_eligible,
    trunc(EXTRACT(EPOCH FROM candidate.purge_after)*1000)::TEXT AS candidate_purge_after_ms,
    candidate.purge_after > statement_timestamp() AS candidate_retained,
    generation.generation_id,generation.retired_at IS NULL AS generation_current
    FROM execution_dry_run_assessments assessment
    JOIN execution_simulation_artifacts artifact ON artifact.artifact_id=$2
    JOIN execution_attempts attempt ON attempt.intent_id=artifact.intent_id
      AND attempt.attempt_number=artifact.attempt_number AND attempt.status='COMPLETED'
    JOIN execution_intents simulation ON simulation.id=artifact.intent_id
    JOIN trading_candidates candidate ON candidate.candidate_id=$3
      AND candidate.candidate_id=simulation.candidate_id
    JOIN execution_wallet_generations generation ON generation.generation_id=$4
    WHERE assessment.assessment_id=$1
    FOR UPDATE OF assessment,artifact,attempt,simulation,candidate,generation`, [proof.targetAssessmentId,
      proof.simulationArtifactId, proof.candidateId, request.qualification.generationId])), [
    'assessment_intent_id', 'assessment_fingerprint', 'assessment_evaluator_version',
    'artifact_intent_id', 'attempt_number', 'artifact_fingerprint', 'result_kind', 'provider_id',
    'executor_public_key', 'expected_genesis_hash', 'observed_genesis_hash',
    'artifact_recorded_at_ms', 'simulation_status', 'simulation_attempt_count',
    'simulation_live_reserved', 'candidate_id', 'candidate_evidence_fingerprint',
    'confirmation_status', 'candidate_state', 'candidate_current', 'candidate_eligible_until_ms',
    'candidate_eligible', 'candidate_purge_after_ms', 'candidate_retained', 'generation_id',
    'generation_current',
  ] as const);
  const artifactRecordedAtMs = timestampText(evidence.artifact_recorded_at_ms);
  const candidateEligibleUntilMs = timestampText(evidence.candidate_eligible_until_ms);
  const candidatePurgeAfterMs = timestampText(evidence.candidate_purge_after_ms);
  if (evidence.assessment_intent_id !== request.target.intentId
    || evidence.assessment_fingerprint !== proof.targetAssessmentFingerprint
    || evidence.assessment_evaluator_version !== 1
    || evidence.artifact_intent_id !== pair.simulationIntentId
    || evidence.attempt_number !== 1
    || evidence.artifact_fingerprint !== proof.simulationArtifactFingerprint
    || evidence.result_kind !== 'SUCCESS' || evidence.provider_id !== request.qualification.providerId
    || evidence.executor_public_key !== request.qualification.walletPublicKey
    || evidence.expected_genesis_hash !== request.qualification.genesisHash
    || evidence.observed_genesis_hash !== request.qualification.genesisHash
    || artifactRecordedAtMs > nowMs || artifactRecordedAtMs + 30_000 < nowMs
    || evidence.simulation_status !== 'SUCCEEDED' || evidence.simulation_attempt_count !== 1
    || evidence.simulation_live_reserved !== false || evidence.candidate_id !== proof.candidateId
    || evidence.candidate_evidence_fingerprint !== proof.candidateEvidenceFingerprint
    || evidence.confirmation_status !== 'finalized' || evidence.candidate_state !== 'ELIGIBLE'
    || evidence.candidate_current !== true || evidence.candidate_eligible !== true
    || candidateEligibleUntilMs < proof.sourceExpiresAtMs || evidence.candidate_retained !== true
    || candidatePurgeAfterMs < proof.sourceExpiresAtMs
    || evidence.generation_id !== request.qualification.generationId
    || evidence.generation_current !== true) throw failure('CONFLICT');
  const lineageLocks = await client.query(`SELECT candidate.candidate_id
    FROM execution_intents AS intent
    JOIN trading_candidates AS candidate ON candidate.candidate_id=intent.candidate_id
    JOIN qualification_reports AS report ON report.report_id=candidate.report_id
    JOIN domain_events AS decision ON decision.event_id=intent.decision_event_id
    JOIN domain_events AS source ON source.event_id=candidate.source_event_id
    JOIN domain_events AS candidate_event ON candidate_event.event_id=candidate.candidate_event_id
    JOIN domain_events AS qualification ON qualification.event_id=report.qualification_event_id
    JOIN raw_chain_events AS source_raw ON source_raw.event_id=report.source_raw_event_id
    JOIN paper_positions AS position ON position.position_id=intent.position_id
    WHERE intent.id=$1
    FOR UPDATE OF candidate,report,decision,source,candidate_event,qualification,source_raw,position`,
  [request.target.intentId]);
  if (lineageLocks.rowCount !== 1 || lineageLocks.rows.length !== 1) throw failure('CONFLICT');
}

async function assertCurrentCanaryLineage(
  client: DatabaseClient,
  intentId: string,
): Promise<void> {
  try {
    await assertExecutionIntentLineageCurrentInTransaction(client, intentId);
  } catch (error) {
    if (error instanceof ExecutionIntentLineageRepositoryError) throw failure('CONFLICT');
    throw error;
  }
}

async function lockedCanaryTarget(
  client: DatabaseClient,
  intentId: string,
  expectedPairId: string | null,
  expectedLiveReserved: boolean | null,
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
      ELSE trunc(EXTRACT(EPOCH FROM lease_expires_at)*1000)::TEXT END AS lease_expires_at_ms,
    live_reserved
    FROM execution_intents WHERE id=$1 FOR UPDATE`, [intentId])), [
    'id', 'payload_version', 'logical_order_key', 'strategy_id', 'strategy_version',
    'position_id', 'logical_command_id', 'mint', 'side', 'venue_policy', 'quote_mint',
    'quote_token_program', 'quote_decimals', 'quote_amount_raw', 'base_amount_raw',
    'minimum_amount_out_raw', 'decision_event_id', 'decision_fingerprint',
    'requested_at_ms', 'expires_at_ms', 'status', 'attempt_count', 'state_revision',
    'last_reason_code', 'terminal_at_ms', 'reconciliation_completed_at_ms',
    'purge_after_ms', 'created_at_ms', 'updated_at_ms', 'lease_owner', 'lease_token',
    'lease_expires_at_ms', 'live_reserved',
  ] as const);
  const pairMembership = await client.query(`SELECT pair_id,lane
    FROM execution_preflight_intent_pair_memberships
    WHERE intent_id=$1`, [intentId]);
  if (pairMembership.rows.length > 1 || pairMembership.rowCount !== pairMembership.rows.length) {
    throw failure('INVALID_DATA');
  }
  const [membership] = pairMembership.rows;
  if (membership !== undefined) {
    const exactMembership = exactRow(membership, ['pair_id', 'lane'] as const);
    if (expectedPairId === null || exactMembership.pair_id !== expectedPairId
      || exactMembership.lane !== 'TARGET') throw failure('CONFLICT');
  } else if (expectedPairId !== null) {
    throw failure('CONFLICT');
  }
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
      || row.lease_expires_at_ms !== null || typeof row.live_reserved !== 'boolean'
      || (expectedLiveReserved !== null && row.live_reserved !== expectedLiveReserved)) {
      throw new TypeError();
    }
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
    return Object.freeze({ intent, liveReserved: row.live_reserved });
  } catch {
    throw failure('CONFLICT');
  }
}

async function promoteCanaryTarget(
  client: DatabaseClient,
  intentId: string,
): Promise<void> {
  let promoted;
  try {
    promoted = await client.query(`UPDATE execution_intents
      SET live_reserved=TRUE
      WHERE id=$1 AND live_reserved=FALSE`, [intentId]);
  } catch (error) {
    // 067: a fast-entry probe target is never armable (CANARY v2 has no strategy check).
    if (databaseCode(error) === '23514'
      && (error as { constraint?: unknown }).constraint === 'execution_intents_probe_unarmable_check') {
      throw failure('CONFLICT');
    }
    throw error;
  }
  if (promoted.rowCount !== 1 || promoted.rows.length !== 0) throw failure('CONFLICT');
}

function assertCanaryRequestTarget(
  request: CanaryArmamentRequest,
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

/**
 * A CANARY (v1) qualification binds the exact snapshots through gates 7 and 9 and has no
 * envelope. An ENVELOPE (v2) qualification binds identities instead: it requires its envelope
 * and snapshots of its own generation and provider. The CANARY caller passes `envelopeId` null.
 */
function assertCanaryQualification(
  request: CanaryArmamentRequest,
  qualification: ExecutionSafetyQualification,
  nowMs: number,
  envelopeId: string | null,
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
  if (qualification.payloadVersion === 2) {
    if (envelopeId === null
      || request.walletSnapshot.generationId !== qualification.generationId
      || request.walletSnapshot.providerId !== qualification.providerId
      || request.providerSnapshot.providerId !== qualification.providerId) throw failure('CONFLICT');
    return;
  }
  if (envelopeId !== null) throw failure('CONFLICT');
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
  request: CanaryArmamentRequest,
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
  envelopeId: string | null,
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
    runtime_max_rpc_calls_per_attempt,runtime_lease_ms,envelope_id
  ) VALUES ($1,2,$2,$3,$4,$5,$6,'ARMED',0,'CANARY',$7,$8,$9,$10,'mainnet-beta',$11,
    $12,1,0,$13::NUMERIC,500,1,$14,$15,$16,
    TIMESTAMPTZ 'epoch'+($17::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($18::BIGINT*INTERVAL '1 millisecond'),
    $19,$20,$21,$22::BIGINT,$23,$24,$25,$26,$27,$28::NUMERIC,$29,$30,$31,$32,$33,
    $34,$35::BIGINT,$36::BIGINT,$37::BIGINT,$38::NUMERIC,$39::NUMERIC,$40,$41,$42)`, [
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
    armament.runtimeMaxRpcCallsPerAttempt, armament.runtimeLeaseMs, envelopeId,
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
  qualification: ExecutionSafetyQualification,
  minimumRecordedAtMs: number | null,
): Promise<void> {
  const gate = qualification.gates[10];
  if (gate?.gateId !== 'MAINNET_PREFLIGHT_SIMULATED') {
    throw failure('INVALID_DATA');
  }
  // Absent evidence is a refusal, not corrupt data.
  const artifact = exactRow(singleRowOr(await client.query(`SELECT result_fingerprint,result_kind,
    provider_id,executor_public_key,expected_genesis_hash,observed_genesis_hash,
    configuration_fingerprint,build_fingerprint,
    trunc(EXTRACT(EPOCH FROM recorded_at)*1000)::TEXT AS recorded_at_ms
    FROM execution_simulation_artifacts WHERE artifact_id=$1`, [gate.evidenceId]), 'CONFLICT'), [
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
    || (minimumRecordedAtMs !== null && recordedAtMs < minimumRecordedAtMs)
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

/**
 * Terminalizes the generation's active armament; with `envelopeId`, only the ARMED armament
 * bound to that envelope (never a CANARY armament). Returns whether one was terminalized.
 */
async function terminalizeActiveArmament(
  client: DatabaseClient,
  generationId: string,
  nextState: 'REVOKED' | 'EXPIRED',
  expiredOnly: boolean,
  envelopeId: string | null = null,
): Promise<boolean> {
  const result = await client.query(`SELECT armament_id,payload_version,state,
    target_reservation_id,state_revision::TEXT AS revision,
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms
    FROM execution_activation_armaments WHERE generation_id=$1
      AND state IN ('ARMED','LOCKED')
      AND (payload_version=1 OR state='ARMED')
      AND ($2::BOOLEAN=FALSE OR expires_at <= statement_timestamp())
      AND ($3::TEXT IS NULL OR (envelope_id=$3 AND state='ARMED'))
    FOR UPDATE`, [generationId, expiredOnly, envelopeId]);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  if (result.rows.length === 0) return false;
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
  return true;
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
  action: 'ARM' | 'RESUME' | 'ENVELOPE',
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

/** A stored qualification with the envelope it is bound to (null for CANARY scope). */
interface StoredQualification {
  readonly qualification: ExecutionSafetyQualification;
  readonly envelopeId: string | null;
}

async function qualificationForArm(
  client: DatabaseClient,
  qualificationId: string,
): Promise<StoredQualification> {
  const row = exactRow(singleRow(await client.query(`SELECT
    qualification_id,payload_version,evaluator_version,qualification_fingerprint,
    phase,build_hash,configuration_fingerprint,strategy_fingerprint,generation_id,
    wallet_public_key,cluster,genesis_hash,provider_id,scope,envelope_id,
    trunc(EXTRACT(EPOCH FROM qualified_at)*1000)::TEXT AS qualified_at_ms,
    trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms
    FROM execution_safety_qualifications WHERE qualification_id=$1`,
  [qualificationId])), [
    'qualification_id', 'payload_version', 'evaluator_version', 'qualification_fingerprint',
    'phase', 'build_hash', 'configuration_fingerprint', 'strategy_fingerprint',
    'generation_id', 'wallet_public_key', 'cluster', 'genesis_hash', 'provider_id',
    'scope', 'envelope_id', 'qualified_at_ms', 'expires_at_ms',
  ] as const);
  const evidence = await client.query(`SELECT payload_version,gate_id,status,evidence_type,
    evidence_id,evidence_fingerprint,
    trunc(EXTRACT(EPOCH FROM observed_at)*1000)::TEXT AS observed_at_ms,
    trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms
    FROM execution_safety_gate_evidence WHERE qualification_id=$1 ORDER BY gate_index`,
  [qualificationId]);
  const canonical = createSafetyQualification({
    payloadVersion: row.payload_version, evaluatorVersion: row.evaluator_version,
    ...(row.payload_version === 2 ? { scope: row.scope } : {}),
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
  return Object.freeze({ qualification: canonical, envelopeId: envelopeIdOfQualification(row) });
}

function envelopeIdOfQualification(
  row: Readonly<Record<'payload_version' | 'scope' | 'envelope_id', unknown>>,
): string | null {
  if (row.payload_version === 1 && row.scope === 'CANARY' && row.envelope_id === null) return null;
  if (row.payload_version === 2 && row.scope === 'ENVELOPE') {
    return patterned(row.envelope_id, /^execution_entry_envelope_[0-9a-f]{64}$/u);
  }
  throw failure('INVALID_DATA');
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

function qualificationFrom(input: ExecutionSafetyQualification): ExecutionSafetyQualification {
  const canonical = createSafetyQualification({
    payloadVersion: input.payloadVersion, evaluatorVersion: input.evaluatorVersion,
    ...(input.payloadVersion === 2 ? { scope: input.scope } : {}),
    phase: input.phase, buildHash: input.buildHash,
    configurationFingerprint: input.configurationFingerprint,
    strategyFingerprint: input.strategyFingerprint, generationId: input.generationId,
    walletPublicKey: input.walletPublicKey, cluster: input.cluster, genesisHash: input.genesisHash,
    providerId: input.providerId, qualifiedAtMs: input.qualifiedAtMs,
    expiresAtMs: input.expiresAtMs, gates: input.gates,
  });
  if (canonical.qualificationId !== input.qualificationId
    || canonical.qualificationFingerprint !== input.qualificationFingerprint
    || canonical.payloadVersion !== input.payloadVersion) throw failure('CONFLICT');
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

const ENVELOPE_STATES: readonly ExecutionEntryEnvelopeState[] = Object.freeze([
  'ACTIVE', 'EXHAUSTED', 'REVOKED', 'EXPIRED',
]);

function envelopeFactsQueryFrom(input: ExecutionEnvelopeFactsQueryV1): ExecutionEnvelopeFactsQueryV1 {
  const providerId = input.providerId;
  if (typeof providerId !== 'string' || providerId.length === 0
    || Buffer.byteLength(providerId, 'utf8') > 64) throw failure('INVALID_DATA');
  return Object.freeze({
    buildHash: patterned(input.buildHash, /^[0-9a-f]{64}$/u),
    configurationFingerprint: patterned(input.configurationFingerprint, /^[0-9a-f]{64}$/u),
    walletPublicKey: patterned(input.walletPublicKey, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u),
    providerId,
    genesisHash: patterned(input.genesisHash, /^[1-9A-HJ-NP-Za-km-z]{32,64}$/u),
  });
}

/** Rebuilds the envelope from its own fields and the canonical qualification it names. */
function entryEnvelopeFrom(
  input: EntryEnvelopeV2,
  qualification: ExecutionSafetyQualificationV2,
): EntryEnvelopeV2 {
  let canonical: EntryEnvelopeV2;
  try {
    canonical = createEntryEnvelope({
      payloadVersion: 2,
      qualification,
      operatorId: input.operatorId,
      perBuyQuoteAmountRaw: input.perBuyQuoteAmountRaw,
      maxBuys: input.maxBuys,
      maxTotalExposureRaw: input.maxTotalExposureRaw,
      maxRealizedLossRaw: input.maxRealizedLossRaw,
      maximumHoldingMs: input.maximumHoldingMs,
      validFromMs: input.validFromMs,
      validUntilMs: input.validUntilMs,
      policy: input.policy,
    });
  } catch {
    throw failure('CONFLICT');
  }
  if (canonical.envelopeId !== input.envelopeId
    || canonical.fingerprint !== input.fingerprint
    || input.qualificationId !== qualification.qualificationId) throw failure('CONFLICT');
  return canonical;
}

/** The generation checks of persistQualification; returns the database now. */
async function assertCurrentGeneration(
  client: DatabaseClient,
  qualification: ExecutionSafetyQualification,
): Promise<number> {
  const generation = exactRow(singleRowOr(await client.query(`SELECT wallet_public_key,cluster,
    genesis_hash,retired_at,
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS database_now_ms
    FROM execution_wallet_generations WHERE generation_id=$1`,
  [qualification.generationId]), 'CONFLICT'), [
    'wallet_public_key', 'cluster', 'genesis_hash', 'retired_at', 'database_now_ms',
  ] as const);
  if (generation.wallet_public_key !== qualification.walletPublicKey
    || generation.cluster !== qualification.cluster
    || generation.genesis_hash !== qualification.genesisHash
    || generation.retired_at !== null) throw failure('CONFLICT');
  return timestampText(generation.database_now_ms);
}

/** Callers hold the generation lock (51005). */
async function expireActiveEnvelopes(client: DatabaseClient, generationId: string): Promise<number> {
  const expired = await client.query(`UPDATE execution_entry_envelopes SET state='EXPIRED',
    updated_at=GREATEST(updated_at,date_trunc('milliseconds',statement_timestamp()))
    WHERE generation_id=$1 AND state='ACTIVE' AND valid_until<=statement_timestamp()`,
  [generationId]);
  const count = expired.rowCount ?? 0;
  if (!Number.isSafeInteger(count) || count < 0 || count > 1) throw failure('INVALID_DATA');
  return count;
}

async function insertEntryEnvelope(
  client: DatabaseClient,
  envelope: EntryEnvelopeV2,
  authorizationId: string,
): Promise<void> {
  const inserted = await client.query(`INSERT INTO execution_entry_envelopes (
    envelope_id,generation_id,operator_id,payload_version,fingerprint,per_buy_quote_amount_raw,
    max_buys,max_open_positions,max_total_exposure_raw,max_realized_loss_raw,valid_from,
    valid_until,state,buys_armed,realized_loss_raw,created_at,updated_at,authorization_id,
    risk_policy,policy_fingerprint,maximum_holding_ms
  ) VALUES ($1,$2,$3,2,$4,$5::NUMERIC,$6,1,$7::NUMERIC,$8::NUMERIC,
    TIMESTAMPTZ 'epoch'+($9::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($10::BIGINT*INTERVAL '1 millisecond'),
    'ACTIVE',0,0,
    TIMESTAMPTZ 'epoch'+($9::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($9::BIGINT*INTERVAL '1 millisecond'),
    $11,$12::JSONB,$13,$14)`, [
    envelope.envelopeId, envelope.generationId, envelope.operatorId, envelope.fingerprint,
    envelope.perBuyQuoteAmountRaw.toString(), envelope.maxBuys,
    envelope.maxTotalExposureRaw.toString(), envelope.maxRealizedLossRaw.toString(),
    envelope.validFromMs, envelope.validUntilMs, authorizationId,
    // Canonical JSON with bigint markers: parseJson + createExecutionRiskPolicy rebuild it.
    canonicalStringifyJson(envelope.policy), envelope.policy.policyFingerprint,
    envelope.maximumHoldingMs,
  ]);
  if (inserted.rowCount !== 1) throw failure('CONFLICT');
}

async function insertEnvelopeQualification(
  client: DatabaseClient,
  qualification: ExecutionSafetyQualificationV2,
  envelopeId: string,
): Promise<void> {
  const inserted = await client.query(`INSERT INTO execution_safety_qualifications (
    qualification_id,payload_version,evaluator_version,qualification_fingerprint,
    phase,build_hash,configuration_fingerprint,strategy_fingerprint,generation_id,
    wallet_public_key,cluster,genesis_hash,provider_id,qualified_at,expires_at,purge_after,
    scope,envelope_id
  ) VALUES ($1,2,1,$2,'CANARY',$3,$4,$5,$6,$7,$8,$9,$10,
    TIMESTAMPTZ 'epoch'+($11::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($12::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+(($12::BIGINT+14400000)*INTERVAL '1 millisecond'),
    'ENVELOPE',$13)`, [
    qualification.qualificationId, qualification.qualificationFingerprint,
    qualification.buildHash, qualification.configurationFingerprint,
    qualification.strategyFingerprint, qualification.generationId,
    qualification.walletPublicKey, qualification.cluster, qualification.genesisHash,
    qualification.providerId, qualification.qualifiedAtMs, qualification.expiresAtMs, envelopeId,
  ]);
  if (inserted.rowCount !== 1) throw failure('CONFLICT');
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
}

function envelopeRevokeCommandFrom(
  input: ExecutionEnvelopeRevokeCommandV1,
): ExecutionEnvelopeRevokeCommandV1 {
  return Object.freeze({
    generationId: generationIdFrom(input.generationId),
    envelopeId: patterned(input.envelopeId, /^execution_entry_envelope_[0-9a-f]{64}$/u),
    operatorId: patterned(input.operatorId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    occurredAtMs: timestamp(input.occurredAtMs),
  });
}

function envelopeState(value: unknown): ExecutionEntryEnvelopeState {
  const state = ENVELOPE_STATES.find((candidate) => candidate === value);
  if (state === undefined) throw failure('INVALID_DATA');
  return state;
}

function envelopeSummaryFrom(value: Readonly<Record<string, unknown>>): ExecutionEntryEnvelopeSummaryV1 {
  const row = exactRow(value, [
    'envelope_id', 'payload_version', 'fingerprint', 'generation_id', 'operator_id',
    'per_buy_quote_amount_raw', 'max_buys', 'max_open_positions', 'max_total_exposure_raw',
    'max_realized_loss_raw', 'valid_from_ms', 'valid_until_ms', 'state', 'buys_armed',
    'realized_loss_raw', 'revoked_at_ms', 'created_at_ms', 'updated_at_ms', 'authorization_id',
    'policy_fingerprint', 'maximum_holding_ms', 'qualification_id',
  ] as const);
  return Object.freeze({
    envelopeId: patterned(row.envelope_id, /^[\x21-\x7e]{1,128}$/u),
    payloadVersion: safeInteger(row.payload_version),
    fingerprint: patterned(row.fingerprint, /^[0-9a-f]{64}$/u),
    generationId: patterned(row.generation_id, /^[\x21-\x7e]{1,128}$/u),
    operatorId: patterned(row.operator_id, /^[\x21-\x7e]{1,128}$/u),
    perBuyQuoteAmountRaw: unsignedBigint(row.per_buy_quote_amount_raw),
    maxBuys: safeInteger(row.max_buys),
    maxOpenPositions: safeInteger(row.max_open_positions),
    maxTotalExposureRaw: unsignedBigint(row.max_total_exposure_raw),
    maxRealizedLossRaw: unsignedBigint(row.max_realized_loss_raw),
    validFromMs: timestampText(row.valid_from_ms),
    validUntilMs: timestampText(row.valid_until_ms),
    state: envelopeState(row.state),
    buysArmed: safeInteger(row.buys_armed),
    realizedLossRaw: unsignedBigint(row.realized_loss_raw),
    revokedAtMs: row.revoked_at_ms === null ? null : timestampText(row.revoked_at_ms),
    createdAtMs: timestampText(row.created_at_ms),
    updatedAtMs: timestampText(row.updated_at_ms),
    authorizationId: row.authorization_id === null ? null
      : patterned(row.authorization_id, /^execution_operator_authorization_[0-9a-f]{64}$/u),
    policyFingerprint: row.policy_fingerprint === null ? null
      : patterned(row.policy_fingerprint, /^[0-9a-f]{64}$/u),
    maximumHoldingMs: row.maximum_holding_ms === null ? null : safeInteger(row.maximum_holding_ms),
    qualificationId: row.qualification_id === null ? null
      : patterned(row.qualification_id, /^execution_safety_qualification_[0-9a-f]{64}$/u),
  });
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw failure('INVALID_DATA');
  return value as number;
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

/** Like singleRow, but an absent row is `absentCode`; more than one row stays INVALID_DATA. */
function singleRowOr(
  result: QueryResult,
  absentCode: RepositoryErrorCode,
): Readonly<Record<string, unknown>> {
  if (result.rows.length === 0) throw failure(absentCode);
  return singleRow(result);
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
