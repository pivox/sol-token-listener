import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  createExecutionExitAuthorization,
  createExecutionLivePosition,
  createSignedTransactionArtifact,
  type ExecutionExitAuthorizationV1,
  type ExecutionLivePositionV1,
  type SignedTransactionArtifactV1,
} from '../domain/execution-live.js';
import type { ExecutionReconciliationEvidenceV1 } from '../domain/execution-reconciliation.js';
import {
  assertExecutionIntent,
  createExecutionIntentDraft,
  type ExecutionIntentDraftV1,
  type ExecutionIntentV1,
} from '../domain/execution-intent.js';
import type {
  AuthenticatedPersistedSignedTransactionV1,
  ExecutionDeadlineExitResultV1,
  ExecutionLiveConfirmationV1,
  ExecutionLivePersistSignedInputV1,
  ExecutionLiveReconciliationResultV1,
  ExecutionLiveSignedSimulationEvidenceV1,
  ExecutionLiveSubmissionOutcomeV1,
} from '../ports/execution-live-repository.js';
import type { ClaimedExecutionIntent } from '../ports/execution-intent-repository.js';
import { getDatabasePool } from './database.js';
import {
  ExecutionRiskRepositoryError,
  PostgresExecutionRiskRepository,
  type ExecutionRiskClient,
} from './execution-risk.repository.js';

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
const HASH = /^[0-9a-f]{64}$/u;
const LIVE_SUBMISSION_GATE_KEYS = Object.freeze([
  'artifact_id', 'payload_version', 'specification_version', 'intent_id',
  'attempt_number', 'generation_id', 'armament_id', 'exit_authorization_id',
  'provider_id', 'wallet_public_key', 'side', 'effective_venue', 'message_hash',
  'build_fingerprint', 'snapshot_fingerprint', 'quote_fingerprint', 'blockhash',
  'last_valid_block_height', 'signature', 'signed_transaction_bytes',
  'signed_transaction_hash', 'state', 'state_revision', 'signed_at',
  'signed_simulated_at', 'submission_started_at', 'submitted_at', 'confirmed_at',
  'confirmed_slot', 'reconciled_at', 'purge_after', 'intent_status', 'lease_owner', 'lease_token',
  'lease_expires_at_ms', 'now_ms', 'signed_at_ms', 'control_state',
  'armament_state', 'armament_expires_at_ms', 'qualification_expires_at_ms',
  'reservation_state', 'unknown_block', 'provider_superseded_at',
  'provider_expires_at_ms',
] as const);

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
      if (input.artifact.side === 'SELL') return persistSellSigned(client, input);
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
        reservation.wallet_snapshot_fingerprint,
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
        'wallet_snapshot_fingerprint',
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
      const expected = await client.query(`UPDATE execution_attempts SET
        effective_venue=$3,provider_id=$4,reconciliation_signature=$5,
        reconciliation_blockhash=$6,reconciliation_last_valid_block_height=$7::BIGINT,
        reconciliation_message_hash=$8,reconciliation_build_fingerprint=$9,
        reconciliation_snapshot_fingerprint=$10,
        reconciliation_maximum_fee_lamports=$11::NUMERIC,
        reconciliation_maximum_fee_payer_lamport_debit=$12::NUMERIC
        WHERE intent_id=$1 AND attempt_number=$2 AND status='STARTED'
          AND reconciliation_signature IS NULL`, [
        input.artifact.intentId, input.artifact.attemptNumber,
        input.artifact.effectiveVenue, input.artifact.providerId, input.artifact.signature,
        input.artifact.blockhash, input.artifact.lastValidBlockHeight.toString(),
        input.artifact.messageHash, input.artifact.buildFingerprint,
        input.artifact.snapshotFingerprint,
        input.unsignedSimulation.estimatedFeeLamports.toString(),
        input.unsignedSimulation.simulatedFeePayerLamportDebit.toString(),
      ]);
      if (expected.rowCount !== 1) throw failure('CONFLICT');
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

  public async recordSignedSimulation(
    claimValue: ClaimedExecutionIntent,
    evidence: ExecutionLiveSignedSimulationEvidenceV1,
  ): Promise<AuthenticatedPersistedSignedTransactionV1> {
    const claim = claimFrom(claimValue);
    validateSignedSimulationEvidence(evidence);
    return this.transaction(async (client) => {
      const identity = await artifactIdentity(client, evidence.artifactId);
      await lockGeneration(client, identity.generationId);
      const row = await findArtifact(client, evidence.artifactId, true);
      if (row?.intent_id !== claim.intent.id
        || row.state !== 'PERSISTED' || unsignedBigint(row.state_revision) !== 0n
        || row.signed_transaction_hash !== evidence.signedTransactionHash
        || row.lease_owner !== claim.leaseOwner || row.lease_token !== claim.leaseToken
        || timestampText(row.lease_expires_at_ms) <= timestampText(row.now_ms)) {
        throw failure('LEASE_LOST');
      }
      const artifact = artifactFromRow(row);
      const updated = await client.query(`UPDATE execution_signed_transactions SET
        state='SIGNED_SIMULATED',state_revision=1,
        signed_simulated_at=TIMESTAMPTZ 'epoch'+($2::BIGINT*INTERVAL '1 millisecond')
        WHERE artifact_id=$1 AND state='PERSISTED' AND state_revision=0`, [
        evidence.artifactId, evidence.observedAtMs,
      ]);
      if (updated.rowCount !== 1) throw failure('CONFLICT');
      await insertLiveStateEvent(
        client, artifact, 'PERSISTED', 'SIGNED_SIMULATED',
        'SIGNED_SIMULATION_SUCCEEDED', evidence.observedAtMs,
      );
      return Object.freeze({
        payloadVersion: 1, artifact, state: 'SIGNED_SIMULATED', stateRevision: 1n,
      });
    });
  }

  public async beginSubmission(input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly artifactId: string;
    readonly expectedRevision: bigint;
    readonly observedAtMs: number;
  }>): Promise<AuthenticatedPersistedSignedTransactionV1> {
    const claim = claimFrom(input.claim);
    if (!ARTIFACT_ID.test(input.artifactId) || input.expectedRevision !== 1n
      || !validTimestamp(input.observedAtMs)) throw failure('INVALID_INPUT');
    return this.transaction(async (client) => {
      const identity = await artifactIdentity(client, input.artifactId);
      await lockGeneration(client, identity.generationId);
      const current = await findArtifact(client, input.artifactId, true);
      if (current?.side === 'SELL') {
        return beginSellSubmission(client, claim, input, current);
      }
      const gate = exactRow(singleRow(await client.query(`SELECT
        transaction.*,intent.status AS intent_status,intent.lease_owner,
        intent.lease_token::TEXT AS lease_token,
        trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT AS lease_expires_at_ms,
        trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms,
        trunc(EXTRACT(EPOCH FROM transaction.signed_at)*1000)::TEXT AS signed_at_ms,
        control.state AS control_state,armament.state AS armament_state,
        trunc(EXTRACT(EPOCH FROM armament.expires_at)*1000)::TEXT AS armament_expires_at_ms,
        trunc(EXTRACT(EPOCH FROM qualification.expires_at)*1000)::TEXT
          AS qualification_expires_at_ms,
        reservation.state AS reservation_state,risk.unknown_block,
        provider.superseded_at AS provider_superseded_at,
        trunc(EXTRACT(EPOCH FROM provider.expires_at)*1000)::TEXT AS provider_expires_at_ms
        FROM execution_signed_transactions transaction
        JOIN execution_intents intent ON intent.id=transaction.intent_id
        JOIN execution_control_state control ON control.generation_id=transaction.generation_id
        JOIN execution_activation_armaments armament ON armament.armament_id=transaction.armament_id
        JOIN execution_safety_qualifications qualification
          ON qualification.qualification_id=armament.qualification_id
        JOIN execution_exposure_reservations reservation
          ON reservation.intent_id=transaction.intent_id
        JOIN execution_wallet_risk_state risk ON risk.generation_id=transaction.generation_id
        JOIN execution_provider_usage_snapshots provider
          ON provider.snapshot_fingerprint=reservation.provider_snapshot_fingerprint
          AND provider.provider_id=transaction.provider_id
        WHERE transaction.artifact_id=$1
        FOR UPDATE OF transaction,intent,control,armament,qualification,reservation,risk,provider`, [
        input.artifactId,
      ])), LIVE_SUBMISSION_GATE_KEYS);
      validateSubmissionGate(gate, claim, input.expectedRevision);
      const nowMs = timestampText(gate.now_ms);
      const updated = await client.query(`UPDATE execution_signed_transactions SET
        state='SUBMISSION_STARTED',state_revision=$2::BIGINT,
        submission_started_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')
        WHERE artifact_id=$1 AND state='SIGNED_SIMULATED' AND state_revision=$4::BIGINT`, [
        input.artifactId, (input.expectedRevision + 1n).toString(), nowMs,
        input.expectedRevision.toString(),
      ]);
      if (updated.rowCount !== 1) throw failure('CONFLICT');
      const artifact = artifactFromRow(gate);
      await insertLiveStateEvent(
        client, artifact, 'SIGNED_SIMULATED', 'SUBMISSION_STARTED',
        'SUBMISSION_STARTED', nowMs,
      );
      return Object.freeze({
        payloadVersion: 1, artifact, state: 'SUBMISSION_STARTED',
        stateRevision: input.expectedRevision + 1n,
      });
    });
  }

  public async recordSubmissionOutcome(
    claimValue: ClaimedExecutionIntent,
    outcome: ExecutionLiveSubmissionOutcomeV1,
  ): Promise<SignedTransactionArtifactV1> {
    const claim = claimFrom(claimValue);
    validateSubmissionOutcome(outcome);
    return this.transaction(async (client) => {
      const identity = await artifactIdentity(client, outcome.artifactId);
      await lockGeneration(client, identity.generationId);
      const row = await findArtifact(client, outcome.artifactId, true);
      if (row?.intent_id !== claim.intent.id
        || row.state !== 'SUBMISSION_STARTED'
        || unsignedBigint(row.state_revision) !== outcome.expectedRevision
        || row.lease_owner !== claim.leaseOwner || row.lease_token !== claim.leaseToken) {
        throw failure('LEASE_LOST');
      }
      const artifact = artifactFromRow(row);
      if (outcome.outcome === 'ACCEPTED'
        && outcome.returnedSignature !== artifact.signature) throw failure('CONFLICT');
      const nextState = outcome.outcome === 'ACCEPTED' ? 'ACCEPTED' : 'AMBIGUOUS';
      const nextIntent = outcome.outcome === 'ACCEPTED'
        ? 'SUBMITTED' : 'UNKNOWN_REQUIRES_RECONCILIATION';
      const intentReason = outcome.outcome === 'ACCEPTED'
        ? 'SUBMISSION_ACCEPTED' : 'RECONCILIATION_REQUIRED';
      const updated = await client.query(`UPDATE execution_signed_transactions SET
        state=$2,state_revision=$3::BIGINT,
        submitted_at=CASE WHEN $2='ACCEPTED' THEN
          TIMESTAMPTZ 'epoch'+($4::BIGINT*INTERVAL '1 millisecond') ELSE NULL END
        WHERE artifact_id=$1 AND state='SUBMISSION_STARTED' AND state_revision=$5::BIGINT`, [
        artifact.artifactId, nextState, (outcome.expectedRevision + 1n).toString(),
        outcome.observedAtMs, outcome.expectedRevision.toString(),
      ]);
      if (updated.rowCount !== 1) throw failure('CONFLICT');
      const intent = await client.query(`UPDATE execution_intents SET status=$2,
        state_revision=state_revision+1,last_reason_code=$3,
        updated_at=date_trunc('milliseconds',statement_timestamp())
        WHERE id=$1 AND status='SIGNED_NOT_SUBMITTED' AND lease_owner=$4
          AND lease_token=$5::UUID`, [
        artifact.intentId, nextIntent, intentReason, claim.leaseOwner, claim.leaseToken,
      ]);
      if (intent.rowCount !== 1) throw failure('LEASE_LOST');
      await insertStandardIntentTransition(
        client, artifact, 'SIGNED_NOT_SUBMITTED', nextIntent, intentReason,
        outcome.observedAtMs,
      );
      await insertLiveStateEvent(
        client, artifact, 'SUBMISSION_STARTED', nextState,
        outcome.reasonCode, outcome.observedAtMs,
      );
      if (outcome.outcome === 'AMBIGUOUS') {
        const held = await client.query(`UPDATE execution_exposure_reservations SET
          state='UNKNOWN_HELD',state_revision=state_revision+1
          WHERE intent_id=$1 AND state='RESERVED'`, [artifact.intentId]);
        const blocked = await client.query(`UPDATE execution_wallet_risk_state SET
          unknown_block=TRUE,state_revision=state_revision+1
          WHERE generation_id=$1 AND unknown_block=FALSE`, [artifact.generationId]);
        if (held.rowCount !== 1 || (blocked.rowCount !== 0 && blocked.rowCount !== 1)) {
          throw failure('CONFLICT');
        }
      }
      return artifact;
    });
  }

  public async recordConfirmation(
    claimValue: ClaimedExecutionIntent,
    confirmation: ExecutionLiveConfirmationV1,
  ): Promise<SignedTransactionArtifactV1> {
    const claim = claimFrom(claimValue);
    validateConfirmation(confirmation);
    return this.transaction(async (client) => {
      const identity = await artifactIdentity(client, confirmation.artifactId);
      await lockGeneration(client, identity.generationId);
      const row = await findArtifact(client, confirmation.artifactId, true);
      const previousState = row?.state;
      const previousStatus = row?.intent_status;
      if (row?.intent_id === claim.intent.id && previousState === 'CONFIRMED'
        && previousStatus === 'CONFIRMED'
        && unsignedBigint(row.state_revision) === confirmation.expectedRevision + 1n
        && row.signature === confirmation.signature
        && unsignedBigint(row.confirmed_slot) === confirmation.observedSlot
        && timestampText(row.confirmed_at_ms) === confirmation.observedAtMs
        && row.lease_owner === claim.leaseOwner && row.lease_token === claim.leaseToken) {
        return artifactFromRow(row);
      }
      if (row?.intent_id !== claim.intent.id
        || (previousState !== 'ACCEPTED' && previousState !== 'AMBIGUOUS')
        || (previousStatus !== 'SUBMITTED'
          && previousStatus !== 'UNKNOWN_REQUIRES_RECONCILIATION')
        || unsignedBigint(row.state_revision) !== confirmation.expectedRevision
        || row.signature !== confirmation.signature
        || row.lease_owner !== claim.leaseOwner || row.lease_token !== claim.leaseToken) {
        throw failure('LEASE_LOST');
      }
      const artifact = artifactFromRow(row);
      const updated = await client.query(`UPDATE execution_signed_transactions SET
        state='CONFIRMED',state_revision=$2::BIGINT,
        submitted_at=COALESCE(submitted_at,
          TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')),
        confirmed_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
        confirmed_slot=$6::BIGINT
        WHERE artifact_id=$1 AND state=$4 AND state_revision=$5::BIGINT`, [
        artifact.artifactId, (confirmation.expectedRevision + 1n).toString(),
        confirmation.observedAtMs, previousState, confirmation.expectedRevision.toString(),
        confirmation.observedSlot.toString(),
      ]);
      if (updated.rowCount !== 1) throw failure('CONFLICT');
      const intent = await client.query(`UPDATE execution_intents SET status='CONFIRMED',
        state_revision=state_revision+1,last_reason_code='CONFIRMATION_OBSERVED',
        updated_at=date_trunc('milliseconds',statement_timestamp())
        WHERE id=$1 AND status=$2 AND lease_owner=$3 AND lease_token=$4::UUID`, [
        artifact.intentId, previousStatus, claim.leaseOwner, claim.leaseToken,
      ]);
      if (intent.rowCount !== 1) throw failure('LEASE_LOST');
      await insertStandardIntentTransition(
        client, artifact, previousStatus, 'CONFIRMED', 'CONFIRMATION_OBSERVED',
        confirmation.observedAtMs,
      );
      await insertLiveStateEvent(
        client, artifact, previousState, 'CONFIRMED',
        'CONFIRMATION_OBSERVED', confirmation.observedAtMs,
      );
      return artifact;
    });
  }

  public async commitReconciliation(
    claimValue: ClaimedExecutionIntent,
    evidence: ExecutionReconciliationEvidenceV1,
  ): Promise<ExecutionLiveReconciliationResultV1> {
    const claim = claimFrom(claimValue);
    if (claim.intent.id !== evidence.intentId) throw failure('INVALID_INPUT');
    if (evidence.side === 'SELL') {
      return this.transaction((client) => commitSellReconciliation(client, claim, evidence));
    }
    const liveResults: Awaited<ReturnType<typeof applyLiveReconciliation>>[] = [];
    try {
      const committed = await new PostgresExecutionRiskRepository(this.#source)
        .reconcileWithHook(Object.freeze({ payloadVersion: 1, evidence }),
          async (client, exactEvidence): Promise<void> => {
            liveResults.push(await applyLiveReconciliation(client, claim, exactEvidence));
          });
      const result = liveResults[0];
      if (result === undefined || liveResults.length !== 1) throw failure('INVALID_DATA');
      return Object.freeze({
        payloadVersion: 1,
        result: committed.result,
        artifact: result.artifact,
        position: result.position,
        exitAuthorization: result.exitAuthorization,
      });
    } catch (error) {
      if (error instanceof ExecutionLiveRepositoryError && INTERNAL_ERRORS.has(error)) throw error;
      if (error instanceof ExecutionRiskRepositoryError) {
        throw failure(error.code === 'COMMIT_OUTCOME_UNKNOWN'
          ? 'COMMIT_OUTCOME_UNKNOWN' : 'DATABASE_FAILURE');
      }
      throw failure('DATABASE_FAILURE');
    }
  }

  public async createDeadlineExitIntent(input: Readonly<{
    readonly positionId: string;
    readonly observedAtMs: number;
  }>): Promise<ExecutionDeadlineExitResultV1> {
    if (!/^execution_live_position_[0-9a-f]{64}$/u.test(input.positionId)
      || !validTimestamp(input.observedAtMs)) throw failure('INVALID_INPUT');
    return this.transaction(async (client) => {
      const identity = exactRow(singleRow(await client.query(`SELECT generation_id
        FROM execution_live_positions WHERE position_id=$1`, [input.positionId])), [
        'generation_id',
      ] as const);
      if (typeof identity.generation_id !== 'string') throw failure('INVALID_DATA');
      await lockGeneration(client, identity.generation_id);
      const row = exactRow(singleRow(await client.query(`SELECT
        position.position_id,position.state,position.state_revision::TEXT AS position_revision,
        position.exit_intent_id,position.mint,position.quote_mint,
        position.remaining_base_raw::TEXT AS remaining_base_raw,
        trunc(EXTRACT(EPOCH FROM position.exit_deadline_at)*1000)::TEXT AS exit_deadline_at_ms,
        position.entry_reconciliation_fingerprint,
        buy.quote_token_program,buy.quote_decimals
        FROM execution_live_positions position
        JOIN execution_intents buy ON buy.id=position.buy_intent_id
        WHERE position.position_id=$1 FOR UPDATE OF position`, [input.positionId])), [
        'position_id', 'state', 'position_revision', 'exit_intent_id', 'mint', 'quote_mint',
        'remaining_base_raw', 'exit_deadline_at_ms', 'entry_reconciliation_fingerprint',
        'quote_token_program', 'quote_decimals',
      ] as const);
      if (input.observedAtMs < timestampText(row.exit_deadline_at_ms)) {
        return Object.freeze({ payloadVersion: 1, kind: 'NOT_DUE', intent: null });
      }
      const logicalCommandId = `maximum-holding:${input.positionId}`;
      const draft = createExecutionIntentDraft({
        strategyId: 'maximum-holding-exit',
        strategyVersion: 1,
        positionId: input.positionId,
        logicalCommandId,
        mint: row.mint,
        side: 'SELL',
        venuePolicy: 'CANONICAL_EXIT',
        quoteMint: row.quote_mint,
        quoteTokenProgram: row.quote_token_program,
        quoteDecimals: integer(row.quote_decimals),
        quoteAmountRaw: null,
        baseAmountRaw: unsignedBigint(row.remaining_base_raw),
        minimumAmountOutRaw: 1n,
        decisionEventId: logicalCommandId,
        decisionFingerprint: row.entry_reconciliation_fingerprint,
        requestedAtMs: input.observedAtMs,
        expiresAtMs: input.observedAtMs + 120_000,
      });
      if (row.exit_intent_id !== null) {
        if (row.exit_intent_id !== draft.id) throw failure('CONFLICT');
        return Object.freeze({
          payloadVersion: 1,
          kind: 'REPLAYED',
          intent: await findDeadlineIntent(client, draft),
        });
      }
      if (row.state !== 'OPEN' || unsignedBigint(row.remaining_base_raw) === 0n) {
        throw failure('CONFLICT');
      }
      const inserted = await client.query(`INSERT INTO execution_intents (
        id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,
        logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,
        quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,
        decision_event_id,decision_fingerprint,requested_at,expires_at,status
      ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,'SELL','CANONICAL_EXIT',$8,$9,$10,NULL,
        $11::NUMERIC,$12::NUMERIC,$13,$14,
        TIMESTAMPTZ 'epoch'+($15::BIGINT*INTERVAL '1 millisecond'),
        TIMESTAMPTZ 'epoch'+($16::BIGINT*INTERVAL '1 millisecond'),'PENDING')`, [
        draft.id, draft.logicalOrderKey, draft.strategyId, draft.strategyVersion,
        draft.positionId, draft.logicalCommandId, draft.mint, draft.quoteMint,
        draft.quoteTokenProgram, draft.quoteDecimals, draft.baseAmountRaw?.toString(),
        draft.minimumAmountOutRaw.toString(), draft.decisionEventId,
        draft.decisionFingerprint, draft.requestedAtMs, draft.expiresAtMs,
      ]);
      if (inserted.rowCount !== 1) throw failure('CONFLICT');
      const revision = unsignedBigint(row.position_revision);
      const positioned = await client.query(`UPDATE execution_live_positions SET
        state='EXIT_PENDING',state_revision=$2::BIGINT,exit_intent_id=$3
        WHERE position_id=$1 AND state='OPEN' AND state_revision=$4::BIGINT
          AND exit_intent_id IS NULL`, [
        input.positionId, (revision + 1n).toString(), draft.id, revision.toString(),
      ]);
      if (positioned.rowCount !== 1) throw failure('CONFLICT');
      return Object.freeze({
        payloadVersion: 1,
        kind: 'CREATED',
        intent: await findDeadlineIntent(client, draft),
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
      || (input.reservationId !== null
        && !/^execution_exposure_reservation_[0-9a-f]{64}$/u.test(input.reservationId))) {
      throw new TypeError();
    }
    const claim = claimFrom(input.claim);
    const artifact = recreateArtifact(input.artifact);
    const simulation = input.unsignedSimulation;
    if (artifact.artifactId !== input.artifact.artifactId
      || artifact.signedTransactionHash !== input.artifact.signedTransactionHash
      || artifact.intentId !== claim.intent.id
      || claim.intent.status !== 'PROCESSING'
      || simulation.messageHash !== artifact.messageHash
      || simulation.buildFingerprint !== artifact.buildFingerprint
      || simulation.snapshotFingerprint !== artifact.snapshotFingerprint
      || simulation.blockhash !== artifact.blockhash
      || simulation.lastValidBlockHeight !== artifact.lastValidBlockHeight) {
      throw new TypeError();
    }
    if ((artifact.side === 'BUY'
      && (artifact.armamentId === null || artifact.exitAuthorizationId !== null
        || input.reservationId === null))
      || (artifact.side === 'SELL'
        && (artifact.armamentId !== null || artifact.exitAuthorizationId === null
          || input.reservationId !== null))) throw new TypeError();
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

async function persistSellSigned(
  client: DatabaseClient,
  input: ExecutionLivePersistSignedInputV1,
): Promise<SignedTransactionArtifactV1> {
  const artifact = input.artifact;
  if (artifact.exitAuthorizationId === null) throw failure('INVALID_INPUT');
  const binding = exactRow(singleRow(await client.query(`SELECT
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms,
    intent.status AS intent_status,intent.side AS intent_side,
    intent.base_amount_raw::TEXT AS intent_base_amount_raw,
    intent.mint,intent.quote_mint,intent.lease_owner,
    intent.lease_token::TEXT AS lease_token,
    trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT AS lease_expires_at_ms,
    attempt.status AS attempt_status,generation.wallet_public_key,generation.retired_at,
    control.state AS control_state,exit_auth.state AS authorization_state,
    exit_auth.state_revision::TEXT AS authorization_revision,
    exit_auth.generation_id AS authorization_generation_id,
    exit_auth.wallet_public_key AS authorization_wallet_public_key,
    exit_auth.mint AS authorization_mint,exit_auth.quote_mint AS authorization_quote_mint,
    exit_auth.maximum_base_amount_raw::TEXT AS maximum_base_amount_raw,
    position.state AS position_state,position.exit_intent_id,
    position.remaining_base_raw::TEXT AS remaining_base_raw,
    armament.provider_id
    FROM execution_intents intent
    JOIN execution_attempts attempt ON attempt.intent_id=intent.id
      AND attempt.attempt_number=$2
    JOIN execution_wallet_generations generation ON generation.generation_id=$3
    JOIN execution_control_state control ON control.generation_id=generation.generation_id
    JOIN execution_exit_authorizations exit_auth ON exit_auth.authorization_id=$4
    JOIN execution_live_positions position ON position.position_id=exit_auth.position_id
    JOIN execution_activation_armaments armament ON armament.armament_id=position.armament_id
    WHERE intent.id=$1
    FOR UPDATE OF intent,attempt,generation,control,exit_auth,position,armament`, [
    artifact.intentId, artifact.attemptNumber, artifact.generationId,
    artifact.exitAuthorizationId,
  ])), [
    'now_ms', 'intent_status', 'intent_side', 'intent_base_amount_raw', 'mint', 'quote_mint',
    'lease_owner', 'lease_token', 'lease_expires_at_ms', 'attempt_status',
    'wallet_public_key', 'retired_at', 'control_state', 'authorization_state',
    'authorization_revision', 'authorization_generation_id', 'authorization_wallet_public_key',
    'authorization_mint', 'authorization_quote_mint', 'maximum_base_amount_raw',
    'position_state', 'exit_intent_id', 'remaining_base_raw', 'provider_id',
  ] as const);
  const nowMs = timestampText(binding.now_ms);
  const amount = unsignedBigint(binding.intent_base_amount_raw);
  if (binding.lease_owner !== input.claim.leaseOwner
    || binding.lease_token !== input.claim.leaseToken
    || timestampText(binding.lease_expires_at_ms) <= nowMs) throw failure('LEASE_LOST');
  if (binding.intent_status !== 'PROCESSING' || binding.intent_side !== 'SELL'
    || binding.attempt_status !== 'STARTED' || binding.retired_at !== null
    || binding.control_state === 'HARD_STOP'
    || binding.wallet_public_key !== artifact.walletPublicKey
    || binding.authorization_state !== 'ACTIVE'
    || binding.authorization_generation_id !== artifact.generationId
    || binding.authorization_wallet_public_key !== artifact.walletPublicKey
    || binding.authorization_mint !== binding.mint
    || binding.authorization_quote_mint !== binding.quote_mint
    || binding.position_state !== 'EXIT_PENDING'
    || binding.exit_intent_id !== artifact.intentId
    || amount === 0n || amount > unsignedBigint(binding.maximum_base_amount_raw)
    || amount > unsignedBigint(binding.remaining_base_raw)
    || binding.provider_id !== artifact.providerId) throw failure('PREFLIGHT_EXPIRED');
  const authorizationRevision = unsignedBigint(binding.authorization_revision);
  const locked = await client.query(`UPDATE execution_exit_authorizations SET
    state='LOCKED',state_revision=$2::BIGINT,locked_intent_id=$3,
    locked_attempt_number=$4::INTEGER
    WHERE authorization_id=$1 AND state='ACTIVE' AND state_revision=$5::BIGINT`, [
    artifact.exitAuthorizationId, (authorizationRevision + 1n).toString(),
    artifact.intentId, artifact.attemptNumber, authorizationRevision.toString(),
  ]);
  if (locked.rowCount !== 1) throw failure('CONFLICT');
  await insertArtifact(client, artifact);
  const expected = await client.query(`UPDATE execution_attempts SET
    effective_venue=$3,provider_id=$4,reconciliation_signature=$5,
    reconciliation_blockhash=$6,reconciliation_last_valid_block_height=$7::BIGINT,
    reconciliation_message_hash=$8,reconciliation_build_fingerprint=$9,
    reconciliation_snapshot_fingerprint=$10,
    reconciliation_maximum_fee_lamports=$11::NUMERIC,
    reconciliation_maximum_fee_payer_lamport_debit=$12::NUMERIC
    WHERE intent_id=$1 AND attempt_number=$2 AND status='STARTED'
      AND reconciliation_signature IS NULL`, [
    artifact.intentId, artifact.attemptNumber, artifact.effectiveVenue,
    artifact.providerId, artifact.signature, artifact.blockhash,
    artifact.lastValidBlockHeight.toString(), artifact.messageHash,
    artifact.buildFingerprint, artifact.snapshotFingerprint,
    input.unsignedSimulation.estimatedFeeLamports.toString(),
    input.unsignedSimulation.simulatedFeePayerLamportDebit.toString(),
  ]);
  if (expected.rowCount !== 1) throw failure('CONFLICT');
  const transitioned = await client.query(`UPDATE execution_intents SET
    status='SIGNED_NOT_SUBMITTED',state_revision=state_revision+2,
    last_reason_code='SIGNATURE_PERSISTED',updated_at=date_trunc('milliseconds',statement_timestamp())
    WHERE id=$1 AND status='PROCESSING' AND state_revision=$4::BIGINT
      AND lease_owner=$2 AND lease_token=$3::UUID
      AND lease_expires_at > statement_timestamp()`, [
    artifact.intentId, input.claim.leaseOwner, input.claim.leaseToken,
    input.claim.intent.stateRevision.toString(),
  ]);
  if (transitioned.rowCount !== 1) throw failure('LEASE_LOST');
  await insertIntentTransitions(client, input, nowMs);
  await insertSubmissionEvent(client, artifact, nowMs);
  return artifact;
}

async function beginSellSubmission(
  client: DatabaseClient,
  claim: ClaimedExecutionIntent,
  input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly artifactId: string;
    readonly expectedRevision: bigint;
    readonly observedAtMs: number;
  }>,
  current: Row,
): Promise<AuthenticatedPersistedSignedTransactionV1> {
  const artifact = artifactFromRow(current);
  if (artifact.exitAuthorizationId === null
    || current.intent_id !== claim.intent.id
    || current.state !== 'SIGNED_SIMULATED'
    || unsignedBigint(current.state_revision) !== input.expectedRevision
    || current.intent_status !== 'SIGNED_NOT_SUBMITTED'
    || current.lease_owner !== claim.leaseOwner || current.lease_token !== claim.leaseToken
    || timestampText(current.lease_expires_at_ms) <= timestampText(current.now_ms)) {
    throw failure('LEASE_LOST');
  }
  const gate = exactRow(singleRow(await client.query(`SELECT
    control.state AS control_state,exit_auth.state AS authorization_state,
    exit_auth.locked_intent_id,exit_auth.locked_attempt_number,
    position.state AS position_state,position.remaining_base_raw::TEXT AS remaining_base_raw,
    armament.provider_id
    FROM execution_exit_authorizations exit_auth
    JOIN execution_live_positions position ON position.position_id=exit_auth.position_id
    JOIN execution_activation_armaments armament ON armament.armament_id=position.armament_id
    JOIN execution_control_state control ON control.generation_id=exit_auth.generation_id
    WHERE exit_auth.authorization_id=$1
    FOR UPDATE OF exit_auth,position,armament,control`, [artifact.exitAuthorizationId])), [
    'control_state', 'authorization_state', 'locked_intent_id', 'locked_attempt_number',
    'position_state', 'remaining_base_raw', 'provider_id',
  ] as const);
  if (gate.control_state === 'HARD_STOP' || gate.authorization_state !== 'LOCKED'
    || gate.locked_intent_id !== artifact.intentId
    || integer(gate.locked_attempt_number) !== artifact.attemptNumber
    || gate.position_state !== 'EXIT_PENDING'
    || unsignedBigint(gate.remaining_base_raw) === 0n
    || gate.provider_id !== artifact.providerId) throw failure('PREFLIGHT_EXPIRED');
  const nowMs = timestampText(current.now_ms);
  const updated = await client.query(`UPDATE execution_signed_transactions SET
    state='SUBMISSION_STARTED',state_revision=$2::BIGINT,
    submission_started_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')
    WHERE artifact_id=$1 AND state='SIGNED_SIMULATED' AND state_revision=$4::BIGINT`, [
    artifact.artifactId, (input.expectedRevision + 1n).toString(), nowMs,
    input.expectedRevision.toString(),
  ]);
  if (updated.rowCount !== 1) throw failure('CONFLICT');
  await insertLiveStateEvent(
    client, artifact, 'SIGNED_SIMULATED', 'SUBMISSION_STARTED', 'SUBMISSION_STARTED', nowMs,
  );
  return Object.freeze({
    payloadVersion: 1,
    artifact,
    state: 'SUBMISSION_STARTED',
    stateRevision: input.expectedRevision + 1n,
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
    || row.wallet_snapshot_fingerprint !== input.artifact.snapshotFingerprint
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
  ) VALUES ($1,1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::BIGINT,
    $17,$18,$19,'PERSISTED',0,
    TIMESTAMPTZ 'epoch'+($20::BIGINT*INTERVAL '1 millisecond'))`, [
    artifact.artifactId, artifact.intentId, artifact.attemptNumber,
    artifact.generationId, artifact.armamentId, artifact.exitAuthorizationId,
    artifact.providerId, artifact.walletPublicKey, artifact.side,
    artifact.effectiveVenue, artifact.messageHash,
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
    trunc(EXTRACT(EPOCH FROM transaction.signed_at)*1000)::TEXT AS signed_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.confirmed_at)*1000)::TEXT AS confirmed_at_ms
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

async function artifactIdentity(
  client: DatabaseClient,
  artifactId: string,
): Promise<Readonly<{ readonly generationId: string }>> {
  if (!ARTIFACT_ID.test(artifactId)) throw failure('INVALID_INPUT');
  const row = exactRow(singleRow(await client.query(`SELECT generation_id
    FROM execution_signed_transactions WHERE artifact_id=$1`, [artifactId])), [
    'generation_id',
  ] as const);
  if (typeof row.generation_id !== 'string') throw failure('INVALID_DATA');
  return Object.freeze({ generationId: row.generation_id });
}

function validateSignedSimulationEvidence(
  evidence: ExecutionLiveSignedSimulationEvidenceV1,
): void {
  if (!ARTIFACT_ID.test(evidence.artifactId)
    || !HASH.test(evidence.signedTransactionHash)
    || !HASH.test(evidence.evidenceFingerprint)
    || !unsigned(evidence.simulationSlot) || !positiveUnsigned(evidence.unitsConsumed)
    || !unsigned(evidence.feePayerLamportDebit)
    || typeof evidence.baseDeltaRaw !== 'bigint'
    || typeof evidence.quoteDeltaRaw !== 'bigint'
    || !validTimestamp(evidence.observedAtMs)) throw failure('INVALID_INPUT');
}

function validateSubmissionGate(
  row: Row,
  claim: ClaimedExecutionIntent,
  expectedRevision: bigint,
): void {
  const nowMs = timestampText(row.now_ms);
  if (row.lease_owner !== claim.leaseOwner || row.lease_token !== claim.leaseToken
    || timestampText(row.lease_expires_at_ms) <= nowMs) throw failure('LEASE_LOST');
  if (row.control_state !== 'RUNNING') throw failure('CONTROL_STOPPED');
  if (row.intent_status !== 'SIGNED_NOT_SUBMITTED'
    || row.state !== 'SIGNED_SIMULATED'
    || unsignedBigint(row.state_revision) !== expectedRevision
    || row.armament_state !== 'LOCKED'
    || timestampText(row.armament_expires_at_ms) <= nowMs
    || timestampText(row.qualification_expires_at_ms) <= nowMs
    || row.reservation_state !== 'RESERVED' || row.unknown_block !== false
    || row.provider_superseded_at !== null
    || timestampText(row.provider_expires_at_ms) <= nowMs) throw failure('PREFLIGHT_EXPIRED');
}

function validateSubmissionOutcome(outcome: ExecutionLiveSubmissionOutcomeV1): void {
  if (!ARTIFACT_ID.test(outcome.artifactId)
    || outcome.expectedRevision < 1n || !validTimestamp(outcome.observedAtMs)
    || (outcome.outcome === 'ACCEPTED'
      && (outcome.reasonCode !== 'SUBMISSION_ACCEPTED'
        || typeof outcome.returnedSignature !== 'string'))
    || (outcome.outcome === 'AMBIGUOUS'
      && (outcome.returnedSignature !== null
        || (outcome.reasonCode !== 'SUBMISSION_AMBIGUOUS'
          && outcome.reasonCode !== 'SUBMISSION_SIGNATURE_MISMATCH')))) {
    throw failure('INVALID_INPUT');
  }
}

function validateConfirmation(confirmation: ExecutionLiveConfirmationV1): void {
  if (!ARTIFACT_ID.test(confirmation.artifactId)
    || confirmation.expectedRevision < 1n
    || typeof confirmation.signature !== 'string' || confirmation.signature.length < 64
    || !unsigned(confirmation.observedSlot)
    || !validTimestamp(confirmation.observedAtMs)) throw failure('INVALID_INPUT');
}

async function insertLiveStateEvent(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
  previousState: 'PERSISTED' | 'SIGNED_SIMULATED' | 'SUBMISSION_STARTED'
    | 'ACCEPTED' | 'AMBIGUOUS' | 'CONFIRMED',
  nextState: 'SIGNED_SIMULATED' | 'SUBMISSION_STARTED' | 'ACCEPTED' | 'AMBIGUOUS'
    | 'CONFIRMED' | 'RECONCILED',
  reasonCode: 'SIGNED_SIMULATION_SUCCEEDED' | 'SUBMISSION_STARTED'
    | 'SUBMISSION_ACCEPTED' | 'SUBMISSION_AMBIGUOUS'
    | 'SUBMISSION_SIGNATURE_MISMATCH' | 'CONFIRMATION_OBSERVED'
    | 'RECONCILIATION_REQUIRED' | 'RECONCILIATION_PROVED_NO_EFFECT' | 'INTENT_SUCCEEDED',
  occurredAtMs: number,
): Promise<void> {
  const eventFingerprint = hash([
    'execution-submission-event-v1', artifact.artifactId, previousState,
    nextState, reasonCode, occurredAtMs,
  ]);
  const result = await client.query(`INSERT INTO execution_submission_events (
    event_id,payload_version,event_fingerprint,artifact_id,generation_id,
    previous_state,next_state,reason_code,occurred_at
  ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,
    TIMESTAMPTZ 'epoch'+($8::BIGINT*INTERVAL '1 millisecond'))`, [
    `execution_submission_event_${eventFingerprint}`, eventFingerprint,
    artifact.artifactId, artifact.generationId, previousState, nextState,
    reasonCode, occurredAtMs,
  ]);
  if (result.rowCount !== 1) throw failure('CONFLICT');
}

async function insertStandardIntentTransition(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
  previousStatus: 'SIGNED_NOT_SUBMITTED' | 'SUBMITTED' | 'UNKNOWN_REQUIRES_RECONCILIATION',
  nextStatus: 'SUBMITTED' | 'UNKNOWN_REQUIRES_RECONCILIATION' | 'CONFIRMED',
  reasonCode: 'SUBMISSION_ACCEPTED' | 'RECONCILIATION_REQUIRED' | 'CONFIRMATION_OBSERVED',
  occurredAtMs: number,
): Promise<void> {
  const result = await client.query(`INSERT INTO execution_intent_transitions (
    intent_id,previous_status,next_status,reason_code,human_message,activation_phase,
    attempt_number,evidence,occurred_at
  ) VALUES ($1,$2,$3,$4,$5,'CANARY',$6,
    jsonb_build_object('payloadVersion',1,'attemptNumber',$6::INTEGER,
      'sourceEventId',NULL,'observedAtMs',$7::BIGINT),
    TIMESTAMPTZ 'epoch'+($7::BIGINT*INTERVAL '1 millisecond'))`, [
    artifact.intentId, previousStatus, nextStatus, reasonCode,
    nextStatus === 'SUBMITTED'
      ? 'Persisted transaction accepted by provider.'
      : nextStatus === 'CONFIRMED'
        ? 'Persisted transaction confirmed by provider.'
        : 'Submission outcome requires reconciliation.',
    artifact.attemptNumber, occurredAtMs,
  ]);
  if (result.rowCount !== 1) throw failure('CONFLICT');
}

async function applyLiveReconciliation(
  client: ExecutionRiskClient,
  claim: ClaimedExecutionIntent,
  evidence: ExecutionReconciliationEvidenceV1,
): Promise<Readonly<{
  readonly artifact: SignedTransactionArtifactV1;
  readonly position: ExecutionLivePositionV1 | null;
  readonly exitAuthorization: ExecutionExitAuthorizationV1 | null;
}>> {
  const row = singleRow(await client.query(`SELECT transaction.*,
    trunc(EXTRACT(EPOCH FROM transaction.signed_at)*1000)::TEXT AS signed_at_ms,
    intent.mint,intent.quote_mint,armament.maximum_holding_ms
    FROM execution_signed_transactions transaction
    JOIN execution_intents intent ON intent.id=transaction.intent_id
    LEFT JOIN execution_activation_armaments armament
      ON armament.armament_id=transaction.armament_id
    WHERE transaction.intent_id=$1 AND transaction.attempt_number=$2
    FOR UPDATE OF transaction`, [evidence.intentId, evidence.attemptNumber]));
  if (row.intent_id !== claim.intent.id || row.signature !== evidence.signature
    || row.blockhash !== evidence.blockhash || row.message_hash !== evidence.messageHash
    || row.build_fingerprint !== evidence.buildFingerprint
    || row.snapshot_fingerprint !== evidence.snapshotFingerprint) throw failure('CONFLICT');
  const artifact = artifactFromRow(row);
  const revision = unsignedBigint(row.state_revision);
  if (row.state === 'RECONCILED') {
    if (evidence.result === 'NO_EFFECT') {
      return Object.freeze({ artifact, position: null, exitAuthorization: null });
    }
    if (evidence.result !== 'MATCHED' || artifact.side !== 'BUY'
      || artifact.armamentId === null || evidence.finalizedAtMs === null
      || evidence.baseDeltaRaw <= 0n || evidence.quoteDeltaRaw >= 0n) {
      throw failure('CONFLICT');
    }
    const replayed = createEntryRecords(artifact, row, evidence);
    const existing = exactRow(singleRow(await client.query(`SELECT
      position.position_id,position.state AS position_state,
      position.entry_reconciliation_fingerprint,
      exit_auth.authorization_id,exit_auth.state AS authorization_state
      FROM execution_live_positions position
      JOIN execution_exit_authorizations exit_auth
        ON exit_auth.position_id=position.position_id
      WHERE position.buy_intent_id=$1`, [artifact.intentId])), [
      'position_id', 'position_state', 'entry_reconciliation_fingerprint',
      'authorization_id', 'authorization_state',
    ] as const);
    if (existing.position_id !== replayed.position.positionId
      || existing.position_state !== 'OPEN'
      || existing.entry_reconciliation_fingerprint !== evidence.evidenceFingerprint
      || existing.authorization_id !== replayed.authorization.authorizationId
      || existing.authorization_state !== 'ACTIVE') throw failure('CONFLICT');
    return Object.freeze({
      artifact,
      position: replayed.position,
      exitAuthorization: replayed.authorization,
    });
  }
  if (evidence.result === 'NO_EFFECT') {
    const finalizedAtMs = evidence.finalizedAtMs;
    if (finalizedAtMs === null || row.state !== 'AMBIGUOUS') throw failure('CONFLICT');
    const updated = await client.query(`UPDATE execution_signed_transactions SET
      state='RECONCILED',state_revision=$2::BIGINT,
      reconciled_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
      purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond')
      WHERE artifact_id=$1 AND state='AMBIGUOUS' AND state_revision=$4::BIGINT`, [
      artifact.artifactId, (revision + 1n).toString(), finalizedAtMs, revision.toString(),
    ]);
    if (updated.rowCount !== 1) throw failure('CONFLICT');
    await insertLiveStateEvent(
      client, artifact, 'AMBIGUOUS', 'RECONCILED',
      'RECONCILIATION_PROVED_NO_EFFECT', finalizedAtMs,
    );
    return Object.freeze({ artifact, position: null, exitAuthorization: null });
  }
  if (evidence.result !== 'MATCHED') {
    if (row.state !== 'AMBIGUOUS') {
      if (row.state !== 'ACCEPTED' && row.state !== 'CONFIRMED') throw failure('CONFLICT');
      const updated = await client.query(`UPDATE execution_signed_transactions SET
        state='AMBIGUOUS',state_revision=$2::BIGINT
        WHERE artifact_id=$1 AND state=$3 AND state_revision=$4::BIGINT`, [
        artifact.artifactId, (revision + 1n).toString(), row.state, revision.toString(),
      ]);
      if (updated.rowCount !== 1) throw failure('CONFLICT');
      await insertLiveStateEvent(
        client, artifact, row.state, 'AMBIGUOUS',
        'RECONCILIATION_REQUIRED', evidence.observedAtMs,
      );
    }
    return Object.freeze({ artifact, position: null, exitAuthorization: null });
  }
  const finalizedAtMs = evidence.finalizedAtMs;
  if (finalizedAtMs === null || artifact.side !== 'BUY' || artifact.armamentId === null
    || evidence.baseDeltaRaw <= 0n || evidence.quoteDeltaRaw >= 0n
    || row.state !== 'CONFIRMED') throw failure('CONFLICT');
  const updated = await client.query(`UPDATE execution_signed_transactions SET
    state='RECONCILED',state_revision=$2::BIGINT,
    reconciled_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond')
    WHERE artifact_id=$1 AND state='CONFIRMED' AND state_revision=$4::BIGINT`, [
    artifact.artifactId, (revision + 1n).toString(), finalizedAtMs, revision.toString(),
  ]);
  if (updated.rowCount !== 1) throw failure('CONFLICT');
  const entry = createEntryRecords(artifact, row, evidence);
  const { position, authorization } = entry;
  const insertedPosition = await client.query(`INSERT INTO execution_live_positions (
    position_id,payload_version,buy_intent_id,generation_id,armament_id,wallet_public_key,
    mint,quote_mint,entry_venue,quote_cost_raw,base_amount_raw,remaining_base_raw,
    fee_lamports,maximum_holding_ms,opened_at,exit_deadline_at,
    entry_reconciliation_fingerprint,state,state_revision
  ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,'PUMP_FUN',$8::NUMERIC,$9::NUMERIC,$9::NUMERIC,
    $10::NUMERIC,$11::INTEGER,
    TIMESTAMPTZ 'epoch'+($12::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($13::BIGINT*INTERVAL '1 millisecond'),$14,'OPEN',0)`, [
    position.positionId, position.buyIntentId, position.generationId, position.armamentId,
    position.walletPublicKey, position.mint, position.quoteMint, position.quoteCostRaw.toString(),
    position.baseAmountRaw.toString(), position.feeLamports.toString(),
    position.maximumHoldingMs, position.openedAtMs, position.exitDeadlineAtMs,
    position.entryReconciliationFingerprint,
  ]);
  if (insertedPosition.rowCount !== 1) throw failure('CONFLICT');
  const insertedAuthorization = await client.query(`INSERT INTO execution_exit_authorizations (
    authorization_id,payload_version,position_id,generation_id,wallet_public_key,mint,
    quote_mint,maximum_base_amount_raw,state,state_revision,created_at
  ) VALUES ($1,1,$2,$3,$4,$5,$6,$7::NUMERIC,'ACTIVE',0,
    TIMESTAMPTZ 'epoch'+($8::BIGINT*INTERVAL '1 millisecond'))`, [
    authorization.authorizationId, authorization.positionId, authorization.generationId,
    authorization.walletPublicKey, authorization.mint, authorization.quoteMint,
    authorization.maximumBaseAmountRaw.toString(), authorization.createdAtMs,
  ]);
  if (insertedAuthorization.rowCount !== 1) throw failure('CONFLICT');
  await insertLiveStateEvent(
    client, artifact, 'CONFIRMED', 'RECONCILED', 'INTENT_SUCCEEDED', finalizedAtMs,
  );
  return Object.freeze({ artifact, position, exitAuthorization: authorization });
}

function createEntryRecords(
  artifact: SignedTransactionArtifactV1,
  row: Row,
  evidence: ExecutionReconciliationEvidenceV1,
): Readonly<{
  readonly position: ExecutionLivePositionV1;
  readonly authorization: ExecutionExitAuthorizationV1;
}> {
  if (artifact.armamentId === null || evidence.finalizedAtMs === null) {
    throw failure('CONFLICT');
  }
  const position = createExecutionLivePosition({
    payloadVersion: 1,
    positionId: `execution_live_position_${hash([
      'execution-live-position-v1', artifact.intentId, evidence.evidenceFingerprint,
    ])}`,
    buyIntentId: artifact.intentId,
    generationId: artifact.generationId,
    armamentId: artifact.armamentId,
    walletPublicKey: artifact.walletPublicKey,
    mint: row.mint,
    quoteMint: row.quote_mint,
    entryVenue: 'PUMP_FUN',
    quoteCostRaw: -evidence.quoteDeltaRaw,
    baseAmountRaw: evidence.baseDeltaRaw,
    feeLamports: evidence.feeLamports,
    maximumHoldingMs: integer(row.maximum_holding_ms),
    openedAtMs: evidence.finalizedAtMs,
    entryReconciliationFingerprint: evidence.evidenceFingerprint,
  });
  const authorization = createExecutionExitAuthorization({
    payloadVersion: 1,
    authorizationId: `execution_exit_authorization_${hash([
      'execution-exit-authorization-v1', position.positionId,
      evidence.evidenceFingerprint,
    ])}`,
    positionId: position.positionId,
    generationId: position.generationId,
    walletPublicKey: position.walletPublicKey,
    mint: position.mint,
    quoteMint: position.quoteMint,
    maximumBaseAmountRaw: position.baseAmountRaw,
    createdAtMs: evidence.finalizedAtMs,
  });
  return Object.freeze({ position, authorization });
}

async function commitSellReconciliation(
  client: DatabaseClient,
  claim: ClaimedExecutionIntent,
  evidence: ExecutionReconciliationEvidenceV1,
): Promise<ExecutionLiveReconciliationResultV1> {
  const identity = await client.query(`SELECT generation_id FROM execution_signed_transactions
    WHERE intent_id=$1 AND attempt_number=$2`, [evidence.intentId, evidence.attemptNumber]);
  const generationId = exactRow(singleRow(identity), ['generation_id'] as const).generation_id;
  if (typeof generationId !== 'string') throw failure('INVALID_DATA');
  await lockGeneration(client, generationId);
  const row = singleRow(await client.query(`SELECT transaction.*,
    trunc(EXTRACT(EPOCH FROM transaction.signed_at)*1000)::TEXT AS signed_at_ms,
    intent.status AS intent_status,intent.state_revision::TEXT AS intent_revision,
    intent.lease_owner,intent.lease_token::TEXT AS lease_token,
    trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT AS lease_expires_at_ms,
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms,
    attempt.status AS attempt_status,attempt.provider_id AS attempt_provider_id,
    attempt.reconciliation_signature,attempt.reconciliation_blockhash,
    attempt.reconciliation_last_valid_block_height::TEXT
      AS reconciliation_last_valid_block_height,
    attempt.reconciliation_message_hash,attempt.reconciliation_build_fingerprint,
    attempt.reconciliation_snapshot_fingerprint,
    attempt.reconciliation_maximum_fee_lamports::TEXT AS reconciliation_maximum_fee_lamports,
    attempt.reconciliation_maximum_fee_payer_lamport_debit::TEXT
      AS reconciliation_maximum_fee_payer_lamport_debit,
    generation.generation,exit_auth.state AS authorization_state,
    exit_auth.state_revision::TEXT AS authorization_revision,
    position.position_id,position.state AS position_state,
    position.state_revision::TEXT AS position_revision,
    position.remaining_base_raw::TEXT AS remaining_base_raw,
    position.quote_cost_raw::TEXT AS quote_cost_raw,
    position.armament_id AS position_armament_id,
    risk.state_revision::TEXT AS risk_revision,
    risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,risk.open_positions,
    armament.state AS armament_state,armament.state_revision::TEXT AS armament_revision
    FROM execution_signed_transactions transaction
    JOIN execution_intents intent ON intent.id=transaction.intent_id
    JOIN execution_attempts attempt ON attempt.intent_id=transaction.intent_id
      AND attempt.attempt_number=transaction.attempt_number
    JOIN execution_wallet_generations generation
      ON generation.generation_id=transaction.generation_id
    JOIN execution_exit_authorizations exit_auth
      ON exit_auth.authorization_id=transaction.exit_authorization_id
    JOIN execution_live_positions position ON position.position_id=exit_auth.position_id
    JOIN execution_wallet_risk_state risk ON risk.generation_id=transaction.generation_id
    JOIN execution_activation_armaments armament ON armament.armament_id=position.armament_id
    WHERE transaction.intent_id=$1 AND transaction.attempt_number=$2
    FOR UPDATE OF transaction,intent,attempt,generation,exit_auth,position,risk,armament`, [
    evidence.intentId, evidence.attemptNumber,
  ]));
  const artifact = artifactFromRow(row);
  const prior = await client.query(`SELECT evidence_fingerprint,result,intent_id,
    attempt_number,side FROM execution_reconciliation_evidence WHERE evidence_id=$1`, [
    evidence.evidenceId,
  ]);
  if (prior.rows.length > 1) throw failure('INVALID_DATA');
  if (prior.rows.length === 1) {
    const replay = exactRow(singleRow(prior), [
      'evidence_fingerprint', 'result', 'intent_id', 'attempt_number', 'side',
    ] as const);
    if (replay.evidence_fingerprint !== evidence.evidenceFingerprint
      || replay.result !== 'MATCHED' || replay.intent_id !== evidence.intentId
      || integer(replay.attempt_number) !== evidence.attemptNumber || replay.side !== 'SELL'
      || row.state !== 'RECONCILED' || row.intent_status !== 'SUCCEEDED'
      || row.attempt_status !== 'COMPLETED' || row.authorization_state !== 'CONSUMED'
      || row.position_state !== 'CLOSED' || row.armament_state !== 'CONSUMED') {
      throw failure('CONFLICT');
    }
    return Object.freeze({
      payloadVersion: 1,
      result: 'MATCHED',
      artifact,
      position: null,
      exitAuthorization: null,
    });
  }
  const finalizedAtMs = evidence.finalizedAtMs;
  if (evidence.result !== 'MATCHED' || finalizedAtMs === null
    || artifact.side !== 'SELL' || artifact.exitAuthorizationId === null
    || row.intent_id !== claim.intent.id || row.intent_status !== 'CONFIRMED'
    || row.lease_owner !== claim.leaseOwner || row.lease_token !== claim.leaseToken
    || timestampText(row.lease_expires_at_ms) <= timestampText(row.now_ms)
    || row.state !== 'CONFIRMED' || row.attempt_status !== 'STARTED'
    || row.attempt_provider_id !== evidence.providerId
    || row.generation !== evidence.walletGeneration
    || row.reconciliation_signature !== evidence.signature
    || row.reconciliation_blockhash !== evidence.blockhash
    || row.reconciliation_last_valid_block_height !== evidence.lastValidBlockHeight.toString()
    || row.reconciliation_message_hash !== evidence.messageHash
    || row.reconciliation_build_fingerprint !== evidence.buildFingerprint
    || row.reconciliation_snapshot_fingerprint !== evidence.snapshotFingerprint
    || row.reconciliation_maximum_fee_lamports !== evidence.maximumFeeLamports.toString()
    || row.reconciliation_maximum_fee_payer_lamport_debit
      !== evidence.maximumFeePayerLamportDebit.toString()
    || row.authorization_state !== 'LOCKED' || row.position_state !== 'EXIT_PENDING'
    || row.armament_state !== 'LOCKED'
    || evidence.baseDeltaRaw >= 0n
    || -evidence.baseDeltaRaw !== unsignedBigint(row.remaining_base_raw)
    || evidence.quoteDeltaRaw <= 0n) throw failure('CONFLICT');
  const insertedEvidence = await client.query(`INSERT INTO execution_reconciliation_evidence (
    evidence_id,payload_version,evidence_fingerprint,intent_id,attempt_number,reservation_id,
    generation_id,provider_id,side,signature,blockhash,last_valid_block_height,message_hash,
    build_fingerprint,snapshot_fingerprint,maximum_fee_lamports,
    maximum_fee_payer_lamport_debit,signature_history,confirmation_status,
    finalized_block_height,observed_slot,observed_transaction_fingerprint,fee_lamports,
    wallet_lamport_delta,base_delta_raw,quote_delta_raw,
    unexpected_residual_token_balance_raw,observed_at,finalized_at,result,reason_code,purge_after
  ) VALUES ($1,1,$2,$3,$4,NULL,$5,$6,'SELL',$7,$8,$9::BIGINT,$10,$11,$12,
    $13::NUMERIC,$14::NUMERIC,$15,$16,$17::BIGINT,$18::BIGINT,$19,$20::NUMERIC,
    $21::NUMERIC,$22::NUMERIC,$23::NUMERIC,$24::NUMERIC,
    TIMESTAMPTZ 'epoch'+($25::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($26::BIGINT*INTERVAL '1 millisecond'),$27,$28,
    TIMESTAMPTZ 'epoch'+(($26::BIGINT+14400000)*INTERVAL '1 millisecond'))`, [
    evidence.evidenceId, evidence.evidenceFingerprint, evidence.intentId,
    evidence.attemptNumber, artifact.generationId, evidence.providerId,
    evidence.signature, evidence.blockhash, evidence.lastValidBlockHeight.toString(),
    evidence.messageHash, evidence.buildFingerprint, evidence.snapshotFingerprint,
    evidence.maximumFeeLamports.toString(), evidence.maximumFeePayerLamportDebit.toString(),
    evidence.signatureHistory, evidence.confirmationStatus,
    evidence.finalizedBlockHeight.toString(), evidence.observedSlot?.toString() ?? null,
    evidence.observedTransactionFingerprint, evidence.feeLamports.toString(),
    evidence.walletLamportDelta.toString(), evidence.baseDeltaRaw.toString(),
    evidence.quoteDeltaRaw.toString(), evidence.unexpectedResidualTokenBalanceRaw.toString(),
    evidence.observedAtMs, finalizedAtMs, evidence.result, evidence.reasonCode,
  ]);
  if (insertedEvidence.rowCount !== 1) throw failure('CONFLICT');
  const artifactRevision = unsignedBigint(row.state_revision);
  const artifactUpdate = await client.query(`UPDATE execution_signed_transactions SET
    state='RECONCILED',state_revision=$2::BIGINT,
    reconciled_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond')
    WHERE artifact_id=$1 AND state='CONFIRMED' AND state_revision=$4::BIGINT`, [
    artifact.artifactId, (artifactRevision + 1n).toString(), finalizedAtMs,
    artifactRevision.toString(),
  ]);
  const positionRevision = unsignedBigint(row.position_revision);
  const positionUpdate = await client.query(`UPDATE execution_live_positions SET
    state='CLOSED',state_revision=$2::BIGINT,remaining_base_raw=0,
    exit_reconciliation_fingerprint=$3,closed_at=TIMESTAMPTZ 'epoch'
      +($4::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($4::BIGINT+14400000)*INTERVAL '1 millisecond')
    WHERE position_id=$1 AND state='EXIT_PENDING' AND state_revision=$5::BIGINT`, [
    row.position_id, (positionRevision + 1n).toString(), evidence.evidenceFingerprint,
    finalizedAtMs, positionRevision.toString(),
  ]);
  const authorizationRevision = unsignedBigint(row.authorization_revision);
  const authorizationUpdate = await client.query(`UPDATE execution_exit_authorizations SET
    state='CONSUMED',state_revision=$2::BIGINT,
    terminal_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond')
    WHERE authorization_id=$1 AND state='LOCKED' AND state_revision=$4::BIGINT`, [
    artifact.exitAuthorizationId, (authorizationRevision + 1n).toString(), finalizedAtMs,
    authorizationRevision.toString(),
  ]);
  const armamentRevision = unsignedBigint(row.armament_revision);
  const armamentUpdate = await client.query(`UPDATE execution_activation_armaments SET
    state='CONSUMED',state_revision=$2::BIGINT,
    terminal_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond')
    WHERE armament_id=$1 AND state='LOCKED' AND state_revision=$4::BIGINT`, [
    row.position_armament_id, (armamentRevision + 1n).toString(), finalizedAtMs,
    armamentRevision.toString(),
  ]);
  const riskRevision = unsignedBigint(row.risk_revision);
  const reservedExposure = unsignedBigint(row.reserved_exposure_raw);
  const quoteCost = unsignedBigint(row.quote_cost_raw);
  const openPositions = integer(row.open_positions);
  if (reservedExposure < quoteCost || openPositions < 1) throw failure('INVALID_DATA');
  const riskUpdate = await client.query(`UPDATE execution_wallet_risk_state SET
    state_revision=$2::BIGINT,reserved_exposure_raw=$3::NUMERIC,open_positions=$4,
    unknown_block=EXISTS (SELECT 1 FROM execution_exposure_reservations
      WHERE generation_id=$1 AND state='UNKNOWN_HELD'),
    updated_at=TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond')
    WHERE generation_id=$1 AND state_revision=$6::BIGINT`, [
    artifact.generationId, (riskRevision + 1n).toString(),
    (reservedExposure - quoteCost).toString(), openPositions - 1,
    finalizedAtMs, riskRevision.toString(),
  ]);
  const transition = await client.query(`INSERT INTO execution_intent_transitions (
    intent_id,previous_status,next_status,reason_code,human_message,activation_phase,
    attempt_number,evidence,occurred_at
  ) VALUES ($1,'CONFIRMED','SUCCEEDED','INTENT_SUCCEEDED',
    'Finalized canary exit reconciled.','CANARY',$2,
    jsonb_build_object('payloadVersion',1,'attemptNumber',$2::INTEGER,
      'sourceEventId',NULL,'observedAtMs',$3::BIGINT),
    TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'))`, [
    artifact.intentId, artifact.attemptNumber, finalizedAtMs,
  ]);
  const intentRevision = unsignedBigint(row.intent_revision);
  const intentUpdate = await client.query(`UPDATE execution_intents SET
    status='SUCCEEDED',state_revision=$2::BIGINT,last_reason_code='INTENT_SUCCEEDED',
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
    terminal_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    reconciliation_completed_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond'),
    updated_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')
    WHERE id=$1 AND status='CONFIRMED' AND state_revision=$4::BIGINT`, [
    artifact.intentId, (intentRevision + 1n).toString(), finalizedAtMs,
    intentRevision.toString(),
  ]);
  const attemptUpdate = await client.query(`UPDATE execution_attempts SET
    status='COMPLETED',completed_at=TIMESTAMPTZ 'epoch'
      +($3::BIGINT*INTERVAL '1 millisecond'),reason_code='ATTEMPT_COMPLETED'
    WHERE intent_id=$1 AND attempt_number=$2 AND status='STARTED'`, [
    artifact.intentId, artifact.attemptNumber, finalizedAtMs,
  ]);
  if ([artifactUpdate, positionUpdate, authorizationUpdate, armamentUpdate, riskUpdate,
    transition, intentUpdate, attemptUpdate].some((result) => result.rowCount !== 1)) {
    throw failure('CONFLICT');
  }
  await insertLiveStateEvent(
    client, artifact, 'CONFIRMED', 'RECONCILED', 'INTENT_SUCCEEDED', finalizedAtMs,
  );
  const activationFingerprint = hash([
    'execution-activation-event-v1', row.position_armament_id, 'LOCKED', 'CONSUMED',
    'ARMAMENT_CONSUMED', finalizedAtMs,
  ]);
  const activation = await client.query(`INSERT INTO execution_activation_events (
    event_id,payload_version,event_fingerprint,armament_id,generation_id,
    previous_state,next_state,reason_code,occurred_at
  ) VALUES ($1,1,$2,$3,$4,'LOCKED','CONSUMED','ARMAMENT_CONSUMED',
    TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond'))`, [
    `execution_activation_event_${activationFingerprint}`, activationFingerprint,
    row.position_armament_id, artifact.generationId, finalizedAtMs,
  ]);
  if (activation.rowCount !== 1) throw failure('CONFLICT');
  return Object.freeze({
    payloadVersion: 1,
    result: 'MATCHED',
    artifact,
    position: null,
    exitAuthorization: null,
  });
}

async function findDeadlineIntent(
  client: DatabaseClient,
  draft: ExecutionIntentDraftV1,
): Promise<ExecutionIntentV1> {
  const row = exactRow(singleRow(await client.query(`SELECT status,attempt_count,
    state_revision::TEXT AS state_revision,last_reason_code,
    CASE WHEN terminal_at IS NULL THEN NULL ELSE
      trunc(EXTRACT(EPOCH FROM terminal_at)*1000)::TEXT END AS terminal_at_ms,
    CASE WHEN reconciliation_completed_at IS NULL THEN NULL ELSE
      trunc(EXTRACT(EPOCH FROM reconciliation_completed_at)*1000)::TEXT END
      AS reconciliation_completed_at_ms,
    CASE WHEN purge_after IS NULL THEN NULL ELSE
      trunc(EXTRACT(EPOCH FROM purge_after)*1000)::TEXT END AS purge_after_ms,
    trunc(EXTRACT(EPOCH FROM created_at)*1000)::TEXT AS created_at_ms,
    trunc(EXTRACT(EPOCH FROM updated_at)*1000)::TEXT AS updated_at_ms
    FROM execution_intents WHERE id=$1 AND logical_order_key=$2`, [
    draft.id, draft.logicalOrderKey,
  ])), [
    'status', 'attempt_count', 'state_revision', 'last_reason_code', 'terminal_at_ms',
    'reconciliation_completed_at_ms', 'purge_after_ms', 'created_at_ms', 'updated_at_ms',
  ] as const);
  const candidate = Object.freeze({
    ...draft,
    status: row.status,
    attemptCount: integer(row.attempt_count),
    stateRevision: unsignedBigint(row.state_revision),
    lastReasonCode: row.last_reason_code,
    terminalAtMs: nullableTimestampText(row.terminal_at_ms),
    reconciliationCompletedAtMs: nullableTimestampText(row.reconciliation_completed_at_ms),
    purgeAfterMs: nullableTimestampText(row.purge_after_ms),
    createdAtMs: timestampText(row.created_at_ms),
    updatedAtMs: timestampText(row.updated_at_ms),
  });
  try {
    assertExecutionIntent(candidate);
  } catch {
    throw failure('INVALID_DATA');
  }
  return candidate;
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

function nullableTimestampText(value: unknown): number | null {
  return value === null ? null : timestampText(value);
}

function unsignedBigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw failure('INVALID_DATA');
  }
  return BigInt(value);
}

function unsigned(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= 18_446_744_073_709_551_615n;
}

function positiveUnsigned(value: unknown): value is bigint {
  return unsigned(value) && value > 0n;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= 8_640_000_000_000_000;
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
