import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import bs58 from 'bs58';
import type pg from 'pg';
import {
  createExecutionExitAuthorization,
  createExecutionLivePosition,
  createSignedTransactionArtifact,
  createSignedTransactionArtifactId,
  type ExecutionExitAuthorizationState,
  type ExecutionExitAuthorizationV1,
  type ExecutionLivePositionState,
  type ExecutionLivePositionV1,
  type SignedTransactionArtifactV1,
} from '../domain/execution-live.js';
import {
  assertExecutionLiveSignedSimulationEvidence,
  createExecutionLiveUnsignedSimulationEvidenceIdentity,
} from
  '../domain/execution-live-signed-simulation.js';
import {
  evaluateExecutionReconciliation,
  type ExecutionReconciliationEvidenceV1,
} from '../domain/execution-reconciliation.js';
import type { ExecutionSimulationEvidenceV1 } from
  '../ports/execution-simulation-gateway.js';
import {
  assertExecutionIntent,
  createExecutionIntentDraft,
  type ExecutionIntentDraftV1,
  type ExecutionIntentV1,
} from '../domain/execution-intent.js';
import { lockLiveSellPresenceInTransaction } from './execution-intent.repository.js';
import type {
  AuthenticatedPersistedSignedTransactionV1,
  AuthenticatedSubmissionStartedTransactionV1,
  ExecutionBlockhashValidityEvidenceV1,
  ExecutionDeadlineExitResultV1,
  ExecutionLiveConfirmationV1,
  ExecutionLiveConfirmationWorkV1,
  ExecutionLiveArtifactReferenceV1,
  ExecutionLivePersistSignedInputV1,
  ExecutionLivePersistSignedResultV1,
  ExecutionLivePreparationBindingV1,
  ExecutionPreSubmissionRevocationInputV1,
  ExecutionPreSubmissionRevocationResultV1,
  ExecutionLiveReconciliationResultV1,
  ExecutionLiveReconciliationWorkV1,
  ExecutionLiveSignedTransactionInspectionV1,
  ExecutionLiveSignedSimulationEvidenceV1,
  ExecutionLiveSubmissionOutcomeV1,
  ExecutionLiveSubmissionOutcomeResultV1,
  ExecutionLiveRuntimeBindingV1,
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
const PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/u;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BLOCKHASH_VALIDITY_MAX_AGE_MS = 5_000;
const ARTIFACT_REFERENCE_COLUMNS = `
  transaction.artifact_id,transaction.payload_version,transaction.specification_version,
  transaction.intent_id,transaction.attempt_number,transaction.generation_id,
  transaction.armament_id,transaction.reservation_id,transaction.exit_authorization_id,
  transaction.provider_id,transaction.wallet_public_key,transaction.side,
  transaction.effective_venue,transaction.message_hash,transaction.build_fingerprint,
  transaction.snapshot_fingerprint,transaction.quote_fingerprint,
  transaction.quote_observed_at,transaction.quote_expires_at,transaction.blockhash,
  transaction.last_valid_block_height,transaction.signature,
  transaction.signed_transaction_hash,transaction.state,transaction.state_revision,
  transaction.signed_at,transaction.signed_simulated_at,transaction.submission_started_at,
  transaction.submitted_at,transaction.confirmed_at,transaction.confirmed_slot,
  transaction.reconciled_at,transaction.revoked_at,transaction.purge_after`;
const AUTHORITATIVE_CLAIM_PROJECTION = `
  status AS claim_status,attempt_count AS claim_attempt_count,
  state_revision::TEXT AS claim_state_revision,last_reason_code AS claim_last_reason_code,
  trunc(EXTRACT(EPOCH FROM updated_at)*1000)::TEXT AS claim_updated_at_ms,
  lease_owner AS claim_lease_owner,lease_token::TEXT AS claim_lease_token,
  trunc(EXTRACT(EPOCH FROM lease_expires_at)*1000)::TEXT AS claim_lease_expires_at_ms`;
const RUNTIME_BINDING_KEYS = Object.freeze([
  'payloadVersion', 'phase', 'buildHash', 'configurationFingerprint',
  'strategyFingerprint', 'walletPublicKey', 'cluster', 'expectedGenesisHash',
  'observedGenesisHash', 'providerId',
] as const);
export class PostgresExecutionLiveRepository {
  readonly #source: DatabaseSource;

  public constructor(
    source: DatabaseSource | Pick<InstanceType<typeof pg.Pool>, 'connect'> = getDatabasePool(),
  ) {
    this.#source = source;
  }

  public async readPreparationBinding(inputValue: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly generationId: string;
    readonly runtime: ExecutionLiveRuntimeBindingV1;
  }>): Promise<ExecutionLivePreparationBindingV1> {
    const claim = claimFrom(inputValue.claim);
    if (!/^execution_wallet_generation_[0-9a-f]{64}$/u.test(inputValue.generationId)
      || !validRuntimeBinding(inputValue.runtime)
      || claim.intent.status !== 'PROCESSING' || claim.intent.attemptCount < 1) {
      throw failure('INVALID_INPUT');
    }
    const input = Object.freeze({
      claim,
      generationId: inputValue.generationId,
      runtime: inputValue.runtime,
    });
    return this.transaction((client) => input.claim.intent.side === 'BUY'
      ? readBuyPreparationBinding(client, input)
      : readSellPreparationBinding(client, input));
  }

  public async persistSigned(
    inputValue: ExecutionLivePersistSignedInputV1,
  ): Promise<ExecutionLivePersistSignedResultV1> {
    const input = persistInputFrom(inputValue);
    return this.transaction(async (client) => {
      if (input.artifact.side === 'SELL') {
        await lockLiveSellPresenceInTransaction(client);
      }
      await lockGeneration(client, input.artifact.generationId);
      const replay = await findArtifact(client, input.artifact.artifactId, true);
      if (replay !== null) {
        if (!sameArtifact(replay, input.artifact)) throw failure('CONFLICT');
        await persistUnsignedSimulationEvidence(client, input);
        return persistedResult(input.artifact, replayedPersistClaim(input.claim, replay));
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
        FOR UPDATE OF intent,attempt,armament,risk,reservation`, [
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
      await persistUnsignedSimulationEvidence(client, input);
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
          AND lease_expires_at > statement_timestamp()
        RETURNING ${AUTHORITATIVE_CLAIM_PROJECTION}`, [
        input.artifact.intentId, input.claim.leaseOwner, input.claim.leaseToken,
        input.claim.intent.stateRevision.toString(),
      ]);
      if (transitioned.rowCount !== 1) throw failure('LEASE_LOST');
      await insertIntentTransitions(client, input, nowMs);
      await insertSubmissionEvent(client, input.artifact, nowMs);
      return persistedResult(input.artifact, transitionedClaim(
        input.claim, transitioned, 'SIGNED_NOT_SUBMITTED', 2n, 'SIGNATURE_PERSISTED',
      ));
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

  public async inspectSignedTransaction(input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly artifactId?: string;
  }>): Promise<ExecutionLiveSignedTransactionInspectionV1 | null> {
    const claim = claimFrom(input.claim);
    if (input.artifactId !== undefined && !ARTIFACT_ID.test(input.artifactId)) {
      throw failure('INVALID_INPUT');
    }
    return this.transaction(async (client) => {
      const row = input.artifactId === undefined
        ? await findArtifactForClaim(client, claim.intent.id, claim.intent.attemptCount)
        : await findArtifact(client, input.artifactId, false);
      if (row === null) return null;
      if (row.intent_id !== claim.intent.id
        || integer(row.attempt_number) !== claim.intent.attemptCount) throw failure('CONFLICT');
      const state = inspectableSignedState(row.state);
      const stateRevision = unsignedBigint(row.state_revision);
      const artifact = artifactFromRow(row);
      if (input.artifactId !== undefined && artifact.artifactId !== input.artifactId) {
        throw failure('INVALID_DATA');
      }
      if (state !== 'REVOKED_NO_SEND') {
        if (row.lease_owner !== claim.leaseOwner || row.lease_token !== claim.leaseToken
          || timestampText(row.lease_expires_at_ms) <= timestampText(row.now_ms)
          || !inspectionIntentStatusMatches(state, row.intent_status)) {
          throw failure('LEASE_LOST');
        }
      }
      if (state === 'PERSISTED' || state === 'SIGNED_SIMULATED') {
        const unsignedSimulation = await loadUnsignedSimulationEvidence(client, artifact);
        return Object.freeze({
          payloadVersion: 1, artifact, unsignedSimulation, state, stateRevision,
          claim: inspectionClaim(claim, row, state),
        });
      }
      if (state === 'REVOKED_NO_SEND') {
        return Object.freeze({
          payloadVersion: 1,
          artifactId: artifact.artifactId,
          signature: artifact.signature,
          signedTransactionHash: artifact.signedTransactionHash,
          state,
          stateRevision,
          claim: null,
        });
      }
      return Object.freeze({
        payloadVersion: 1,
        artifactId: artifact.artifactId,
        signature: artifact.signature,
        signedTransactionHash: artifact.signedTransactionHash,
        state,
        stateRevision,
        claim: inspectionClaim(claim, row, state),
      });
    });
  }

  public async recordSignedSimulation(
    claimValue: ClaimedExecutionIntent,
    evidence: ExecutionLiveSignedSimulationEvidenceV1,
  ): Promise<AuthenticatedPersistedSignedTransactionV1> {
    const claim = claimFrom(claimValue);
    try { assertExecutionLiveSignedSimulationEvidence(evidence); } catch {
      throw failure('INVALID_INPUT');
    }
    return this.transaction(async (client) => {
      const identity = await artifactIdentity(client, evidence.artifactId);
      await lockGeneration(client, identity.generationId);
      const row = await findArtifact(client, evidence.artifactId, true);
      if (row?.intent_id !== claim.intent.id
        || row.lease_owner !== claim.leaseOwner || row.lease_token !== claim.leaseToken
        || timestampText(row.lease_expires_at_ms) <= timestampText(row.now_ms)) {
        throw failure('LEASE_LOST');
      }
      const artifact = artifactFromRow(row);
      if (row.state === 'SIGNED_SIMULATED' && unsignedBigint(row.state_revision) === 1n) {
        if (!await exactSignedSimulationReplay(client, evidence)) throw failure('CONFLICT');
        return Object.freeze({
          payloadVersion: 1, artifact, state: 'SIGNED_SIMULATED', stateRevision: 1n,
        });
      }
      if (row.state !== 'PERSISTED' || unsignedBigint(row.state_revision) !== 0n
        || row.signed_transaction_hash !== evidence.signedTransactionHash) {
        throw failure('CONFLICT');
      }
      await validateSignedSimulationBinding(client, artifact, evidence);
      await insertSignedSimulationEvidence(client, evidence);
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

  public async revokeBeforeSubmission(
    inputValue: ExecutionPreSubmissionRevocationInputV1,
  ): Promise<ExecutionPreSubmissionRevocationResultV1> {
    const input = revocationInputFrom(inputValue);
    return this.transaction(async (client) => {
      const identity = await artifactIdentity(client, input.artifactId);
      await lockGeneration(client, identity.generationId);
      const row = await findArtifact(client, input.artifactId, true);
      if (row?.intent_id !== input.claim.intent.id) throw failure('CONFLICT');
      if (row.state === 'REVOKED_NO_SEND') {
        if (!await exactRevocationReplay(client, input)) throw failure('CONFLICT');
        return Object.freeze({
          payloadVersion: 1, kind: 'REPLAYED', artifactState: 'REVOKED_NO_SEND',
        });
      }
      if (row.state !== input.expectedState
        || unsignedBigint(row.state_revision) !== input.expectedRevision) {
        throw failure('CONFLICT');
      }
      if (row.intent_status !== 'SIGNED_NOT_SUBMITTED'
        || row.lease_owner !== input.claim.leaseOwner
        || row.lease_token !== input.claim.leaseToken
        || timestampText(row.lease_expires_at_ms) <= timestampText(row.now_ms)) {
        throw failure('LEASE_LOST');
      }
      const artifact = artifactFromRow(row);
      const revokedAtMs = Math.max(timestampText(row.now_ms), input.observedAtMs);
      const proof = revocationProof(artifact, input, revokedAtMs);
      await insertRevocationProof(client, artifact, input, proof);
      await insertLiveStateEvent(
        client, artifact, input.expectedState, 'REVOKED_NO_SEND',
        'PRE_SUBMISSION_REVOKED_NO_SEND', revokedAtMs,
      );
      if (artifact.side === 'BUY') {
        await revokeBuyBeforeSubmission(client, artifact, input, proof.revokedAtMs);
      } else {
        await revokeSellBeforeSubmission(client, artifact, input, proof.revokedAtMs);
      }
      const artifactUpdate = await client.query(`UPDATE execution_signed_transactions SET
        state='REVOKED_NO_SEND',state_revision=$2::BIGINT,
        revoked_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
        purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond')
        WHERE artifact_id=$1 AND state=$4 AND state_revision=$5::BIGINT`, [
        artifact.artifactId, (input.expectedRevision + 1n).toString(), proof.revokedAtMs,
        input.expectedState, input.expectedRevision.toString(),
      ]);
      if (artifactUpdate.rowCount !== 1) throw failure('CONFLICT');
      return Object.freeze({
        payloadVersion: 1, kind: 'REVOKED', artifactState: 'REVOKED_NO_SEND',
      });
    });
  }

  public async beginSubmission(input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly artifactId: string;
    readonly expectedRevision: bigint;
    readonly runtime: ExecutionLiveRuntimeBindingV1;
    readonly blockhashValidity: ExecutionBlockhashValidityEvidenceV1;
  }>): Promise<AuthenticatedSubmissionStartedTransactionV1> {
    const claim = claimFrom(input.claim);
    if (!ARTIFACT_ID.test(input.artifactId) || input.expectedRevision !== 1n
      || !validRuntimeBinding(input.runtime)
      || !validBlockhashEvidence(input.blockhashValidity)) throw failure('INVALID_INPUT');
    return this.transaction(async (client) => {
      const identity = await artifactIdentity(client, input.artifactId);
      await lockGeneration(client, identity.generationId);
      const current = await findArtifact(client, input.artifactId, true);
      if (current === null || typeof current.provider_id !== 'string') throw failure('CONFLICT');
      await lockProvider(client, current.provider_id);
      if (current.side === 'SELL') {
        return beginSellSubmission(client, claim, input, current);
      }
      const gate = singleRow(await client.query(`SELECT
        transaction.*,intent.status AS intent_status,intent.lease_owner,
        intent.lease_token::TEXT AS lease_token,
        trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT AS lease_expires_at_ms,
        trunc(EXTRACT(EPOCH FROM intent.expires_at)*1000)::TEXT AS intent_expires_at_ms,
        intent.side AS intent_side,intent.mint AS intent_mint,
        intent.quote_mint AS intent_quote_mint,
        intent.quote_amount_raw::TEXT AS intent_quote_amount_raw,
        intent.logical_order_key AS intent_logical_order_key,
        intent.decision_fingerprint AS intent_decision_fingerprint,
        attempt.status AS attempt_status,
        trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms,
        trunc(EXTRACT(EPOCH FROM transaction.signed_at)*1000)::TEXT AS signed_at_ms,
        trunc(EXTRACT(EPOCH FROM transaction.quote_observed_at)*1000)::TEXT
          AS quote_observed_at_ms,
        trunc(EXTRACT(EPOCH FROM transaction.quote_expires_at)*1000)::TEXT
          AS quote_expires_at_ms,
        generation.wallet_public_key AS generation_wallet_public_key,
        generation.cluster AS generation_cluster,generation.genesis_hash AS generation_genesis_hash,
        generation.retired_at AS generation_retired_at,
        control.state AS control_state,armament.state AS armament_state,
        armament.state_revision::TEXT AS armament_revision,
        armament.armament_fingerprint,armament.qualification_id AS armament_qualification_id,
        armament.qualification_fingerprint AS armament_qualification_fingerprint,
        armament.generation_id AS armament_generation_id,armament.phase AS armament_phase,
        armament.build_hash AS armament_build_hash,
        armament.configuration_fingerprint AS armament_configuration_fingerprint,
        armament.strategy_fingerprint AS armament_strategy_fingerprint,
        armament.wallet_public_key AS armament_wallet_public_key,
        armament.cluster AS armament_cluster,armament.genesis_hash AS armament_genesis_hash,
        armament.provider_id AS armament_provider_id,
        armament.maximum_capital_lamports::TEXT AS maximum_capital_lamports,
        armament.maximum_exposure_bps::TEXT AS maximum_exposure_bps,
        armament.maximum_open_positions,armament.maximum_buys,armament.consumed_buys,
        trunc(EXTRACT(EPOCH FROM armament.expires_at)*1000)::TEXT AS armament_expires_at_ms,
        qualification.qualification_id,qualification.qualification_fingerprint,
        qualification.generation_id AS qualification_generation_id,
        qualification.phase AS qualification_phase,
        qualification.build_hash AS qualification_build_hash,
        qualification.configuration_fingerprint AS qualification_configuration_fingerprint,
        qualification.strategy_fingerprint AS qualification_strategy_fingerprint,
        qualification.wallet_public_key AS qualification_wallet_public_key,
        qualification.cluster AS qualification_cluster,
        qualification.genesis_hash AS qualification_genesis_hash,
        qualification.provider_id AS qualification_provider_id,
        trunc(EXTRACT(EPOCH FROM qualification.expires_at)*1000)::TEXT
          AS qualification_expires_at_ms,
        reservation.state AS reservation_state,
        reservation.reservation_id,reservation.intent_id AS reservation_intent_id,
        reservation.generation_id AS reservation_generation_id,
        reservation.side AS reservation_side,reservation.mint AS reservation_mint,
        reservation.quote_mint AS reservation_quote_mint,
        reservation.maximum_amount_raw::TEXT AS reservation_amount_raw,
        reservation.intent_fingerprint AS reservation_intent_fingerprint,
        reservation.policy_fingerprint AS reservation_policy_fingerprint,
        reservation.wallet_snapshot_fingerprint,
        reservation.provider_snapshot_fingerprint,reservation.admission_report_id,
        admission.decision AS admission_decision,
        admission.intent_id AS admission_intent_id,
        admission.generation_id AS admission_generation_id,
        admission.policy_fingerprint AS admission_policy_fingerprint,
        admission.wallet_snapshot_fingerprint AS admission_wallet_snapshot_fingerprint,
        admission.provider_snapshot_fingerprint AS admission_provider_snapshot_fingerprint,
        admission.quote_amount_raw::TEXT AS admission_quote_amount_raw,
        admission.quota_state AS admission_quota_state,
        admission.risk_state_revision_baseline::TEXT AS admission_risk_revision,
        admission.conservative_drawdown_raw_baseline::TEXT AS admission_drawdown_raw,
        admission.provider_local_usage_units_baseline::TEXT
          AS admission_provider_local_usage_units,
        admission.provider_rate_limit_count_baseline::TEXT
          AS admission_provider_rate_limit_count,
        risk.state_revision::TEXT AS risk_revision,
        risk.reconciled_capital_lamports::TEXT AS reconciled_capital_raw,
        risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,
        risk.conservative_drawdown_raw::TEXT AS conservative_drawdown_raw,
        risk.open_positions,risk.unknown_block,
        EXISTS (SELECT 1 FROM execution_exposure_reservations held
          WHERE held.generation_id=transaction.generation_id
            AND held.state='UNKNOWN_HELD') AS unknown_reservation_held,
        provider.provider_id AS snapshot_provider_id,
        (SELECT COALESCE(SUM(usage.units),0)::TEXT
          FROM execution_provider_usage_counters usage
          WHERE usage.provider_id=provider.provider_id
            AND usage.billing_period_id=provider.billing_period_id
            AND usage.recorded_at >= provider.measured_at)
          AS provider_local_usage_units,
        (SELECT COUNT(*)::TEXT FROM execution_provider_rate_limit_events rate_limit
          WHERE rate_limit.provider_id=provider.provider_id
            AND rate_limit.billing_period_id=provider.billing_period_id)
          AS provider_rate_limit_count,
        provider.superseded_at AS provider_superseded_at,
        trunc(EXTRACT(EPOCH FROM provider.expires_at)*1000)::TEXT AS provider_expires_at_ms
        FROM execution_signed_transactions transaction
        JOIN execution_intents intent ON intent.id=transaction.intent_id
        JOIN execution_attempts attempt ON attempt.intent_id=transaction.intent_id
          AND attempt.attempt_number=transaction.attempt_number
        JOIN execution_wallet_generations generation
          ON generation.generation_id=transaction.generation_id
        JOIN execution_control_state control ON control.generation_id=transaction.generation_id
        JOIN execution_activation_armaments armament ON armament.armament_id=transaction.armament_id
        JOIN execution_safety_qualifications qualification
          ON qualification.qualification_id=armament.qualification_id
        JOIN execution_exposure_reservations reservation
          ON reservation.reservation_id=transaction.reservation_id
        JOIN execution_wallet_risk_state risk ON risk.generation_id=transaction.generation_id
        JOIN execution_risk_admission_reports admission
          ON admission.report_id=reservation.admission_report_id
        JOIN execution_provider_usage_snapshots provider
          ON provider.snapshot_fingerprint=reservation.provider_snapshot_fingerprint
          AND provider.provider_id=transaction.provider_id
        WHERE transaction.artifact_id=$1
        FOR UPDATE OF transaction,intent,armament,reservation,risk`, [
        input.artifactId,
      ]));
      validateBuySubmissionGate(gate, claim, input);
      const nowMs = timestampText(gate.now_ms);
      const artifact = artifactFromRow(gate);
      await insertSubmissionPreflightEvidence(client, artifact, gate, input, nowMs);
      const updated = await client.query(`UPDATE execution_signed_transactions SET
        state='SUBMISSION_STARTED',state_revision=$2::BIGINT,
        submission_started_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')
        WHERE artifact_id=$1 AND state='SIGNED_SIMULATED' AND state_revision=$4::BIGINT`, [
        input.artifactId, (input.expectedRevision + 1n).toString(), nowMs,
        input.expectedRevision.toString(),
      ]);
      if (updated.rowCount !== 1) throw failure('CONFLICT');
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
  ): Promise<ExecutionLiveSubmissionOutcomeResultV1> {
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
      const activeClaim = currentClaim(
        claim, row, 'SIGNED_NOT_SUBMITTED', 'SIGNATURE_PERSISTED',
      );
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
          AND lease_token=$5::UUID
        RETURNING ${AUTHORITATIVE_CLAIM_PROJECTION}`, [
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
        const held = artifact.side === 'BUY'
          ? await client.query(`UPDATE execution_exposure_reservations SET
              state='UNKNOWN_HELD',state_revision=state_revision+1
              WHERE intent_id=$1 AND state='RESERVED'`, [artifact.intentId])
          : null;
        const blocked = await client.query(`UPDATE execution_wallet_risk_state SET
          unknown_block=TRUE,state_revision=state_revision+1
          WHERE generation_id=$1 AND unknown_block=FALSE`, [artifact.generationId]);
        if ((held !== null && held.rowCount !== 1)
          || (blocked.rowCount !== 0 && blocked.rowCount !== 1)) {
          throw failure('CONFLICT');
        }
      }
      return Object.freeze({
        payloadVersion: 1,
        artifact,
        claim: transitionedClaim(activeClaim, intent, nextIntent, 1n, intentReason),
      });
    });
  }

  public async readConfirmationWork(
    claimValue: ClaimedExecutionIntent,
  ): Promise<ExecutionLiveConfirmationWorkV1> {
    const claim = claimFrom(claimValue);
    if (claim.intent.status !== 'SUBMITTED' || claim.intent.attemptCount < 1) {
      throw failure('INVALID_INPUT');
    }
    return this.transaction(async (client) => {
      const generationId = await workerGenerationId(client, claim);
      await lockGeneration(client, generationId);
      const row = exactRow(singleRow(await client.query(`SELECT
        /* execution_live_confirmation_work */
        intent.id AS intent_id,intent.status AS intent_status,
        intent.state_revision::TEXT AS intent_revision,intent.attempt_count,
        intent.lease_owner,intent.lease_token::TEXT AS lease_token,
        trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT
          AS lease_expires_at_ms,
        attempt.intent_id AS attempt_intent_id,attempt.attempt_number,
        attempt.status AS attempt_status,attempt.provider_id AS attempt_provider_id,
        attempt.reconciliation_signature,
        transaction.artifact_id,transaction.intent_id AS artifact_intent_id,
        transaction.attempt_number AS artifact_attempt_number,
        transaction.generation_id,transaction.provider_id AS artifact_provider_id,
        transaction.reservation_id AS artifact_reservation_id,
        transaction.message_hash AS artifact_message_hash,
        trunc(EXTRACT(EPOCH FROM transaction.quote_observed_at)*1000)::TEXT
          AS artifact_quote_observed_at_ms,
        trunc(EXTRACT(EPOCH FROM transaction.quote_expires_at)*1000)::TEXT
          AS artifact_quote_expires_at_ms,
        transaction.signature AS artifact_signature,transaction.state AS artifact_state,
        transaction.state_revision::TEXT AS artifact_revision
        FROM execution_intents intent
        JOIN execution_attempts attempt ON attempt.intent_id=intent.id
          AND attempt.attempt_number=intent.attempt_count
        JOIN execution_signed_transactions transaction ON transaction.intent_id=attempt.intent_id
          AND transaction.attempt_number=attempt.attempt_number
        WHERE intent.id=$1
        FOR UPDATE OF intent,attempt,transaction`, [claim.intent.id])), [
        'intent_id', 'intent_status', 'intent_revision', 'attempt_count', 'lease_owner',
        'lease_token', 'lease_expires_at_ms', 'attempt_intent_id', 'attempt_number',
        'attempt_status', 'attempt_provider_id', 'reconciliation_signature', 'artifact_id',
        'artifact_intent_id', 'artifact_attempt_number', 'generation_id',
        'artifact_provider_id', 'artifact_reservation_id', 'artifact_message_hash',
        'artifact_quote_observed_at_ms', 'artifact_quote_expires_at_ms',
        'artifact_signature', 'artifact_state', 'artifact_revision',
      ] as const);
      const nowMs = await freshDatabaseNow(client);
      assertWorkerClaim(row, claim, nowMs);
      const attemptNumber = integer(row.attempt_number);
      const providerId = providerIdentifier(row.artifact_provider_id);
      const signature = reconciliationSignature(row.artifact_signature);
      const artifactId = text(row.artifact_id);
      assertCausalArtifactId(row, artifactId, claim.intent.id, attemptNumber, generationId, signature);
      if (!ARTIFACT_ID.test(artifactId)
        || row.attempt_intent_id !== claim.intent.id
        || row.artifact_intent_id !== claim.intent.id
        || attemptNumber !== claim.intent.attemptCount
        || integer(row.artifact_attempt_number) !== attemptNumber
        || row.generation_id !== generationId
        || row.attempt_status !== 'STARTED'
        || row.artifact_state !== 'ACCEPTED'
        || row.attempt_provider_id !== providerId
        || row.reconciliation_signature !== signature) throw failure('INVALID_DATA');
      return Object.freeze({
        payloadVersion: 1,
        artifactId,
        expectedRevision: unsignedBigint(row.artifact_revision),
        signature,
        providerId,
      });
    });
  }

  public async readReconciliationWork(
    claimValue: ClaimedExecutionIntent,
  ): Promise<ExecutionLiveReconciliationWorkV1> {
    const claim = claimFrom(claimValue);
    if (!['CONFIRMED', 'RECONCILING', 'UNKNOWN_REQUIRES_RECONCILIATION']
      .includes(claim.intent.status) || claim.intent.attemptCount < 1) {
      throw failure('INVALID_INPUT');
    }
    return this.transaction(async (client) => {
      const generationId = await workerGenerationId(client, claim);
      await lockGeneration(client, generationId);
      const row = exactRow(singleRow(await client.query(`SELECT
        /* execution_live_reconciliation_work */
        intent.id AS intent_id,intent.status AS intent_status,
        intent.state_revision::TEXT AS intent_revision,intent.attempt_count,
        intent.lease_owner,intent.lease_token::TEXT AS lease_token,
        trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT
          AS lease_expires_at_ms,
        intent.mint,intent.quote_mint,intent.side AS intent_side,
        attempt.intent_id AS attempt_intent_id,attempt.attempt_number,
        attempt.status AS attempt_status,attempt.effective_venue AS attempt_effective_venue,
        attempt.provider_id AS attempt_provider_id,attempt.reconciliation_signature,
        attempt.reconciliation_blockhash,
        attempt.reconciliation_last_valid_block_height::TEXT
          AS reconciliation_last_valid_block_height,
        attempt.reconciliation_message_hash,attempt.reconciliation_build_fingerprint,
        attempt.reconciliation_snapshot_fingerprint,
        attempt.reconciliation_maximum_fee_lamports::TEXT
          AS reconciliation_maximum_fee_lamports,
        attempt.reconciliation_maximum_fee_payer_lamport_debit::TEXT
          AS reconciliation_maximum_fee_payer_lamport_debit,
        transaction.artifact_id,transaction.intent_id AS artifact_intent_id,
        transaction.attempt_number AS artifact_attempt_number,
        transaction.generation_id AS artifact_generation_id,
        transaction.provider_id AS artifact_provider_id,
        transaction.reservation_id AS artifact_reservation_id,
        transaction.wallet_public_key AS artifact_wallet_public_key,
        transaction.side AS artifact_side,
        transaction.effective_venue AS artifact_effective_venue,
        transaction.signature AS artifact_signature,
        transaction.blockhash AS artifact_blockhash,
        transaction.last_valid_block_height::TEXT AS artifact_last_valid_block_height,
        transaction.message_hash AS artifact_message_hash,
        transaction.build_fingerprint AS artifact_build_fingerprint,
        transaction.snapshot_fingerprint AS artifact_snapshot_fingerprint,
        trunc(EXTRACT(EPOCH FROM transaction.quote_observed_at)*1000)::TEXT
          AS artifact_quote_observed_at_ms,
        trunc(EXTRACT(EPOCH FROM transaction.quote_expires_at)*1000)::TEXT
          AS artifact_quote_expires_at_ms,
        transaction.state AS artifact_state,
        transaction.state_revision::TEXT AS artifact_revision,
        generation.generation_id,generation.payload_version AS generation_payload_version,
        generation.wallet_public_key AS generation_wallet_public_key,
        generation.generation
        FROM execution_intents intent
        JOIN execution_attempts attempt ON attempt.intent_id=intent.id
          AND attempt.attempt_number=intent.attempt_count
        JOIN execution_signed_transactions transaction ON transaction.intent_id=attempt.intent_id
          AND transaction.attempt_number=attempt.attempt_number
        JOIN execution_wallet_generations generation
          ON generation.generation_id=transaction.generation_id
        WHERE intent.id=$1
        FOR UPDATE OF intent,attempt,transaction`, [claim.intent.id])), [
        'intent_id', 'intent_status', 'intent_revision', 'attempt_count', 'lease_owner',
        'lease_token', 'lease_expires_at_ms', 'mint', 'quote_mint', 'intent_side',
        'attempt_intent_id', 'attempt_number', 'attempt_status', 'attempt_effective_venue',
        'attempt_provider_id', 'reconciliation_signature', 'reconciliation_blockhash',
        'reconciliation_last_valid_block_height', 'reconciliation_message_hash',
        'reconciliation_build_fingerprint', 'reconciliation_snapshot_fingerprint',
        'reconciliation_maximum_fee_lamports',
        'reconciliation_maximum_fee_payer_lamport_debit', 'artifact_id',
        'artifact_intent_id', 'artifact_attempt_number', 'artifact_generation_id',
        'artifact_provider_id', 'artifact_reservation_id', 'artifact_wallet_public_key', 'artifact_side',
        'artifact_effective_venue', 'artifact_signature', 'artifact_blockhash',
        'artifact_last_valid_block_height', 'artifact_message_hash',
        'artifact_build_fingerprint', 'artifact_snapshot_fingerprint',
        'artifact_quote_observed_at_ms', 'artifact_quote_expires_at_ms', 'artifact_state',
        'artifact_revision', 'generation_id', 'generation_payload_version',
        'generation_wallet_public_key', 'generation',
      ] as const);
      const nowMs = await freshDatabaseNow(client);
      assertWorkerClaim(row, claim, nowMs);
      const attemptNumber = integer(row.attempt_number);
      const providerId = providerIdentifier(row.artifact_provider_id);
      const side = executionSide(row.intent_side);
      const signature = reconciliationSignature(row.artifact_signature);
      const blockhash = solanaAddress(row.artifact_blockhash);
      const walletPublicKey = solanaAddress(row.generation_wallet_public_key);
      const mint = solanaAddress(row.mint);
      const quoteMint = solanaAddress(row.quote_mint);
      const expected = Object.freeze({
        intentId: text(row.intent_id),
        attemptNumber,
        walletGeneration: positiveInteger(row.generation),
        providerId,
        side,
        signature,
        blockhash,
        lastValidBlockHeight: unsignedBigint(row.artifact_last_valid_block_height),
        messageHash: fingerprintText(row.artifact_message_hash),
        buildFingerprint: fingerprintText(row.artifact_build_fingerprint),
        snapshotFingerprint: fingerprintText(row.artifact_snapshot_fingerprint),
        maximumFeeLamports: unsignedBigint(row.reconciliation_maximum_fee_lamports),
        maximumFeePayerLamportDebit:
          unsignedBigint(row.reconciliation_maximum_fee_payer_lamport_debit),
      });
      assertReconciliationExpected(expected);
      const artifactId = text(row.artifact_id);
      const effectiveVenue = executionVenue(row.artifact_effective_venue);
      assertCausalArtifactId(row, artifactId, claim.intent.id, attemptNumber, generationId, signature);
      if (!ARTIFACT_ID.test(artifactId)
        || row.attempt_intent_id !== claim.intent.id
        || row.artifact_intent_id !== claim.intent.id
        || attemptNumber !== claim.intent.attemptCount
        || integer(row.artifact_attempt_number) !== attemptNumber
        || row.artifact_generation_id !== generationId || row.generation_id !== generationId
        || integer(row.generation_payload_version) !== 1
        || row.artifact_wallet_public_key !== walletPublicKey
        || row.artifact_side !== side
        || row.attempt_effective_venue !== effectiveVenue
        || row.attempt_provider_id !== providerId
        || row.reconciliation_signature !== signature
        || row.reconciliation_blockhash !== blockhash
        || row.reconciliation_last_valid_block_height
          !== expected.lastValidBlockHeight.toString()
        || row.reconciliation_message_hash !== expected.messageHash
        || row.reconciliation_build_fingerprint !== expected.buildFingerprint
        || row.reconciliation_snapshot_fingerprint !== expected.snapshotFingerprint
        || row.attempt_status !== 'STARTED'
        || !reconciliationStatePair(claim.intent.status, row.artifact_state)) {
        throw failure('INVALID_DATA');
      }
      unsignedBigint(row.artifact_revision);
      const request = Object.freeze({
        payloadVersion: 1 as const,
        expected,
        walletDeltaRequest: Object.freeze({
          signature,
          walletPublicKey,
          mint,
          quoteMint,
          side,
        }),
      });
      return Object.freeze({ payloadVersion: 1, providerId, request });
    });
  }

  public async recordConfirmation(
    claimValue: ClaimedExecutionIntent,
    confirmation: ExecutionLiveConfirmationV1,
  ): Promise<ExecutionLiveArtifactReferenceV1> {
    const claim = claimFrom(claimValue);
    validateConfirmation(confirmation);
    return this.transaction(async (client) => {
      const identity = await artifactIdentity(client, confirmation.artifactId);
      await lockGeneration(client, identity.generationId);
      const row = await findArtifactReference(client, confirmation.artifactId, true);
      const previousState = row?.state;
      const previousStatus = row?.intent_status;
      if (row?.intent_id === claim.intent.id && previousState === 'CONFIRMED'
        && previousStatus === 'CONFIRMED'
        && unsignedBigint(row.state_revision) === confirmation.expectedRevision + 1n
        && row.signature === confirmation.signature
        && unsignedBigint(row.confirmed_slot) === confirmation.observedSlot
        && timestampText(row.confirmed_at_ms) === confirmation.observedAtMs
        && ((row.lease_owner === null && row.lease_token === null
          && row.lease_expires_at_ms === null)
          || (row.lease_owner === claim.leaseOwner && row.lease_token === claim.leaseToken))) {
        return artifactReferenceFromRow(row);
      }
      const databaseNowMs = await freshDatabaseNow(client);
      if (row?.intent_id !== claim.intent.id
        || (previousState !== 'ACCEPTED' && previousState !== 'AMBIGUOUS')
        || (previousStatus !== 'SUBMITTED'
          && previousStatus !== 'UNKNOWN_REQUIRES_RECONCILIATION')
        || unsignedBigint(row.state_revision) !== confirmation.expectedRevision
        || row.signature !== confirmation.signature
        || row.lease_owner !== claim.leaseOwner || row.lease_token !== claim.leaseToken
        || row.lease_expires_at_ms === null
        || timestampText(row.lease_expires_at_ms) <= databaseNowMs) {
        throw failure('LEASE_LOST');
      }
      const artifact = artifactReferenceFromRow(row);
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
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        updated_at=date_trunc('milliseconds',statement_timestamp())
        WHERE id=$1 AND status=$2 AND lease_owner=$3 AND lease_token=$4::UUID
          AND lease_expires_at > statement_timestamp()`, [
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
      return this.transaction(async (client) => {
        await lockLiveSellPresenceInTransaction(client);
        return commitSellReconciliation(client, claim, evidence);
      });
    }
    const liveResults: Awaited<ReturnType<typeof applyLiveReconciliation>>[] = [];
    try {
      const committed = await new PostgresExecutionRiskRepository(this.#source)
        .reconcileWithHook(Object.freeze({ payloadVersion: 1, evidence }),
          async (client, exactEvidence, context): Promise<void> => {
            liveResults.push(await applyLiveReconciliation(
              client, claim, exactEvidence, context.isReplay,
            ));
          }, Object.freeze({ leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken }));
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
          ? 'COMMIT_OUTCOME_UNKNOWN'
          : error.code === 'LEASE_LOST'
            ? 'LEASE_LOST'
            : error.code === 'CONFLICT' ? 'CONFLICT' : 'DATABASE_FAILURE');
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
      await lockLiveSellPresenceInTransaction(client);
      const generationId = await deadlinePositionGeneration(client, input.positionId);
      await lockGeneration(client, generationId);
      return createDeadlineExitIntentLocked(client, { ...input, generationId });
    });
  }

  public async createNextDeadlineExitIntent(): Promise<ExecutionDeadlineExitResultV1 | null> {
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(
        hashtextextended('execution-live-deadline-scan:v1', 51007))`);
      await lockLiveSellPresenceInTransaction(client);
      const clock = exactRow(singleRow(await client.query(`SELECT
        /* execution_live_deadline_clock */
        trunc(EXTRACT(EPOCH FROM date_trunc('milliseconds',statement_timestamp()))*1000)::TEXT
          AS deadline_clock_ms`)), ['deadline_clock_ms'] as const);
      const observedAtMs = timestampText(clock.deadline_clock_ms);
      const candidates = await client.query(`SELECT position.position_id,position.generation_id
        FROM execution_live_positions position
        WHERE position.state='OPEN'
          AND position.exit_deadline_at <= TIMESTAMPTZ 'epoch'
            +($1::BIGINT*INTERVAL '1 millisecond')
        ORDER BY position.exit_deadline_at ASC,position.position_id ASC LIMIT 1`, [
        observedAtMs,
      ]);
      if (candidates.rows.length === 0) return null;
      const candidate = exactRow(singleRow(candidates), ['position_id', 'generation_id'] as const);
      const positionId = text(candidate.position_id);
      const generationId = text(candidate.generation_id);
      if (!/^execution_live_position_[0-9a-f]{64}$/u.test(positionId)
        || !/^execution_wallet_generation_[0-9a-f]{64}$/u.test(generationId)) {
        throw failure('INVALID_DATA');
      }
      await lockGeneration(client, generationId);
      const result = await createDeadlineExitIntentLocked(client, {
        positionId, observedAtMs, generationId,
      });
      if (result.kind === 'NOT_DUE') throw failure('CONFLICT');
      return result;
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
      || artifact.reservationId !== input.reservationId
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

function persistedResult(
  artifact: SignedTransactionArtifactV1,
  claim: ClaimedExecutionIntent,
): ExecutionLivePersistSignedResultV1 {
  return Object.freeze({ payloadVersion: 1, artifact, claim });
}

function transitionedClaim(
  previous: ClaimedExecutionIntent,
  result: QueryResult,
  expectedStatus: ExecutionIntentV1['status'],
  revisionDelta: bigint,
  expectedReason: NonNullable<ExecutionIntentV1['lastReasonCode']>,
): ClaimedExecutionIntent {
  if (result.rowCount !== 1 || result.rows.length !== 1) throw failure('INVALID_DATA');
  return authoritativeClaim(
    previous, singleRow(result), expectedStatus, revisionDelta, expectedReason,
  );
}

function replayedPersistClaim(
  previous: ClaimedExecutionIntent,
  row: Row,
): ClaimedExecutionIntent {
  if (row.claim_lease_owner !== previous.leaseOwner
    || row.claim_lease_token !== previous.leaseToken) throw failure('LEASE_LOST');
  if (row.state === 'PERSISTED' || row.state === 'SIGNED_SIMULATED'
    || row.state === 'SUBMISSION_STARTED') {
    return authoritativeClaim(
      previous, row, 'SIGNED_NOT_SUBMITTED', 2n, 'SIGNATURE_PERSISTED',
    );
  }
  if (row.state === 'ACCEPTED') {
    return authoritativeClaim(previous, row, 'SUBMITTED', 3n, 'SUBMISSION_ACCEPTED');
  }
  if (row.state === 'AMBIGUOUS') {
    return authoritativeClaim(
      previous, row, 'UNKNOWN_REQUIRES_RECONCILIATION', 3n,
      'RECONCILIATION_REQUIRED',
    );
  }
  throw failure('CONFLICT');
}

function authoritativeClaim(
  previous: ClaimedExecutionIntent,
  row: Row,
  expectedStatus: ExecutionIntentV1['status'],
  revisionDelta: bigint,
  expectedReason: NonNullable<ExecutionIntentV1['lastReasonCode']>,
): ClaimedExecutionIntent {
  const stateRevision = unsignedBigint(row.claim_state_revision);
  const attemptCount = integer(row.claim_attempt_count);
  const updatedAtMs = timestampText(row.claim_updated_at_ms);
  const leaseExpiresAtMs = timestampText(row.claim_lease_expires_at_ms);
  if (row.claim_status !== expectedStatus
    || stateRevision !== previous.intent.stateRevision + revisionDelta
    || attemptCount !== previous.intent.attemptCount
    || row.claim_last_reason_code !== expectedReason
    || updatedAtMs < previous.intent.updatedAtMs
    || row.claim_lease_owner !== previous.leaseOwner
    || row.claim_lease_token !== previous.leaseToken) throw failure('INVALID_DATA');
  return claimFrom(Object.freeze({
    intent: Object.freeze({
      ...previous.intent,
      status: expectedStatus,
      stateRevision,
      lastReasonCode: expectedReason,
      updatedAtMs,
    }),
    leaseOwner: previous.leaseOwner,
    leaseToken: previous.leaseToken,
    leaseExpiresAtMs,
  }));
}

function currentClaim(
  previous: ClaimedExecutionIntent,
  row: Row,
  expectedStatus: ExecutionIntentV1['status'],
  expectedReason: NonNullable<ExecutionIntentV1['lastReasonCode']>,
): ClaimedExecutionIntent {
  const stateRevision = unsignedBigint(row.claim_state_revision);
  const attemptCount = integer(row.claim_attempt_count);
  const updatedAtMs = timestampText(row.claim_updated_at_ms);
  const leaseExpiresAtMs = timestampText(row.claim_lease_expires_at_ms);
  if (row.claim_status !== expectedStatus
    || stateRevision < previous.intent.stateRevision
    || attemptCount !== previous.intent.attemptCount
    || row.claim_last_reason_code !== expectedReason
    || updatedAtMs < previous.intent.updatedAtMs
    || row.claim_lease_owner !== previous.leaseOwner
    || row.claim_lease_token !== previous.leaseToken) throw failure('INVALID_DATA');
  return claimFrom(Object.freeze({
    intent: Object.freeze({
      ...previous.intent,
      status: expectedStatus,
      stateRevision,
      lastReasonCode: expectedReason,
      updatedAtMs,
    }),
    leaseOwner: previous.leaseOwner,
    leaseToken: previous.leaseToken,
    leaseExpiresAtMs,
  }));
}

function inspectionClaim(
  previous: ClaimedExecutionIntent,
  row: Row,
  state: Exclude<ExecutionLiveSignedTransactionInspectionV1['state'], 'REVOKED_NO_SEND'>,
): ClaimedExecutionIntent {
  if (state === 'PERSISTED' || state === 'SIGNED_SIMULATED'
    || state === 'SUBMISSION_STARTED') {
    return currentClaim(previous, row, 'SIGNED_NOT_SUBMITTED', 'SIGNATURE_PERSISTED');
  }
  if (state === 'ACCEPTED') {
    return currentClaim(previous, row, 'SUBMITTED', 'SUBMISSION_ACCEPTED');
  }
  return currentClaim(
    previous, row, 'UNKNOWN_REQUIRES_RECONCILIATION', 'RECONCILIATION_REQUIRED',
  );
}

function revocationInputFrom(
  input: ExecutionPreSubmissionRevocationInputV1,
): ExecutionPreSubmissionRevocationInputV1 {
  const claim = claimFrom(input.claim);
  const payloadVersion: unknown = input.payloadVersion;
  const expectedState: unknown = input.expectedState;
  const causeReasonCode: unknown = input.causeReasonCode;
  if (payloadVersion !== 1 || !ARTIFACT_ID.test(input.artifactId)
    || !HASH.test(input.evidenceFingerprint)
    || !['SIGNED_SIMULATION_FAILED', 'PRE_SUBMISSION_GATES_FAILED']
      .includes(String(causeReasonCode))
    || !validTimestamp(input.observedAtMs)
    || (input.expectedState === 'PERSISTED' && input.expectedRevision !== 0n)
    || (input.expectedState === 'SIGNED_SIMULATED' && input.expectedRevision !== 1n)
    || (expectedState !== 'PERSISTED' && expectedState !== 'SIGNED_SIMULATED')) {
    throw failure('INVALID_INPUT');
  }
  return Object.freeze({ ...input, claim });
}

interface RevocationProofIdentity {
  readonly revocationId: string;
  readonly revocationFingerprint: string;
  readonly revokedAtMs: number;
}

function revocationProof(
  artifact: SignedTransactionArtifactV1,
  input: ExecutionPreSubmissionRevocationInputV1,
  revokedAtMs: number,
): RevocationProofIdentity {
  const revocationFingerprint = hash([
    'execution-pre-submission-revocation-v1', artifact.artifactId, artifact.intentId,
    artifact.attemptNumber, artifact.generationId, artifact.side, input.expectedState,
    input.expectedRevision.toString(), input.causeReasonCode, input.evidenceFingerprint,
    input.observedAtMs, revokedAtMs,
  ]);
  return Object.freeze({
    revocationId: `execution_pre_submission_revocation_${revocationFingerprint}`,
    revocationFingerprint,
    revokedAtMs,
  });
}

async function exactRevocationReplay(
  client: DatabaseClient,
  input: ExecutionPreSubmissionRevocationInputV1,
): Promise<boolean> {
  const result = await client.query(`SELECT intent_id,expected_state,
    expected_revision::TEXT AS expected_revision,cause_reason_code,evidence_fingerprint,
    trunc(EXTRACT(EPOCH FROM observed_at)*1000)::TEXT AS observed_at_ms
    FROM execution_pre_submission_revocations WHERE artifact_id=$1`, [input.artifactId]);
  if (result.rows.length !== 1) return false;
  const row = exactRow(result.rows[0] ?? {}, [
    'intent_id', 'expected_state', 'expected_revision', 'cause_reason_code',
    'evidence_fingerprint', 'observed_at_ms',
  ] as const);
  return row.intent_id === input.claim.intent.id
    && row.expected_state === input.expectedState
    && unsignedBigint(row.expected_revision) === input.expectedRevision
    && row.cause_reason_code === input.causeReasonCode
    && row.evidence_fingerprint === input.evidenceFingerprint
    && timestampText(row.observed_at_ms) === input.observedAtMs;
}

async function insertRevocationProof(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
  input: ExecutionPreSubmissionRevocationInputV1,
  proof: RevocationProofIdentity,
): Promise<void> {
  const inserted = await client.query(`INSERT INTO execution_pre_submission_revocations (
    revocation_id,payload_version,revocation_fingerprint,artifact_id,intent_id,
    attempt_number,generation_id,side,expected_state,expected_revision,cause_reason_code,
    evidence_fingerprint,observed_at,revoked_at,purge_after
  ) VALUES ($1,1,$2,$3,$4,$5::INTEGER,$6,$7,$8,$9::BIGINT,$10,$11,
    TIMESTAMPTZ 'epoch'+($12::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($13::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+(($13::BIGINT+14400000)*INTERVAL '1 millisecond'))`, [
    proof.revocationId, proof.revocationFingerprint, artifact.artifactId, artifact.intentId,
    artifact.attemptNumber, artifact.generationId, artifact.side, input.expectedState,
    input.expectedRevision.toString(), input.causeReasonCode, input.evidenceFingerprint,
    input.observedAtMs, proof.revokedAtMs,
  ]);
  if (inserted.rowCount !== 1) throw failure('CONFLICT');
}

async function revokeBuyBeforeSubmission(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
  input: ExecutionPreSubmissionRevocationInputV1,
  revokedAtMs: number,
): Promise<void> {
  if (artifact.armamentId === null || artifact.reservationId === null) {
    throw failure('INVALID_DATA');
  }
  const row = exactRow(singleRow(await client.query(`SELECT
    intent.state_revision::TEXT AS intent_revision,attempt.status AS attempt_status,
    reservation.state AS reservation_state,
    reservation.state_revision::TEXT AS reservation_revision,
    reservation.maximum_amount_raw::TEXT AS reservation_amount_raw,
    risk.state_revision::TEXT AS risk_revision,
    risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,risk.open_positions,
    armament.state AS armament_state,armament.state_revision::TEXT AS armament_revision
    FROM execution_signed_transactions transaction
    JOIN execution_intents intent ON intent.id=transaction.intent_id
    JOIN execution_attempts attempt ON attempt.intent_id=transaction.intent_id
      AND attempt.attempt_number=transaction.attempt_number
    JOIN execution_exposure_reservations reservation
      ON reservation.reservation_id=transaction.reservation_id
    JOIN execution_wallet_risk_state risk ON risk.generation_id=transaction.generation_id
    JOIN execution_activation_armaments armament
      ON armament.armament_id=transaction.armament_id
    WHERE transaction.artifact_id=$1
    FOR UPDATE OF intent,attempt,reservation,risk,armament`, [artifact.artifactId])), [
    'intent_revision', 'attempt_status', 'reservation_state', 'reservation_revision',
    'reservation_amount_raw', 'risk_revision', 'reserved_exposure_raw', 'open_positions',
    'armament_state', 'armament_revision',
  ] as const);
  const reservationAmount = unsignedBigint(row.reservation_amount_raw);
  const reservedExposure = unsignedBigint(row.reserved_exposure_raw);
  const openPositions = integer(row.open_positions);
  if (row.attempt_status !== 'STARTED' || row.reservation_state !== 'RESERVED'
    || row.armament_state !== 'LOCKED' || reservedExposure < reservationAmount
    || openPositions < 1) throw failure('CONFLICT');
  const transition = await insertRevocationIntentTransition(
    client, artifact, 'FAILED', input, revokedAtMs,
  );
  const intentRevision = unsignedBigint(row.intent_revision);
  const intent = await client.query(`UPDATE execution_intents SET status='FAILED',
    state_revision=$2::BIGINT,last_reason_code='PRE_SUBMISSION_REVOKED_NO_SEND',
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
    terminal_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    reconciliation_completed_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond'),
    updated_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')
    WHERE id=$1 AND status='SIGNED_NOT_SUBMITTED' AND state_revision=$4::BIGINT`, [
    artifact.intentId, (intentRevision + 1n).toString(), revokedAtMs, intentRevision.toString(),
  ]);
  const attempt = await abandonRevokedAttempt(client, artifact, revokedAtMs);
  const reservationRevision = unsignedBigint(row.reservation_revision);
  const reservation = await client.query(`UPDATE execution_exposure_reservations SET
    state='RELEASED',state_revision=$2::BIGINT,
    reconciled_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond')
    WHERE reservation_id=$1 AND state='RESERVED' AND state_revision=$4::BIGINT`, [
    artifact.reservationId, (reservationRevision + 1n).toString(), revokedAtMs,
    reservationRevision.toString(),
  ]);
  const riskRevision = unsignedBigint(row.risk_revision);
  const risk = await client.query(`UPDATE execution_wallet_risk_state SET
    state_revision=$2::BIGINT,reserved_exposure_raw=$3::NUMERIC,open_positions=$4,
    updated_at=TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond')
    WHERE generation_id=$1 AND state_revision=$6::BIGINT`, [
    artifact.generationId, (riskRevision + 1n).toString(),
    (reservedExposure - reservationAmount).toString(), openPositions - 1,
    revokedAtMs, riskRevision.toString(),
  ]);
  const armamentRevision = unsignedBigint(row.armament_revision);
  const activation = await insertRevokedActivationEvent(client, artifact, revokedAtMs);
  const armament = await client.query(`UPDATE execution_activation_armaments SET
    state='REVOKED',state_revision=$2::BIGINT,
    terminal_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond')
    WHERE armament_id=$1 AND state='LOCKED' AND state_revision=$4::BIGINT`, [
    artifact.armamentId, (armamentRevision + 1n).toString(), revokedAtMs,
    armamentRevision.toString(),
  ]);
  if ([transition, intent, attempt, reservation, risk, activation, armament]
    .some((result) => result.rowCount !== 1)) throw failure('CONFLICT');
}

async function revokeSellBeforeSubmission(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
  input: ExecutionPreSubmissionRevocationInputV1,
  revokedAtMs: number,
): Promise<void> {
  if (artifact.exitAuthorizationId === null) throw failure('INVALID_DATA');
  const row = exactRow(singleRow(await client.query(`SELECT
    intent.state_revision::TEXT AS intent_revision,attempt.status AS attempt_status,
    exit_auth.state AS authorization_state,
    exit_auth.state_revision::TEXT AS authorization_revision,
    exit_auth.locked_intent_id,exit_auth.locked_attempt_number,
    position.state AS position_state,position.exit_intent_id,
    armament.state AS armament_state
    FROM execution_signed_transactions transaction
    JOIN execution_intents intent ON intent.id=transaction.intent_id
    JOIN execution_attempts attempt ON attempt.intent_id=transaction.intent_id
      AND attempt.attempt_number=transaction.attempt_number
    JOIN execution_exit_authorizations exit_auth
      ON exit_auth.authorization_id=transaction.exit_authorization_id
    JOIN execution_live_positions position ON position.position_id=exit_auth.position_id
    JOIN execution_activation_armaments armament ON armament.armament_id=position.armament_id
    WHERE transaction.artifact_id=$1
    FOR UPDATE OF intent,attempt,exit_auth,position,armament`, [artifact.artifactId])), [
    'intent_revision', 'attempt_status', 'authorization_state', 'authorization_revision',
    'locked_intent_id', 'locked_attempt_number', 'position_state', 'exit_intent_id',
    'armament_state',
  ] as const);
  if (row.attempt_status !== 'STARTED' || row.authorization_state !== 'LOCKED'
    || row.locked_intent_id !== artifact.intentId
    || integer(row.locked_attempt_number) !== artifact.attemptNumber
    || row.position_state !== 'EXIT_PENDING' || row.exit_intent_id !== artifact.intentId
    || row.armament_state !== 'LOCKED') throw failure('CONFLICT');
  const transition = await insertRevocationIntentTransition(
    client, artifact, 'RETRY_READY', input, revokedAtMs,
  );
  const intentRevision = unsignedBigint(row.intent_revision);
  const intent = await client.query(`UPDATE execution_intents SET status='RETRY_READY',
    state_revision=$2::BIGINT,last_reason_code='PRE_SUBMISSION_REVOKED_NO_SEND',
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
    updated_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')
    WHERE id=$1 AND status='SIGNED_NOT_SUBMITTED' AND state_revision=$4::BIGINT`, [
    artifact.intentId, (intentRevision + 1n).toString(), revokedAtMs, intentRevision.toString(),
  ]);
  const attempt = await abandonRevokedAttempt(client, artifact, revokedAtMs);
  const authorizationRevision = unsignedBigint(row.authorization_revision);
  const authorization = await client.query(`UPDATE execution_exit_authorizations SET
    state='ACTIVE',state_revision=$2::BIGINT,locked_intent_id=NULL,locked_attempt_number=NULL
    WHERE authorization_id=$1 AND state='LOCKED' AND state_revision=$3::BIGINT`, [
    artifact.exitAuthorizationId, (authorizationRevision + 1n).toString(),
    authorizationRevision.toString(),
  ]);
  if ([transition, intent, attempt, authorization]
    .some((result) => result.rowCount !== 1)) throw failure('CONFLICT');
}

async function insertRevocationIntentTransition(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
  nextStatus: 'FAILED' | 'RETRY_READY',
  input: ExecutionPreSubmissionRevocationInputV1,
  revokedAtMs: number,
): Promise<QueryResult> {
  return client.query(`INSERT INTO execution_intent_transitions (
    intent_id,previous_status,next_status,reason_code,human_message,activation_phase,
    attempt_number,evidence,occurred_at
  ) VALUES ($1,'SIGNED_NOT_SUBMITTED',$2,'PRE_SUBMISSION_REVOKED_NO_SEND',$3,'CANARY',$4,
    jsonb_build_object('payloadVersion',1,'attemptNumber',$4::INTEGER,
      'sourceEventId',$5::TEXT,'observedAtMs',$6::BIGINT),
    TIMESTAMPTZ 'epoch'+($6::BIGINT*INTERVAL '1 millisecond'))`, [
    artifact.intentId, nextStatus,
    nextStatus === 'FAILED'
      ? 'Signed BUY was revoked before the submission fence; no send occurred.'
      : 'Signed SELL was revoked before the submission fence; exit retry enabled.',
    artifact.attemptNumber, input.artifactId, revokedAtMs,
  ]);
}

async function abandonRevokedAttempt(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
  revokedAtMs: number,
): Promise<QueryResult> {
  return client.query(`UPDATE execution_attempts SET status='ABANDONED',
    completed_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    reason_code='PRE_SUBMISSION_REVOKED_NO_SEND'
    WHERE intent_id=$1 AND attempt_number=$2 AND status='STARTED'`, [
    artifact.intentId, artifact.attemptNumber, revokedAtMs,
  ]);
}

async function insertRevokedActivationEvent(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
  revokedAtMs: number,
): Promise<QueryResult> {
  const eventFingerprint = hash([
    'execution-activation-event-v1', artifact.armamentId, 'LOCKED', 'REVOKED',
    'ARMAMENT_REVOKED', revokedAtMs,
  ]);
  return client.query(`INSERT INTO execution_activation_events (
    event_id,payload_version,event_fingerprint,armament_id,generation_id,
    previous_state,next_state,reason_code,occurred_at
  ) VALUES ($1,1,$2,$3,$4,'LOCKED','REVOKED','ARMAMENT_REVOKED',
    TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond'))`, [
    `execution_activation_event_${eventFingerprint}`, eventFingerprint,
    artifact.armamentId, artifact.generationId, revokedAtMs,
  ]);
}

function recreateArtifact(value: SignedTransactionArtifactV1): SignedTransactionArtifactV1 {
  return createSignedTransactionArtifact({
    payloadVersion: value.payloadVersion,
    specificationVersion: value.specificationVersion,
    intentId: value.intentId,
    attemptNumber: value.attemptNumber,
    generationId: value.generationId,
    armamentId: value.armamentId,
    reservationId: value.reservationId,
    exitAuthorizationId: value.exitAuthorizationId,
    providerId: value.providerId,
    walletPublicKey: value.walletPublicKey,
    side: value.side,
    effectiveVenue: value.effectiveVenue,
    messageHash: value.messageHash,
    buildFingerprint: value.buildFingerprint,
    snapshotFingerprint: value.snapshotFingerprint,
    quoteFingerprint: value.quoteFingerprint,
    quoteObservedAtMs: value.quoteObservedAtMs,
    quoteExpiresAtMs: value.quoteExpiresAtMs,
    blockhash: value.blockhash,
    lastValidBlockHeight: value.lastValidBlockHeight,
    signature: value.signature,
    signedTransactionBytes: Uint8Array.from(value.signedTransactionBytes),
    signedAtMs: value.signedAtMs,
  });
}

interface PreparationBindingInput {
  readonly claim: ClaimedExecutionIntent;
  readonly generationId: string;
  readonly runtime: ExecutionLiveRuntimeBindingV1;
}

async function readBuyPreparationBinding(
  client: DatabaseClient,
  input: PreparationBindingInput,
): Promise<ExecutionLivePreparationBindingV1> {
  const result = await client.query(`SELECT
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms,
    intent.status AS intent_status,intent.side AS intent_side,
    intent.lease_owner,intent.lease_token::TEXT AS lease_token,
    trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT AS lease_expires_at_ms,
    attempt.status AS attempt_status,generation.generation_id,
    generation.wallet_public_key AS generation_wallet_public_key,
    generation.cluster AS generation_cluster,generation.genesis_hash AS generation_genesis_hash,
    generation.retired_at,control.state AS control_state,
    qualification.qualification_id,qualification.phase AS qualification_phase,
    qualification.build_hash AS qualification_build_hash,
    qualification.configuration_fingerprint AS qualification_configuration_fingerprint,
    qualification.strategy_fingerprint AS qualification_strategy_fingerprint,
    qualification.wallet_public_key AS qualification_wallet_public_key,
    qualification.cluster AS qualification_cluster,
    qualification.genesis_hash AS qualification_genesis_hash,
    qualification.provider_id AS qualification_provider_id,
    trunc(EXTRACT(EPOCH FROM qualification.expires_at)*1000)::TEXT
      AS qualification_expires_at_ms,
    armament.armament_id,armament.state AS armament_state,
    armament.phase AS armament_phase,armament.build_hash AS armament_build_hash,
    armament.configuration_fingerprint AS armament_configuration_fingerprint,
    armament.strategy_fingerprint AS armament_strategy_fingerprint,
    armament.wallet_public_key AS armament_wallet_public_key,
    armament.cluster AS armament_cluster,armament.genesis_hash AS armament_genesis_hash,
    armament.provider_id AS armament_provider_id,
    armament.consumed_buys,armament.maximum_buys,
    trunc(EXTRACT(EPOCH FROM armament.expires_at)*1000)::TEXT AS armament_expires_at_ms,
    reservation.reservation_id,reservation.state AS reservation_state,
    reservation.intent_id AS reservation_intent_id,
    reservation.generation_id AS reservation_generation_id,
    admission.decision AS admission_decision,admission.quota_state,
    risk.unknown_block,provider.superseded_at AS provider_superseded_at,
    trunc(EXTRACT(EPOCH FROM provider.expires_at)*1000)::TEXT AS provider_expires_at_ms
    FROM execution_intents intent
    JOIN execution_attempts attempt ON attempt.intent_id=intent.id
      AND attempt.attempt_number=$2
    JOIN execution_wallet_generations generation ON generation.generation_id=$3
    JOIN execution_control_state control ON control.generation_id=generation.generation_id
    JOIN execution_activation_armaments armament
      ON armament.generation_id=generation.generation_id AND armament.state='ARMED'
    JOIN execution_safety_qualifications qualification
      ON qualification.qualification_id=armament.qualification_id
    JOIN execution_exposure_reservations reservation
      ON reservation.intent_id=intent.id AND reservation.generation_id=generation.generation_id
        AND reservation.state='RESERVED'
    JOIN execution_risk_admission_reports admission
      ON admission.report_id=reservation.admission_report_id
    JOIN execution_wallet_risk_state risk ON risk.generation_id=generation.generation_id
    JOIN execution_provider_usage_snapshots provider
      ON provider.snapshot_fingerprint=reservation.provider_snapshot_fingerprint
      AND provider.provider_id=armament.provider_id
    WHERE intent.id=$1`, [
    input.claim.intent.id, input.claim.intent.attemptCount, input.generationId,
  ]);
  if (result.rows.length !== 1) throw failure('PREFLIGHT_EXPIRED');
  const row = singleRow(result);
  const nowMs = timestampText(row.now_ms);
  validatePreparationClaim(row, input, nowMs);
  if (row.control_state !== 'RUNNING') throw failure('CONTROL_STOPPED');
  if (row.intent_side !== 'BUY' || row.retired_at !== null
    || !runtimeMatches(row, input.runtime)
    || !qualificationRuntimeMatches(row, input.runtime)
    || timestampText(row.qualification_expires_at_ms) <= nowMs
    || row.armament_state !== 'ARMED'
    || timestampText(row.armament_expires_at_ms) <= nowMs
    || integer(row.consumed_buys) >= integer(row.maximum_buys)
    || row.reservation_state !== 'RESERVED'
    || row.reservation_intent_id !== input.claim.intent.id
    || row.reservation_generation_id !== input.generationId
    || row.admission_decision !== 'ADMITTED' || row.quota_state !== 'NORMAL'
    || row.unknown_block !== false || row.provider_superseded_at !== null
    || timestampText(row.provider_expires_at_ms) <= nowMs) {
    throw failure('PREFLIGHT_EXPIRED');
  }
  return preparationBinding(row, 'BUY');
}

async function readSellPreparationBinding(
  client: DatabaseClient,
  input: PreparationBindingInput,
): Promise<ExecutionLivePreparationBindingV1> {
  const result = await client.query(`SELECT
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms,
    intent.status AS intent_status,intent.side AS intent_side,
    intent.base_amount_raw::TEXT AS intent_base_amount_raw,
    intent.mint,intent.quote_mint,intent.lease_owner,
    intent.lease_token::TEXT AS lease_token,
    trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT AS lease_expires_at_ms,
    attempt.status AS attempt_status,generation.generation_id,
    generation.wallet_public_key AS generation_wallet_public_key,
    generation.cluster AS generation_cluster,generation.genesis_hash AS generation_genesis_hash,
    generation.retired_at,control.state AS control_state,
    qualification.qualification_id,qualification.phase AS qualification_phase,
    qualification.build_hash AS qualification_build_hash,
    qualification.configuration_fingerprint AS qualification_configuration_fingerprint,
    qualification.strategy_fingerprint AS qualification_strategy_fingerprint,
    qualification.wallet_public_key AS qualification_wallet_public_key,
    qualification.cluster AS qualification_cluster,
    qualification.genesis_hash AS qualification_genesis_hash,
    qualification.provider_id AS qualification_provider_id,
    trunc(EXTRACT(EPOCH FROM qualification.expires_at)*1000)::TEXT
      AS qualification_expires_at_ms,
    armament.armament_id,armament.phase AS armament_phase,
    armament.build_hash AS armament_build_hash,
    armament.configuration_fingerprint AS armament_configuration_fingerprint,
    armament.strategy_fingerprint AS armament_strategy_fingerprint,
    armament.wallet_public_key AS armament_wallet_public_key,
    armament.cluster AS armament_cluster,armament.genesis_hash AS armament_genesis_hash,
    armament.provider_id AS armament_provider_id,
    exit_auth.authorization_id AS exit_authorization_id,
    exit_auth.state AS authorization_state,
    exit_auth.maximum_base_amount_raw::TEXT AS maximum_base_amount_raw,
    exit_auth.generation_id AS authorization_generation_id,
    exit_auth.wallet_public_key AS authorization_wallet_public_key,
    exit_auth.mint AS authorization_mint,exit_auth.quote_mint AS authorization_quote_mint,
    position.state AS position_state,position.exit_intent_id,
    position.remaining_base_raw::TEXT AS remaining_base_raw
    FROM execution_intents intent
    JOIN execution_attempts attempt ON attempt.intent_id=intent.id
      AND attempt.attempt_number=$2
    JOIN execution_wallet_generations generation ON generation.generation_id=$3
    JOIN execution_control_state control ON control.generation_id=generation.generation_id
    JOIN execution_exit_authorizations exit_auth
      ON exit_auth.locked_intent_id IS NULL AND exit_auth.state='ACTIVE'
    JOIN execution_live_positions position
      ON position.position_id=exit_auth.position_id AND position.exit_intent_id=intent.id
    JOIN execution_activation_armaments armament ON armament.armament_id=position.armament_id
    JOIN execution_safety_qualifications qualification
      ON qualification.qualification_id=armament.qualification_id
    WHERE intent.id=$1 AND exit_auth.generation_id=generation.generation_id`, [
    input.claim.intent.id, input.claim.intent.attemptCount, input.generationId,
  ]);
  if (result.rows.length !== 1) throw failure('PREFLIGHT_EXPIRED');
  const row = singleRow(result);
  const nowMs = timestampText(row.now_ms);
  validatePreparationClaim(row, input, nowMs);
  const amount = unsignedBigint(row.intent_base_amount_raw);
  if (row.control_state === 'HARD_STOP') throw failure('CONTROL_STOPPED');
  if (row.intent_side !== 'SELL' || row.retired_at !== null
    || !runtimeMatches(row, input.runtime)
    || !qualificationRuntimeMatches(row, input.runtime)
    || timestampText(row.qualification_expires_at_ms) <= nowMs
    || row.authorization_state !== 'ACTIVE'
    || row.authorization_generation_id !== input.generationId
    || row.authorization_wallet_public_key !== input.runtime.walletPublicKey
    || row.authorization_mint !== row.mint || row.authorization_quote_mint !== row.quote_mint
    || row.position_state !== 'EXIT_PENDING'
    || row.exit_intent_id !== input.claim.intent.id
    || amount === 0n || amount > unsignedBigint(row.maximum_base_amount_raw)
    || amount > unsignedBigint(row.remaining_base_raw)) {
    throw failure('PREFLIGHT_EXPIRED');
  }
  return preparationBinding(row, 'SELL');
}

function validatePreparationClaim(
  row: Row,
  input: PreparationBindingInput,
  nowMs: number,
): void {
  if (row.lease_owner !== input.claim.leaseOwner
    || row.lease_token !== input.claim.leaseToken
    || timestampText(row.lease_expires_at_ms) <= nowMs) throw failure('LEASE_LOST');
  if (row.intent_status !== 'PROCESSING' || row.attempt_status !== 'STARTED'
    || row.generation_id !== input.generationId
    || row.generation_wallet_public_key !== input.runtime.walletPublicKey
    || row.generation_cluster !== input.runtime.cluster
    || row.generation_genesis_hash !== input.runtime.observedGenesisHash) {
    throw failure('PREFLIGHT_EXPIRED');
  }
}

function preparationBinding(
  row: Row,
  side: 'BUY' | 'SELL',
): ExecutionLivePreparationBindingV1 {
  const qualificationId = patternedText(
    row.qualification_id, /^execution_safety_qualification_[0-9a-f]{64}$/u,
  );
  const armamentId = patternedText(
    row.armament_id, /^execution_activation_armament_[0-9a-f]{64}$/u,
  );
  return Object.freeze({
    payloadVersion: 1,
    side,
    generationId: patternedText(
      row.generation_id, /^execution_wallet_generation_[0-9a-f]{64}$/u,
    ),
    qualificationId,
    armamentId: side === 'BUY' ? armamentId : null,
    reservationId: side === 'BUY'
      ? patternedText(row.reservation_id, /^execution_exposure_reservation_[0-9a-f]{64}$/u)
      : null,
    exitAuthorizationId: side === 'SELL'
      ? patternedText(row.exit_authorization_id, /^execution_exit_authorization_[0-9a-f]{64}$/u)
      : null,
    providerId: patternedText(row.armament_provider_id, PROVIDER_ID),
    walletPublicKey: patternedText(row.generation_wallet_public_key, PUBLIC_KEY),
  });
}

async function persistSellSigned(
  client: DatabaseClient,
  input: ExecutionLivePersistSignedInputV1,
): Promise<ExecutionLivePersistSignedResultV1> {
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
    FOR UPDATE OF intent,attempt,exit_auth,position,armament`, [
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
  await persistUnsignedSimulationEvidence(client, input);
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
      AND lease_expires_at > statement_timestamp()
    RETURNING ${AUTHORITATIVE_CLAIM_PROJECTION}`, [
    artifact.intentId, input.claim.leaseOwner, input.claim.leaseToken,
    input.claim.intent.stateRevision.toString(),
  ]);
  if (transitioned.rowCount !== 1) throw failure('LEASE_LOST');
  await insertIntentTransitions(client, input, nowMs);
  await insertSubmissionEvent(client, artifact, nowMs);
  return persistedResult(artifact, transitionedClaim(
    input.claim, transitioned, 'SIGNED_NOT_SUBMITTED', 2n, 'SIGNATURE_PERSISTED',
  ));
}

async function beginSellSubmission(
  client: DatabaseClient,
  claim: ClaimedExecutionIntent,
  input: Readonly<{
    readonly claim: ClaimedExecutionIntent;
    readonly artifactId: string;
    readonly expectedRevision: bigint;
    readonly runtime: ExecutionLiveRuntimeBindingV1;
    readonly blockhashValidity: ExecutionBlockhashValidityEvidenceV1;
  }>,
  current: Row,
): Promise<AuthenticatedSubmissionStartedTransactionV1> {
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
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms,
    trunc(EXTRACT(EPOCH FROM intent.expires_at)*1000)::TEXT AS intent_expires_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.quote_observed_at)*1000)::TEXT
      AS quote_observed_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.quote_expires_at)*1000)::TEXT
      AS quote_expires_at_ms,
    attempt.status AS attempt_status,
    generation.wallet_public_key AS generation_wallet_public_key,
    generation.cluster AS generation_cluster,generation.genesis_hash AS generation_genesis_hash,
    generation.retired_at AS generation_retired_at,
    control.state AS control_state,exit_auth.state AS authorization_state,
    exit_auth.locked_intent_id,exit_auth.locked_attempt_number,
    position.state AS position_state,position.remaining_base_raw::TEXT AS remaining_base_raw,
    armament.armament_id AS position_armament_id,armament.phase AS armament_phase,
    armament.build_hash AS armament_build_hash,
    armament.configuration_fingerprint AS armament_configuration_fingerprint,
    armament.strategy_fingerprint AS armament_strategy_fingerprint,
    armament.wallet_public_key AS armament_wallet_public_key,
    armament.cluster AS armament_cluster,armament.genesis_hash AS armament_genesis_hash,
    armament.provider_id AS armament_provider_id,
    provider.provider_id AS snapshot_provider_id,
    provider.superseded_at AS provider_superseded_at,
    trunc(EXTRACT(EPOCH FROM provider.expires_at)*1000)::TEXT AS provider_expires_at_ms
    FROM execution_signed_transactions transaction
    JOIN execution_intents intent ON intent.id=transaction.intent_id
    JOIN execution_attempts attempt ON attempt.intent_id=transaction.intent_id
      AND attempt.attempt_number=transaction.attempt_number
    JOIN execution_wallet_generations generation
      ON generation.generation_id=transaction.generation_id
    JOIN execution_exit_authorizations exit_auth
      ON exit_auth.authorization_id=transaction.exit_authorization_id
    JOIN execution_live_positions position ON position.position_id=exit_auth.position_id
    JOIN execution_activation_armaments armament ON armament.armament_id=position.armament_id
    JOIN execution_control_state control ON control.generation_id=exit_auth.generation_id
    JOIN execution_provider_usage_snapshots provider
      ON provider.provider_id=transaction.provider_id AND provider.superseded_at IS NULL
    WHERE transaction.artifact_id=$1 AND exit_auth.authorization_id=$2
    FOR UPDATE OF exit_auth,position,armament`, [
    artifact.artifactId, artifact.exitAuthorizationId,
  ])), [
    'now_ms', 'intent_expires_at_ms', 'quote_observed_at_ms', 'quote_expires_at_ms',
    'attempt_status', 'generation_wallet_public_key', 'generation_cluster',
    'generation_genesis_hash', 'generation_retired_at', 'control_state',
    'authorization_state', 'locked_intent_id', 'locked_attempt_number',
    'position_state', 'remaining_base_raw', 'position_armament_id', 'armament_phase',
    'armament_build_hash', 'armament_configuration_fingerprint',
    'armament_strategy_fingerprint', 'armament_wallet_public_key', 'armament_cluster',
    'armament_genesis_hash', 'armament_provider_id', 'snapshot_provider_id',
    'provider_superseded_at', 'provider_expires_at_ms',
  ] as const);
  const nowMs = timestampText(gate.now_ms);
  if (gate.control_state === 'HARD_STOP' || gate.authorization_state !== 'LOCKED'
    || gate.locked_intent_id !== artifact.intentId
    || integer(gate.locked_attempt_number) !== artifact.attemptNumber
    || gate.attempt_status !== 'STARTED'
    || timestampText(gate.intent_expires_at_ms) <= nowMs
    || gate.generation_retired_at !== null
    || gate.position_state !== 'EXIT_PENDING'
    || unsignedBigint(gate.remaining_base_raw) === 0n
    || gate.armament_provider_id !== artifact.providerId
    || gate.snapshot_provider_id !== artifact.providerId
    || gate.provider_superseded_at !== null
    || timestampText(gate.provider_expires_at_ms) <= nowMs
    || !runtimeMatches(gate, input.runtime)
    || !freshArtifactProof(artifact, gate, input.blockhashValidity, nowMs)) {
    throw failure('PREFLIGHT_EXPIRED');
  }
  await insertSubmissionPreflightEvidence(client, artifact, gate, input, nowMs);
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
    generation_id,armament_id,reservation_id,exit_authorization_id,provider_id,wallet_public_key,
    side,effective_venue,message_hash,build_fingerprint,snapshot_fingerprint,
    quote_fingerprint,quote_observed_at,quote_expires_at,blockhash,last_valid_block_height,signature,
    signed_transaction_bytes,signed_transaction_hash,state,state_revision,signed_at
  ) VALUES ($1,1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
    TIMESTAMPTZ 'epoch'+($16::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($17::BIGINT*INTERVAL '1 millisecond'),$18,$19::BIGINT,
    $20,$21,$22,'PERSISTED',0,
    TIMESTAMPTZ 'epoch'+($23::BIGINT*INTERVAL '1 millisecond'))`, [
    artifact.artifactId, artifact.intentId, artifact.attemptNumber,
    artifact.generationId, artifact.armamentId, artifact.reservationId,
    artifact.exitAuthorizationId, artifact.providerId, artifact.walletPublicKey, artifact.side,
    artifact.effectiveVenue, artifact.messageHash,
    artifact.buildFingerprint, artifact.snapshotFingerprint, artifact.quoteFingerprint,
    artifact.quoteObservedAtMs, artifact.quoteExpiresAtMs,
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
  return findArtifactWhere(
    client, 'transaction.artifact_id=$1', [artifactId], lock,
  );
}

async function findArtifactReference(
  client: DatabaseClient,
  artifactId: string,
  lock: boolean,
): Promise<Row | null> {
  const result = await client.query(`SELECT ${ARTIFACT_REFERENCE_COLUMNS},
    intent.status AS intent_status,intent.lease_owner,
    intent.lease_token::TEXT AS lease_token,
    trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT AS lease_expires_at_ms,
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms,
    trunc(EXTRACT(EPOCH FROM transaction.signed_at)*1000)::TEXT AS signed_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.quote_observed_at)*1000)::TEXT
      AS quote_observed_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.quote_expires_at)*1000)::TEXT
      AS quote_expires_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.confirmed_at)*1000)::TEXT AS confirmed_at_ms
    FROM execution_signed_transactions transaction
    JOIN execution_intents intent ON intent.id=transaction.intent_id
    WHERE transaction.artifact_id=$1${lock ? ' FOR UPDATE OF transaction,intent' : ''}`, [
    artifactId,
  ]);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  return result.rows[0] ?? null;
}

async function findArtifactForClaim(
  client: DatabaseClient,
  intentId: string,
  attemptNumber: number,
): Promise<Row | null> {
  return findArtifactWhere(
    client,
    'transaction.intent_id=$1 AND transaction.attempt_number=$2::INTEGER',
    [intentId, attemptNumber],
    false,
  );
}

async function findArtifactWhere(
  client: DatabaseClient,
  predicate: string,
  values: readonly unknown[],
  lock: boolean,
): Promise<Row | null> {
  const result = await client.query(`SELECT transaction.*,
    intent.status AS intent_status,intent.lease_owner,
    intent.lease_token::TEXT AS lease_token,
    intent.status AS claim_status,intent.attempt_count AS claim_attempt_count,
    intent.state_revision::TEXT AS claim_state_revision,
    intent.last_reason_code AS claim_last_reason_code,
    trunc(EXTRACT(EPOCH FROM intent.updated_at)*1000)::TEXT AS claim_updated_at_ms,
    intent.lease_owner AS claim_lease_owner,
    intent.lease_token::TEXT AS claim_lease_token,
    trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT
      AS claim_lease_expires_at_ms,
    trunc(EXTRACT(EPOCH FROM intent.lease_expires_at)*1000)::TEXT AS lease_expires_at_ms,
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms,
    trunc(EXTRACT(EPOCH FROM transaction.signed_at)*1000)::TEXT AS signed_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.quote_observed_at)*1000)::TEXT
      AS quote_observed_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.quote_expires_at)*1000)::TEXT
      AS quote_expires_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.confirmed_at)*1000)::TEXT AS confirmed_at_ms
    FROM execution_signed_transactions transaction
    JOIN execution_intents intent ON intent.id=transaction.intent_id
    WHERE ${predicate}${lock ? ' FOR UPDATE OF transaction,intent' : ''}`, values);
  if (result.rows.length > 1) throw failure('INVALID_DATA');
  return result.rows[0] ?? null;
}

async function loadUnsignedSimulationEvidence(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
): Promise<ExecutionSimulationEvidenceV1> {
  const row = exactRow(singleRow(await client.query(`SELECT
    evidence_id,evidence_fingerprint,provider_id,snapshot_fingerprint,
    build_fingerprint,message_hash,blockhash,
    last_valid_block_height::TEXT AS last_valid_block_height,
    blockhash_context_slot::TEXT AS blockhash_context_slot,
    fee_context_slot::TEXT AS fee_context_slot,
    estimated_fee_lamports::TEXT AS estimated_fee_lamports,
    simulation_slot::TEXT AS simulation_slot,
    simulated_fee_payer_lamport_debit::TEXT AS simulated_fee_payer_lamport_debit,
    units_consumed::TEXT AS units_consumed,
    simulated_base_delta_raw::TEXT AS simulated_base_delta_raw,
    simulated_quote_delta_raw::TEXT AS simulated_quote_delta_raw,
    logs_fingerprint,logs_line_count
    FROM execution_live_unsigned_simulation_evidence WHERE artifact_id=$1`, [
    artifact.artifactId,
  ])), [
    'evidence_id', 'evidence_fingerprint', 'provider_id', 'snapshot_fingerprint',
    'build_fingerprint', 'message_hash', 'blockhash', 'last_valid_block_height',
    'blockhash_context_slot', 'fee_context_slot', 'estimated_fee_lamports',
    'simulation_slot', 'simulated_fee_payer_lamport_debit', 'units_consumed',
    'simulated_base_delta_raw', 'simulated_quote_delta_raw', 'logs_fingerprint',
    'logs_line_count',
  ] as const);
  const evidence: ExecutionSimulationEvidenceV1 = Object.freeze({
    outcome: 'SUCCESS',
    snapshotFingerprint: text(row.snapshot_fingerprint),
    buildFingerprint: text(row.build_fingerprint),
    messageHash: text(row.message_hash),
    blockhash: text(row.blockhash),
    lastValidBlockHeight: unsignedBigint(row.last_valid_block_height),
    blockhashContextSlot: unsignedBigint(row.blockhash_context_slot),
    feeContextSlot: unsignedBigint(row.fee_context_slot),
    estimatedFeeLamports: unsignedBigint(row.estimated_fee_lamports),
    simulationSlot: unsignedBigint(row.simulation_slot),
    simulatedFeePayerLamportDebit: unsignedBigint(row.simulated_fee_payer_lamport_debit),
    unitsConsumed: unsignedBigint(row.units_consumed),
    simulatedBaseDeltaRaw: signedBigint(row.simulated_base_delta_raw),
    simulatedQuoteDeltaRaw: signedBigint(row.simulated_quote_delta_raw),
    logsFingerprint: text(row.logs_fingerprint),
    logsLineCount: integer(row.logs_line_count),
  });
  const identity = createExecutionLiveUnsignedSimulationEvidenceIdentity(artifact, evidence);
  if (row.evidence_id !== identity.evidenceId
    || row.evidence_fingerprint !== identity.evidenceFingerprint
    || row.provider_id !== artifact.providerId) throw failure('INVALID_DATA');
  return evidence;
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
    reservationId: row.reservation_id,
    exitAuthorizationId: row.exit_authorization_id,
    providerId: row.provider_id,
    walletPublicKey: row.wallet_public_key,
    side: row.side,
    effectiveVenue: row.effective_venue,
    messageHash: row.message_hash,
    buildFingerprint: row.build_fingerprint,
    snapshotFingerprint: row.snapshot_fingerprint,
    quoteFingerprint: row.quote_fingerprint,
    quoteObservedAtMs: timestampText(row.quote_observed_at_ms),
    quoteExpiresAtMs: timestampText(row.quote_expires_at_ms),
    blockhash: row.blockhash,
    lastValidBlockHeight: unsignedBigint(row.last_valid_block_height),
    signature: row.signature,
    signedTransactionBytes: bytes,
    signedAtMs: timestampText(row.signed_at_ms),
  });
}

function artifactReferenceFromRow(row: Row): ExecutionLiveArtifactReferenceV1 {
  const reference: ExecutionLiveArtifactReferenceV1 = Object.freeze({
    artifactId: text(row.artifact_id),
    payloadVersion: 1,
    specificationVersion: 1,
    intentId: text(row.intent_id),
    attemptNumber: positiveInteger(row.attempt_number),
    generationId: text(row.generation_id),
    armamentId: nullablePatternedId(
      row.armament_id, /^execution_activation_armament_[0-9a-f]{64}$/u,
    ),
    reservationId: nullablePatternedId(
      row.reservation_id, /^execution_exposure_reservation_[0-9a-f]{64}$/u,
    ),
    exitAuthorizationId: nullablePatternedId(
      row.exit_authorization_id, /^execution_exit_authorization_[0-9a-f]{64}$/u,
    ),
    providerId: providerIdentifier(row.provider_id),
    walletPublicKey: solanaAddress(row.wallet_public_key),
    side: executionSide(row.side),
    effectiveVenue: executionVenue(row.effective_venue),
    messageHash: fingerprintText(row.message_hash),
    buildFingerprint: fingerprintText(row.build_fingerprint),
    snapshotFingerprint: fingerprintText(row.snapshot_fingerprint),
    quoteFingerprint: fingerprintText(row.quote_fingerprint),
    quoteObservedAtMs: timestampText(row.quote_observed_at_ms),
    quoteExpiresAtMs: timestampText(row.quote_expires_at_ms),
    blockhash: solanaAddress(row.blockhash),
    lastValidBlockHeight: unsignedBigint(row.last_valid_block_height),
    signature: reconciliationSignature(row.signature),
    signedTransactionHash: fingerprintText(row.signed_transaction_hash),
    state: 'PERSISTED',
    stateRevision: 0n,
    signedAtMs: timestampText(row.signed_at_ms),
  });
  if (integer(row.payload_version) !== 1 || integer(row.specification_version) !== 1
    || !ARTIFACT_ID.test(reference.artifactId)
    || !/^execution_intent_[0-9a-f]{64}$/u.test(reference.intentId)
    || !/^execution_wallet_generation_[0-9a-f]{64}$/u.test(reference.generationId)
    || createSignedTransactionArtifactId(reference) !== reference.artifactId
    || reference.quoteObservedAtMs > reference.signedAtMs
    || reference.signedAtMs >= reference.quoteExpiresAtMs) throw failure('INVALID_DATA');
  return reference;
}

function nullablePatternedId(value: unknown, pattern: RegExp): string | null {
  if (value === null) return null;
  const candidate = text(value);
  if (!pattern.test(candidate)) throw failure('INVALID_DATA');
  return candidate;
}

function sameArtifact(row: Row, artifact: SignedTransactionArtifactV1): boolean {
  try {
    const stored = artifactFromRow(row);
    return stored.artifactId === artifact.artifactId
      && stored.intentId === artifact.intentId
      && stored.attemptNumber === artifact.attemptNumber
      && stored.generationId === artifact.generationId
      && stored.armamentId === artifact.armamentId
      && stored.reservationId === artifact.reservationId
      && stored.exitAuthorizationId === artifact.exitAuthorizationId
      && stored.providerId === artifact.providerId
      && stored.walletPublicKey === artifact.walletPublicKey
      && stored.side === artifact.side
      && stored.effectiveVenue === artifact.effectiveVenue
      && stored.messageHash === artifact.messageHash
      && stored.buildFingerprint === artifact.buildFingerprint
      && stored.snapshotFingerprint === artifact.snapshotFingerprint
      && stored.quoteFingerprint === artifact.quoteFingerprint
      && stored.quoteObservedAtMs === artifact.quoteObservedAtMs
      && stored.quoteExpiresAtMs === artifact.quoteExpiresAtMs
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

async function validateSignedSimulationBinding(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
  evidence: ExecutionLiveSignedSimulationEvidenceV1,
): Promise<void> {
  const row = exactRow(singleRow(await client.query(`SELECT
    evidence_id,artifact_id,intent_id,attempt_number,provider_id,
    message_hash,build_fingerprint,snapshot_fingerprint,blockhash,
    last_valid_block_height::TEXT AS last_valid_block_height,
    simulation_slot::TEXT AS simulation_slot,units_consumed::TEXT AS units_consumed,
    simulated_fee_payer_lamport_debit::TEXT AS fee_payer_lamport_debit,
    simulated_base_delta_raw::TEXT AS base_delta_raw,
    simulated_quote_delta_raw::TEXT AS quote_delta_raw
    FROM execution_live_unsigned_simulation_evidence WHERE evidence_id=$1`, [
    evidence.unsignedSimulationEvidenceId,
  ])), [
    'evidence_id', 'artifact_id', 'intent_id', 'attempt_number', 'provider_id',
    'message_hash', 'build_fingerprint', 'snapshot_fingerprint',
    'blockhash', 'last_valid_block_height', 'simulation_slot', 'units_consumed',
    'fee_payer_lamport_debit', 'base_delta_raw', 'quote_delta_raw',
  ] as const);
  const unsignedSlot = unsignedBigint(row.simulation_slot);
  const unsignedUnits = unsignedBigint(row.units_consumed);
  const unsignedFee = unsignedBigint(row.fee_payer_lamport_debit);
  const unsignedBase = signedBigint(row.base_delta_raw);
  const unsignedQuote = signedBigint(row.quote_delta_raw);
  const commonMismatch = row.evidence_id !== evidence.unsignedSimulationEvidenceId
    || row.artifact_id !== artifact.artifactId
    || row.intent_id !== artifact.intentId
    || integer(row.attempt_number) !== artifact.attemptNumber
    || row.provider_id !== artifact.providerId || evidence.providerId !== artifact.providerId
    || row.message_hash !== artifact.messageHash
    || row.build_fingerprint !== artifact.buildFingerprint
    || row.snapshot_fingerprint !== artifact.snapshotFingerprint
    || row.blockhash !== artifact.blockhash
    || unsignedBigint(row.last_valid_block_height) !== artifact.lastValidBlockHeight
    || evidence.signedTransactionHash !== artifact.signedTransactionHash
    || evidence.simulationSlot < unsignedSlot || evidence.unitsConsumed < unsignedUnits
    || evidence.feePayerLamportDebit < unsignedFee
    || evidence.observedAtMs < artifact.signedAtMs;
  const deltaMismatch = artifact.side === 'BUY'
    ? unsignedBase <= 0n || unsignedQuote >= 0n
      || evidence.baseDeltaRaw <= 0n || evidence.baseDeltaRaw > unsignedBase
      || evidence.quoteDeltaRaw >= 0n || evidence.quoteDeltaRaw > unsignedQuote
    : unsignedBase >= 0n || unsignedQuote <= 0n
      || evidence.baseDeltaRaw >= 0n || evidence.baseDeltaRaw < unsignedBase
      || evidence.quoteDeltaRaw <= 0n || evidence.quoteDeltaRaw > unsignedQuote;
  if (commonMismatch || deltaMismatch) throw failure('CONFLICT');
}

async function persistUnsignedSimulationEvidence(
  client: DatabaseClient,
  input: ExecutionLivePersistSignedInputV1,
): Promise<void> {
  const artifact = input.artifact;
  const simulation = input.unsignedSimulation;
  const identity = createExecutionLiveUnsignedSimulationEvidenceIdentity(artifact, simulation);
  const existing = await client.query(`SELECT payload_version,evidence_fingerprint,artifact_id,
    intent_id,attempt_number,provider_id,snapshot_fingerprint,build_fingerprint,message_hash,
    blockhash,last_valid_block_height::TEXT AS last_valid_block_height,
    blockhash_context_slot::TEXT AS blockhash_context_slot,
    fee_context_slot::TEXT AS fee_context_slot,
    estimated_fee_lamports::TEXT AS estimated_fee_lamports,
    simulation_slot::TEXT AS simulation_slot,
    simulated_fee_payer_lamport_debit::TEXT AS simulated_fee_payer_lamport_debit,
    units_consumed::TEXT AS units_consumed,
    simulated_base_delta_raw::TEXT AS simulated_base_delta_raw,
    simulated_quote_delta_raw::TEXT AS simulated_quote_delta_raw,
    logs_fingerprint,logs_line_count,
    trunc(EXTRACT(EPOCH FROM recorded_at)*1000)::TEXT AS recorded_at_ms
    FROM execution_live_unsigned_simulation_evidence WHERE evidence_id=$1`, [
    identity.evidenceId,
  ]);
  if (existing.rows.length > 1) throw failure('INVALID_DATA');
  if (existing.rows.length === 1) {
    if (!sameUnsignedSimulationEvidence(existing.rows[0] ?? {}, input, identity)) {
      throw failure('CONFLICT');
    }
    return;
  }
  const inserted = await client.query(`INSERT INTO execution_live_unsigned_simulation_evidence (
    evidence_id,payload_version,evidence_fingerprint,artifact_id,intent_id,attempt_number,
    provider_id,snapshot_fingerprint,build_fingerprint,message_hash,blockhash,
    last_valid_block_height,blockhash_context_slot,fee_context_slot,estimated_fee_lamports,
    simulation_slot,simulated_fee_payer_lamport_debit,units_consumed,
    simulated_base_delta_raw,simulated_quote_delta_raw,logs_fingerprint,logs_line_count,
    recorded_at
  ) VALUES ($1,1,$2,$3,$4,$5::INTEGER,$6,$7,$8,$9,$10,$11::BIGINT,$12::BIGINT,
    $13::BIGINT,$14::NUMERIC,$15::BIGINT,$16::NUMERIC,$17::BIGINT,$18::NUMERIC,
    $19::NUMERIC,$20,$21::INTEGER,
    TIMESTAMPTZ 'epoch'+($22::BIGINT*INTERVAL '1 millisecond'))`, [
    identity.evidenceId, identity.evidenceFingerprint, artifact.artifactId,
    artifact.intentId, artifact.attemptNumber, artifact.providerId,
    simulation.snapshotFingerprint, simulation.buildFingerprint, simulation.messageHash,
    simulation.blockhash, simulation.lastValidBlockHeight.toString(),
    simulation.blockhashContextSlot.toString(), simulation.feeContextSlot.toString(),
    simulation.estimatedFeeLamports.toString(), simulation.simulationSlot.toString(),
    simulation.simulatedFeePayerLamportDebit.toString(), simulation.unitsConsumed.toString(),
    simulation.simulatedBaseDeltaRaw.toString(), simulation.simulatedQuoteDeltaRaw.toString(),
    simulation.logsFingerprint, simulation.logsLineCount, artifact.signedAtMs,
  ]);
  if (inserted.rowCount !== 1) throw failure('CONFLICT');
}

function sameUnsignedSimulationEvidence(
  rowValue: Row,
  input: ExecutionLivePersistSignedInputV1,
  identity: Readonly<{ readonly evidenceId: string; readonly evidenceFingerprint: string }>,
): boolean {
  try {
    const row = exactRow(rowValue, [
      'payload_version', 'evidence_fingerprint', 'artifact_id', 'intent_id',
      'attempt_number', 'provider_id', 'snapshot_fingerprint', 'build_fingerprint',
      'message_hash', 'blockhash', 'last_valid_block_height', 'blockhash_context_slot',
      'fee_context_slot', 'estimated_fee_lamports', 'simulation_slot',
      'simulated_fee_payer_lamport_debit', 'units_consumed', 'simulated_base_delta_raw',
      'simulated_quote_delta_raw', 'logs_fingerprint', 'logs_line_count', 'recorded_at_ms',
    ] as const);
    const artifact = input.artifact;
    const simulation = input.unsignedSimulation;
    return integer(row.payload_version) === 1
      && row.evidence_fingerprint === identity.evidenceFingerprint
      && row.artifact_id === artifact.artifactId && row.intent_id === artifact.intentId
      && integer(row.attempt_number) === artifact.attemptNumber
      && row.provider_id === artifact.providerId
      && row.snapshot_fingerprint === simulation.snapshotFingerprint
      && row.build_fingerprint === simulation.buildFingerprint
      && row.message_hash === simulation.messageHash && row.blockhash === simulation.blockhash
      && unsignedBigint(row.last_valid_block_height) === simulation.lastValidBlockHeight
      && unsignedBigint(row.blockhash_context_slot) === simulation.blockhashContextSlot
      && unsignedBigint(row.fee_context_slot) === simulation.feeContextSlot
      && unsignedBigint(row.estimated_fee_lamports) === simulation.estimatedFeeLamports
      && unsignedBigint(row.simulation_slot) === simulation.simulationSlot
      && unsignedBigint(row.simulated_fee_payer_lamport_debit)
        === simulation.simulatedFeePayerLamportDebit
      && unsignedBigint(row.units_consumed) === simulation.unitsConsumed
      && signedBigint(row.simulated_base_delta_raw) === simulation.simulatedBaseDeltaRaw
      && signedBigint(row.simulated_quote_delta_raw) === simulation.simulatedQuoteDeltaRaw
      && row.logs_fingerprint === simulation.logsFingerprint
      && integer(row.logs_line_count) === simulation.logsLineCount
      && timestampText(row.recorded_at_ms) === artifact.signedAtMs;
  } catch { return false; }
}

async function insertSignedSimulationEvidence(
  client: DatabaseClient,
  evidence: ExecutionLiveSignedSimulationEvidenceV1,
): Promise<void> {
  const inserted = await client.query(`INSERT INTO execution_signed_simulation_evidence (
    evidence_id,payload_version,evidence_fingerprint,artifact_id,
    unsigned_simulation_evidence_id,signed_transaction_hash,provider_id,simulation_slot,
    units_consumed,fee_payer_lamport_debit,base_delta_raw,quote_delta_raw,
    logs_fingerprint,logs_line_count,observed_at
  ) VALUES ($1,1,$2,$3,$4,$5,$6,$7::BIGINT,$8::BIGINT,$9::NUMERIC,$10::NUMERIC,
    $11::NUMERIC,$12,$13::INTEGER,
    TIMESTAMPTZ 'epoch'+($14::BIGINT*INTERVAL '1 millisecond'))`, [
    `execution_signed_simulation_evidence_${evidence.evidenceFingerprint}`,
    evidence.evidenceFingerprint, evidence.artifactId,
    evidence.unsignedSimulationEvidenceId, evidence.signedTransactionHash,
    evidence.providerId, evidence.simulationSlot.toString(), evidence.unitsConsumed.toString(),
    evidence.feePayerLamportDebit.toString(), evidence.baseDeltaRaw.toString(),
    evidence.quoteDeltaRaw.toString(), evidence.logsFingerprint, evidence.logsLineCount,
    evidence.observedAtMs,
  ]);
  if (inserted.rowCount !== 1) throw failure('CONFLICT');
}

async function exactSignedSimulationReplay(
  client: DatabaseClient,
  evidence: ExecutionLiveSignedSimulationEvidenceV1,
): Promise<boolean> {
  const result = await client.query(`SELECT payload_version,artifact_id,
    unsigned_simulation_evidence_id,signed_transaction_hash,provider_id,
    simulation_slot::TEXT AS simulation_slot,units_consumed::TEXT AS units_consumed,
    fee_payer_lamport_debit::TEXT AS fee_payer_lamport_debit,
    base_delta_raw::TEXT AS base_delta_raw,quote_delta_raw::TEXT AS quote_delta_raw,
    logs_fingerprint,logs_line_count,
    trunc(EXTRACT(EPOCH FROM observed_at)*1000)::TEXT AS observed_at_ms,
    evidence_fingerprint
    FROM execution_signed_simulation_evidence WHERE artifact_id=$1`, [evidence.artifactId]);
  if (result.rows.length !== 1) return false;
  const row = exactRow(result.rows[0] ?? {}, [
    'payload_version', 'artifact_id', 'unsigned_simulation_evidence_id',
    'signed_transaction_hash', 'provider_id', 'simulation_slot', 'units_consumed',
    'fee_payer_lamport_debit', 'base_delta_raw', 'quote_delta_raw',
    'logs_fingerprint', 'logs_line_count', 'observed_at_ms', 'evidence_fingerprint',
  ] as const);
  return integer(row.payload_version) === evidence.payloadVersion
    && row.artifact_id === evidence.artifactId
    && row.unsigned_simulation_evidence_id === evidence.unsignedSimulationEvidenceId
    && row.signed_transaction_hash === evidence.signedTransactionHash
    && row.provider_id === evidence.providerId
    && unsignedBigint(row.simulation_slot) === evidence.simulationSlot
    && unsignedBigint(row.units_consumed) === evidence.unitsConsumed
    && unsignedBigint(row.fee_payer_lamport_debit) === evidence.feePayerLamportDebit
    && signedBigint(row.base_delta_raw) === evidence.baseDeltaRaw
    && signedBigint(row.quote_delta_raw) === evidence.quoteDeltaRaw
    && row.logs_fingerprint === evidence.logsFingerprint
    && integer(row.logs_line_count) === evidence.logsLineCount
    && timestampText(row.observed_at_ms) === evidence.observedAtMs
    && row.evidence_fingerprint === evidence.evidenceFingerprint;
}

function validateBuySubmissionGate(
  row: Row,
  claim: ClaimedExecutionIntent,
  input: Readonly<{
    readonly expectedRevision: bigint;
    readonly runtime: ExecutionLiveRuntimeBindingV1;
    readonly blockhashValidity: ExecutionBlockhashValidityEvidenceV1;
  }>,
): void {
  const nowMs = timestampText(row.now_ms);
  if (row.lease_owner !== claim.leaseOwner || row.lease_token !== claim.leaseToken
    || timestampText(row.lease_expires_at_ms) <= nowMs) throw failure('LEASE_LOST');
  if (row.control_state !== 'RUNNING') throw failure('CONTROL_STOPPED');
  const artifact = artifactFromRow(row);
  const reservationAmount = unsignedBigint(row.reservation_amount_raw);
  const intentAmount = unsignedBigint(row.intent_quote_amount_raw);
  const admissionAmount = unsignedBigint(row.admission_quote_amount_raw);
  const capital = unsignedBigint(row.reconciled_capital_raw);
  const reservedExposure = unsignedBigint(row.reserved_exposure_raw);
  const maximumCapital = unsignedBigint(row.maximum_capital_lamports);
  const maximumExposureBps = unsignedBigint(row.maximum_exposure_bps);
  const openPositions = integer(row.open_positions);
  const maximumOpenPositions = integer(row.maximum_open_positions);
  if (typeof row.admission_risk_revision !== 'string'
    || typeof row.admission_drawdown_raw !== 'string'
    || typeof row.admission_provider_local_usage_units !== 'string'
    || typeof row.admission_provider_rate_limit_count !== 'string'
    || typeof row.conservative_drawdown_raw !== 'string'
    || typeof row.provider_local_usage_units !== 'string'
    || typeof row.provider_rate_limit_count !== 'string') {
    throw failure('PREFLIGHT_EXPIRED');
  }
  const admissionRiskRevision = unsignedBigint(row.admission_risk_revision);
  const admissionDrawdown = unsignedBigint(row.admission_drawdown_raw);
  const admissionProviderUsage = unsignedBigint(row.admission_provider_local_usage_units);
  const admissionProviderRateLimits = unsignedBigint(row.admission_provider_rate_limit_count);
  const currentRiskRevision = unsignedBigint(row.risk_revision);
  const currentDrawdown = unsignedBigint(row.conservative_drawdown_raw);
  const currentProviderUsage = unsignedBigint(row.provider_local_usage_units);
  const currentProviderRateLimits = unsignedBigint(row.provider_rate_limit_count);
  if (row.intent_status !== 'SIGNED_NOT_SUBMITTED'
    || row.intent_side !== 'BUY' || row.attempt_status !== 'STARTED'
    || timestampText(row.intent_expires_at_ms) <= nowMs
    || row.state !== 'SIGNED_SIMULATED'
    || unsignedBigint(row.state_revision) !== input.expectedRevision
    || row.generation_retired_at !== null
    || artifact.reservationId === null || row.reservation_id !== artifact.reservationId
    || row.armament_state !== 'LOCKED'
    || timestampText(row.armament_expires_at_ms) <= nowMs
    || timestampText(row.qualification_expires_at_ms) <= nowMs
    || row.armament_qualification_id !== row.qualification_id
    || row.armament_qualification_fingerprint !== row.qualification_fingerprint
    || row.armament_generation_id !== artifact.generationId
    || row.qualification_generation_id !== artifact.generationId
    || row.reservation_state !== 'RESERVED'
    || row.reservation_intent_id !== artifact.intentId
    || row.reservation_generation_id !== artifact.generationId
    || row.reservation_side !== 'BUY'
    || row.reservation_mint !== row.intent_mint
    || row.reservation_quote_mint !== row.intent_quote_mint
    || row.reservation_intent_fingerprint !== riskIntentFingerprint(row, intentAmount)
    || row.admission_report_id === null
    || row.admission_decision !== 'ADMITTED'
    || row.admission_quota_state !== 'NORMAL'
    || row.admission_intent_id !== artifact.intentId
    || row.admission_generation_id !== artifact.generationId
    || row.admission_policy_fingerprint !== row.reservation_policy_fingerprint
    || row.admission_wallet_snapshot_fingerprint !== row.wallet_snapshot_fingerprint
    || row.admission_provider_snapshot_fingerprint !== row.provider_snapshot_fingerprint
    || reservationAmount !== intentAmount || admissionAmount !== intentAmount
    || currentRiskRevision !== admissionRiskRevision
    || currentDrawdown > admissionDrawdown
    || currentProviderUsage !== admissionProviderUsage
    || currentProviderRateLimits !== admissionProviderRateLimits
    || reservationAmount > maximumCapital
    || reservedExposure < reservationAmount
    || openPositions < 1 || openPositions > maximumOpenPositions
    || reservedExposure * 10_000n > capital * maximumExposureBps
    || integer(row.consumed_buys) < 1
    || integer(row.consumed_buys) > integer(row.maximum_buys)
    || row.unknown_block !== false || row.unknown_reservation_held !== false
    || row.snapshot_provider_id !== artifact.providerId
    || row.provider_superseded_at !== null
    || timestampText(row.provider_expires_at_ms) <= nowMs
    || !runtimeMatches(row, input.runtime)
    || !qualificationRuntimeMatches(row, input.runtime)
    || !freshArtifactProof(artifact, row, input.blockhashValidity, nowMs)) {
    throw failure('PREFLIGHT_EXPIRED');
  }
}

function validRuntimeBinding(value: unknown): value is ExecutionLiveRuntimeBindingV1 {
  if (!plainExactDataObject(value, RUNTIME_BINDING_KEYS)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return record.payloadVersion === 1
    && typeof record.phase === 'string'
    && ['CANARY', 'MICRO_LIVE', 'PILOT'].includes(record.phase)
    && typeof record.buildHash === 'string' && HASH.test(record.buildHash)
    && typeof record.configurationFingerprint === 'string'
    && HASH.test(record.configurationFingerprint)
    && typeof record.strategyFingerprint === 'string' && HASH.test(record.strategyFingerprint)
    && typeof record.walletPublicKey === 'string' && PUBLIC_KEY.test(record.walletPublicKey)
    && record.cluster === 'mainnet-beta'
    && typeof record.expectedGenesisHash === 'string'
    && PUBLIC_KEY.test(record.expectedGenesisHash)
    && record.observedGenesisHash === record.expectedGenesisHash
    && typeof record.providerId === 'string' && PROVIDER_ID.test(record.providerId);
}

function plainExactDataObject(value: unknown, keys: readonly string[]): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string')
    || keys.some((key) => !actual.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
  });
}

function validBlockhashEvidence(value: unknown): value is ExecutionBlockhashValidityEvidenceV1 {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return record.payloadVersion === 1
    && typeof record.providerId === 'string' && PROVIDER_ID.test(record.providerId)
    && typeof record.blockhash === 'string' && PUBLIC_KEY.test(record.blockhash)
    && record.valid === true
    && unsigned(record.observedBlockHeight) && unsigned(record.contextSlot)
    && validTimestamp(record.observedAtMs);
}

function runtimeMatches(row: Row, runtime: ExecutionLiveRuntimeBindingV1): boolean {
  return row.generation_wallet_public_key === runtime.walletPublicKey
    && row.generation_cluster === runtime.cluster
    && row.generation_genesis_hash === runtime.observedGenesisHash
    && row.armament_phase === runtime.phase
    && row.armament_build_hash === runtime.buildHash
    && row.armament_configuration_fingerprint === runtime.configurationFingerprint
    && row.armament_strategy_fingerprint === runtime.strategyFingerprint
    && row.armament_wallet_public_key === runtime.walletPublicKey
    && row.armament_cluster === runtime.cluster
    && row.armament_genesis_hash === runtime.observedGenesisHash
    && row.armament_provider_id === runtime.providerId;
}

function qualificationRuntimeMatches(
  row: Row,
  runtime: ExecutionLiveRuntimeBindingV1,
): boolean {
  return row.qualification_phase === runtime.phase
    && row.qualification_build_hash === runtime.buildHash
    && row.qualification_configuration_fingerprint === runtime.configurationFingerprint
    && row.qualification_strategy_fingerprint === runtime.strategyFingerprint
    && row.qualification_wallet_public_key === runtime.walletPublicKey
    && row.qualification_cluster === runtime.cluster
    && row.qualification_genesis_hash === runtime.observedGenesisHash
    && row.qualification_provider_id === runtime.providerId;
}

function riskIntentFingerprint(row: Row, quoteAmountRaw: bigint): string {
  if (typeof row.intent_id !== 'string' || typeof row.intent_logical_order_key !== 'string'
    || typeof row.intent_decision_fingerprint !== 'string'
    || !HASH.test(row.intent_decision_fingerprint)) throw failure('INVALID_DATA');
  const digest = createHash('sha256');
  for (const part of [
    'execution-intent-risk-v1', row.intent_id, row.intent_logical_order_key,
    row.intent_decision_fingerprint, quoteAmountRaw,
  ] as const) {
    const textValue = String(part);
    digest.update(String(Buffer.byteLength(textValue)));
    digest.update(':');
    digest.update(textValue);
    digest.update('|');
  }
  return digest.digest('hex');
}

function freshArtifactProof(
  artifact: SignedTransactionArtifactV1,
  row: Row,
  blockhash: ExecutionBlockhashValidityEvidenceV1,
  nowMs: number,
): boolean {
  return timestampText(row.quote_observed_at_ms) === artifact.quoteObservedAtMs
    && timestampText(row.quote_expires_at_ms) === artifact.quoteExpiresAtMs
    && artifact.quoteExpiresAtMs > nowMs
    && blockhash.providerId === artifact.providerId
    && blockhash.blockhash === artifact.blockhash
    && blockhash.observedBlockHeight <= artifact.lastValidBlockHeight
    && blockhash.observedAtMs <= nowMs
    && blockhash.observedAtMs > nowMs - BLOCKHASH_VALIDITY_MAX_AGE_MS;
}

async function insertSubmissionPreflightEvidence(
  client: DatabaseClient,
  artifact: SignedTransactionArtifactV1,
  row: Row,
  input: Readonly<{
    readonly runtime: ExecutionLiveRuntimeBindingV1;
    readonly blockhashValidity: ExecutionBlockhashValidityEvidenceV1;
  }>,
  authorizedAtMs: number,
): Promise<void> {
  const buy = artifact.side === 'BUY';
  const armamentRevision = buy ? unsignedBigint(row.armament_revision).toString() : null;
  const admissionRiskRevision = buy
    ? unsignedBigint(row.admission_risk_revision).toString() : null;
  const riskRevision = buy ? unsignedBigint(row.risk_revision).toString() : null;
  const admissionDrawdown = buy ? unsignedBigint(row.admission_drawdown_raw).toString() : null;
  const currentDrawdown = buy ? unsignedBigint(row.conservative_drawdown_raw).toString() : null;
  const admissionProviderUsage = buy
    ? unsignedBigint(row.admission_provider_local_usage_units).toString() : null;
  const currentProviderUsage = buy
    ? unsignedBigint(row.provider_local_usage_units).toString() : null;
  const admissionProviderRateLimits = buy
    ? unsignedBigint(row.admission_provider_rate_limit_count).toString() : null;
  const currentProviderRateLimits = buy
    ? unsignedBigint(row.provider_rate_limit_count).toString() : null;
  const reservationAmount = buy ? unsignedBigint(row.reservation_amount_raw).toString() : null;
  const capital = buy ? unsignedBigint(row.reconciled_capital_raw).toString() : null;
  const reservedExposure = buy ? unsignedBigint(row.reserved_exposure_raw).toString() : null;
  const openPositions = buy ? integer(row.open_positions) : null;
  const maximumCapital = buy ? unsignedBigint(row.maximum_capital_lamports).toString() : null;
  const maximumExposureBps = buy ? unsignedBigint(row.maximum_exposure_bps).toString() : null;
  const maximumOpenPositions = buy ? integer(row.maximum_open_positions) : null;
  const fingerprintValue = [
    'execution-submission-preflight-v1', artifact.artifactId, artifact.intentId,
    artifact.attemptNumber, artifact.generationId, artifact.armamentId,
    artifact.reservationId, artifact.providerId, input.runtime.phase,
    input.runtime.buildHash, input.runtime.configurationFingerprint,
    input.runtime.strategyFingerprint, input.runtime.walletPublicKey,
    input.runtime.cluster, input.runtime.observedGenesisHash, armamentRevision,
    admissionRiskRevision, riskRevision, admissionDrawdown, currentDrawdown,
    admissionProviderUsage, currentProviderUsage,
    admissionProviderRateLimits, currentProviderRateLimits,
    reservationAmount, capital, reservedExposure, openPositions,
    maximumCapital, maximumExposureBps, maximumOpenPositions,
    artifact.quoteFingerprint, artifact.quoteObservedAtMs, artifact.quoteExpiresAtMs,
    artifact.blockhash, artifact.lastValidBlockHeight.toString(),
    input.blockhashValidity.observedBlockHeight.toString(),
    input.blockhashValidity.contextSlot.toString(), input.blockhashValidity.observedAtMs,
    authorizedAtMs,
  ] as const;
  const gateFingerprint = hash(fingerprintValue);
  const result = await client.query(`INSERT INTO execution_submission_preflight_evidence (
    gate_id,payload_version,gate_fingerprint,artifact_id,intent_id,attempt_number,
    generation_id,armament_id,reservation_id,provider_id,phase,build_hash,
    configuration_fingerprint,strategy_fingerprint,wallet_public_key,cluster,genesis_hash,
    armament_revision,admission_risk_revision,risk_revision,
    admission_drawdown_raw,conservative_drawdown_raw,
    admission_provider_local_usage_units,provider_local_usage_units,
    admission_provider_rate_limit_count,provider_rate_limit_count,
    reservation_amount_raw,reconciled_capital_raw,
    reserved_exposure_raw,open_positions,maximum_capital_lamports,maximum_exposure_bps,
    maximum_open_positions,quote_fingerprint,quote_observed_at,quote_expires_at,blockhash,
    last_valid_block_height,observed_block_height,blockhash_validity_context_slot,
    blockhash_validated_at,authorized_at
  ) VALUES ($1,1,$2,$3,$4,$5::INTEGER,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
    $17::BIGINT,$18::BIGINT,$19::BIGINT,$20::NUMERIC,$21::NUMERIC,
    $22::NUMERIC,$23::NUMERIC,$24::BIGINT,$25::BIGINT,
    $26::NUMERIC,$27::NUMERIC,$28::NUMERIC,$29::INTEGER,
    $30::NUMERIC,$31::NUMERIC,$32::INTEGER,$33,
    TIMESTAMPTZ 'epoch'+($34::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($35::BIGINT*INTERVAL '1 millisecond'),$36,$37::BIGINT,
    $38::BIGINT,$39::BIGINT,
    TIMESTAMPTZ 'epoch'+($40::BIGINT*INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch'+($41::BIGINT*INTERVAL '1 millisecond'))`, [
    `execution_submission_preflight_${gateFingerprint}`, gateFingerprint,
    artifact.artifactId, artifact.intentId, artifact.attemptNumber, artifact.generationId,
    buy ? artifact.armamentId : null, buy ? artifact.reservationId : null,
    artifact.providerId, input.runtime.phase, input.runtime.buildHash,
    input.runtime.configurationFingerprint, input.runtime.strategyFingerprint,
    input.runtime.walletPublicKey, input.runtime.cluster, input.runtime.observedGenesisHash,
    armamentRevision, admissionRiskRevision, riskRevision, admissionDrawdown, currentDrawdown,
    admissionProviderUsage, currentProviderUsage,
    admissionProviderRateLimits, currentProviderRateLimits,
    reservationAmount, capital, reservedExposure, openPositions,
    maximumCapital, maximumExposureBps, maximumOpenPositions,
    artifact.quoteFingerprint, artifact.quoteObservedAtMs, artifact.quoteExpiresAtMs,
    artifact.blockhash, artifact.lastValidBlockHeight.toString(),
    input.blockhashValidity.observedBlockHeight.toString(),
    input.blockhashValidity.contextSlot.toString(), input.blockhashValidity.observedAtMs,
    authorizedAtMs,
  ]);
  if (result.rowCount !== 1) throw failure('CONFLICT');
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
  artifact: ExecutionLiveArtifactReferenceV1,
  previousState: 'PERSISTED' | 'SIGNED_SIMULATED' | 'SUBMISSION_STARTED'
    | 'ACCEPTED' | 'AMBIGUOUS' | 'CONFIRMED',
  nextState: 'SIGNED_SIMULATED' | 'SUBMISSION_STARTED' | 'ACCEPTED' | 'AMBIGUOUS'
    | 'CONFIRMED' | 'RECONCILED' | 'REVOKED_NO_SEND',
  reasonCode: 'SIGNED_SIMULATION_SUCCEEDED' | 'SUBMISSION_STARTED'
    | 'SUBMISSION_ACCEPTED' | 'SUBMISSION_AMBIGUOUS'
    | 'SUBMISSION_SIGNATURE_MISMATCH' | 'CONFIRMATION_OBSERVED'
    | 'RECONCILIATION_REQUIRED' | 'RECONCILIATION_PROVED_NO_EFFECT' | 'INTENT_SUCCEEDED'
    | 'PRE_SUBMISSION_REVOKED_NO_SEND',
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
  artifact: ExecutionLiveArtifactReferenceV1,
  previousStatus: 'SIGNED_NOT_SUBMITTED' | 'SUBMITTED' | 'CONFIRMED'
    | 'UNKNOWN_REQUIRES_RECONCILIATION',
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
  isReplay: boolean,
): Promise<Readonly<{
  readonly artifact: ExecutionLiveArtifactReferenceV1;
  readonly position: ExecutionLivePositionV1 | null;
  readonly exitAuthorization: ExecutionExitAuthorizationV1 | null;
}>> {
  const row = singleRow(await client.query(`SELECT ${ARTIFACT_REFERENCE_COLUMNS},
    trunc(EXTRACT(EPOCH FROM transaction.signed_at)*1000)::TEXT AS signed_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.quote_observed_at)*1000)::TEXT
      AS quote_observed_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.quote_expires_at)*1000)::TEXT
      AS quote_expires_at_ms,
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
  const artifact = artifactReferenceFromRow(row);
  const revision = unsignedBigint(row.state_revision);
  if (row.state === 'RECONCILED') {
    if (isReplay && (evidence.result === 'UNKNOWN' || evidence.result === 'MISMATCH')) {
      return Object.freeze({ artifact, position: null, exitAuthorization: null });
    }
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
      position.state_revision::TEXT AS position_revision,
      position.entry_reconciliation_fingerprint,
      exit_auth.authorization_id,exit_auth.state AS authorization_state,
      exit_auth.state_revision::TEXT AS authorization_revision
      FROM execution_live_positions position
      JOIN execution_exit_authorizations exit_auth
        ON exit_auth.position_id=position.position_id
      WHERE position.buy_intent_id=$1`, [artifact.intentId])), [
      'position_id', 'position_state', 'entry_reconciliation_fingerprint',
      'position_revision', 'authorization_id', 'authorization_state',
      'authorization_revision',
    ] as const);
    const positionState = livePositionState(existing.position_state);
    const authorizationState = exitAuthorizationState(existing.authorization_state);
    const validLifecycle = (positionState === 'OPEN' && authorizationState === 'ACTIVE')
      || (positionState === 'EXIT_PENDING'
        && (authorizationState === 'ACTIVE' || authorizationState === 'LOCKED'))
      || (positionState === 'CLOSED' && authorizationState === 'CONSUMED')
      || (positionState === 'UNKNOWN' && authorizationState === 'LOCKED');
    if (existing.position_id !== replayed.position.positionId
      || existing.entry_reconciliation_fingerprint !== evidence.evidenceFingerprint
      || existing.authorization_id !== replayed.authorization.authorizationId
      || !validLifecycle) throw failure('CONFLICT');
    return Object.freeze({
      artifact,
      position: Object.freeze({
        ...replayed.position,
        state: positionState,
        stateRevision: unsignedBigint(existing.position_revision),
      }),
      exitAuthorization: Object.freeze({
        ...replayed.authorization,
        state: authorizationState,
        stateRevision: unsignedBigint(existing.authorization_revision),
      }),
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
    || evidence.observedSlot === null
    || evidence.baseDeltaRaw <= 0n || evidence.quoteDeltaRaw >= 0n
    || !['ACCEPTED', 'AMBIGUOUS', 'CONFIRMED'].includes(String(row.state))) {
    throw failure('CONFLICT');
  }
  let confirmedRevision = revision;
  if (row.state !== 'CONFIRMED') {
    const confirmed = await client.query(`UPDATE execution_signed_transactions SET
      state='CONFIRMED',state_revision=$2::BIGINT,
      submitted_at=COALESCE(submitted_at,
        TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')),
      confirmed_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
      confirmed_slot=$4::BIGINT
      WHERE artifact_id=$1 AND state=$5 AND state_revision=$6::BIGINT`, [
      artifact.artifactId, (revision + 1n).toString(), finalizedAtMs,
      evidence.observedSlot.toString(), row.state, revision.toString(),
    ]);
    if (confirmed.rowCount !== 1) throw failure('CONFLICT');
    await insertLiveStateEvent(
      client, artifact, row.state as 'ACCEPTED' | 'AMBIGUOUS', 'CONFIRMED',
      'CONFIRMATION_OBSERVED', finalizedAtMs,
    );
    confirmedRevision += 1n;
  }
  const updated = await client.query(`UPDATE execution_signed_transactions SET
    state='RECONCILED',state_revision=$2::BIGINT,
    reconciled_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond')
    WHERE artifact_id=$1 AND state='CONFIRMED' AND state_revision=$4::BIGINT`, [
    artifact.artifactId, (confirmedRevision + 1n).toString(), finalizedAtMs,
    confirmedRevision.toString(),
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
  artifact: ExecutionLiveArtifactReferenceV1,
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
  const row = singleRow(await client.query(`SELECT ${ARTIFACT_REFERENCE_COLUMNS},
    trunc(EXTRACT(EPOCH FROM transaction.signed_at)*1000)::TEXT AS signed_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.quote_observed_at)*1000)::TEXT
      AS quote_observed_at_ms,
    trunc(EXTRACT(EPOCH FROM transaction.quote_expires_at)*1000)::TEXT
      AS quote_expires_at_ms,
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
    FOR UPDATE OF transaction,intent,attempt,exit_auth,position,risk,armament`, [
    evidence.intentId, evidence.attemptNumber,
  ]));
  const artifact = artifactReferenceFromRow(row);
  const existing = await client.query(`SELECT evidence_id,evidence_fingerprint,result,
    intent_id,attempt_number,side,resolved_by_evidence_id,
    trunc(EXTRACT(EPOCH FROM observed_at)*1000)::TEXT AS observed_at_ms
    FROM execution_reconciliation_evidence
    WHERE intent_id=$1 AND attempt_number=$2
    ORDER BY observed_at,evidence_id FOR UPDATE`, [evidence.intentId, evidence.attemptNumber]);
  const priorEvidence = existing.rows.map((candidate) => exactRow(candidate, [
    'evidence_id', 'evidence_fingerprint', 'result', 'intent_id', 'attempt_number', 'side',
    'resolved_by_evidence_id', 'observed_at_ms',
  ] as const));
  const replay = priorEvidence.find((candidate) => candidate.evidence_id === evidence.evidenceId);
  if (replay !== undefined) {
    if (replay.evidence_fingerprint !== evidence.evidenceFingerprint
      || replay.result !== evidence.result || replay.intent_id !== evidence.intentId
      || integer(replay.attempt_number) !== evidence.attemptNumber || replay.side !== 'SELL') {
      throw failure('CONFLICT');
    }
    return Object.freeze({
      payloadVersion: 1,
      result: evidence.result,
      artifact,
      position: null,
      exitAuthorization: null,
    });
  }
  if (priorEvidence.length > 0) {
    const latestObservedAtMs = priorEvidence.reduce(
      (latest, prior) => Math.max(latest, timestampText(prior.observed_at_ms)),
      0,
    );
    if (priorEvidence.some((prior) => prior.result !== 'UNKNOWN'
      || prior.resolved_by_evidence_id !== null)
      || evidence.observedAtMs <= latestObservedAtMs) throw failure('CONFLICT');
  }
  const finalizedAtMs = evidence.finalizedAtMs;
  const initialArtifactState = String(row.state);
  const initialIntentStatus = String(row.intent_status);
  const terminal = evidence.result === 'MATCHED' || evidence.result === 'NO_EFFECT';
  const matchedAmounts = evidence.result !== 'MATCHED'
    || (evidence.observedSlot !== null && evidence.baseDeltaRaw < 0n
      && -evidence.baseDeltaRaw === unsignedBigint(row.remaining_base_raw)
      && evidence.quoteDeltaRaw > 0n);
  if ((terminal && finalizedAtMs === null) || !matchedAmounts
    || artifact.side !== 'SELL' || artifact.exitAuthorizationId === null
    || row.intent_id !== claim.intent.id
    || !['SUBMITTED', 'UNKNOWN_REQUIRES_RECONCILIATION', 'CONFIRMED']
      .includes(initialIntentStatus)
    || row.lease_owner !== claim.leaseOwner || row.lease_token !== claim.leaseToken
    || timestampText(row.lease_expires_at_ms) <= timestampText(row.now_ms)
    || !['ACCEPTED', 'AMBIGUOUS', 'CONFIRMED'].includes(initialArtifactState)
    || row.attempt_status !== 'STARTED'
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
    || row.authorization_state !== 'LOCKED'
    || !['EXIT_PENDING', 'UNKNOWN'].includes(String(row.position_state))
    || row.armament_state !== 'LOCKED') throw failure('CONFLICT');
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
    CASE WHEN $26::BIGINT IS NULL THEN NULL ELSE TIMESTAMPTZ 'epoch'
      +($26::BIGINT*INTERVAL '1 millisecond') END,$27,$28,
    CASE WHEN $27 IN ('MATCHED','NO_EFFECT') THEN TIMESTAMPTZ 'epoch'
      +(($26::BIGINT+14400000)*INTERVAL '1 millisecond') ELSE NULL END)`, [
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
  if (terminal && priorEvidence.length > 0) {
    const resolved = await client.query(`UPDATE execution_reconciliation_evidence SET
      resolved_by_evidence_id=$3,resolved_at=TIMESTAMPTZ 'epoch'
        +($4::BIGINT*INTERVAL '1 millisecond'),
      purge_after=TIMESTAMPTZ 'epoch'+(($4::BIGINT+14400000)*INTERVAL '1 millisecond')
      WHERE intent_id=$1 AND attempt_number=$2 AND result='UNKNOWN'
        AND resolved_by_evidence_id IS NULL`, [
      evidence.intentId, evidence.attemptNumber, evidence.evidenceId, finalizedAtMs,
    ]);
    if (resolved.rowCount !== priorEvidence.length) throw failure('CONFLICT');
  }
  if (!terminal) {
    if (initialArtifactState !== 'AMBIGUOUS') {
      const artifactRevision = unsignedBigint(row.state_revision);
      const ambiguousArtifact = await client.query(`UPDATE execution_signed_transactions SET
        state='AMBIGUOUS',state_revision=$2::BIGINT
        WHERE artifact_id=$1 AND state=$3 AND state_revision=$4::BIGINT`, [
        artifact.artifactId, (artifactRevision + 1n).toString(), initialArtifactState,
        artifactRevision.toString(),
      ]);
      if (ambiguousArtifact.rowCount !== 1) throw failure('CONFLICT');
      await insertLiveStateEvent(
        client, artifact, initialArtifactState as 'ACCEPTED' | 'CONFIRMED', 'AMBIGUOUS',
        'RECONCILIATION_REQUIRED', evidence.observedAtMs,
      );
    }
    if (initialIntentStatus !== 'UNKNOWN_REQUIRES_RECONCILIATION') {
      const intentRevision = unsignedBigint(row.intent_revision);
      const unknownIntent = await client.query(`UPDATE execution_intents SET
        status='UNKNOWN_REQUIRES_RECONCILIATION',state_revision=$2::BIGINT,
        last_reason_code='RECONCILIATION_REQUIRED',
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        updated_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')
        WHERE id=$1 AND status=$4 AND state_revision=$5::BIGINT`, [
        artifact.intentId, (intentRevision + 1n).toString(), evidence.observedAtMs,
        initialIntentStatus, intentRevision.toString(),
      ]);
      if (unknownIntent.rowCount !== 1) throw failure('CONFLICT');
      await insertStandardIntentTransition(
        client, artifact, initialIntentStatus as 'SUBMITTED' | 'CONFIRMED',
        'UNKNOWN_REQUIRES_RECONCILIATION', 'RECONCILIATION_REQUIRED',
        evidence.observedAtMs,
      );
    } else {
      const releasedIntent = await client.query(`UPDATE execution_intents SET
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        updated_at=TIMESTAMPTZ 'epoch'+($2::BIGINT*INTERVAL '1 millisecond')
        WHERE id=$1 AND status='UNKNOWN_REQUIRES_RECONCILIATION'
          AND state_revision=$3::BIGINT AND lease_owner=$4 AND lease_token=$5::UUID`, [
        artifact.intentId, evidence.observedAtMs, row.intent_revision,
        claim.leaseOwner, claim.leaseToken,
      ]);
      if (releasedIntent.rowCount !== 1) throw failure('LEASE_LOST');
    }
    if (row.position_state === 'EXIT_PENDING') {
      const positionRevision = unsignedBigint(row.position_revision);
      const positioned = await client.query(`UPDATE execution_live_positions SET
        state='UNKNOWN',state_revision=$2::BIGINT
        WHERE position_id=$1 AND state='EXIT_PENDING' AND state_revision=$3::BIGINT`, [
        row.position_id, (positionRevision + 1n).toString(), positionRevision.toString(),
      ]);
      if (positioned.rowCount !== 1) throw failure('CONFLICT');
    }
    const blocked = await client.query(`UPDATE execution_wallet_risk_state SET
      unknown_block=TRUE,state_revision=state_revision+1,
      updated_at=TIMESTAMPTZ 'epoch'+($2::BIGINT*INTERVAL '1 millisecond')
      WHERE generation_id=$1 AND unknown_block=FALSE`, [
      artifact.generationId, evidence.observedAtMs,
    ]);
    if (blocked.rowCount !== 0 && blocked.rowCount !== 1) throw failure('CONFLICT');
    return Object.freeze({
      payloadVersion: 1,
      result: evidence.result,
      artifact,
      position: null,
      exitAuthorization: null,
    });
  }
  if (evidence.result === 'NO_EFFECT') {
    if (initialArtifactState !== 'AMBIGUOUS'
      || initialIntentStatus !== 'UNKNOWN_REQUIRES_RECONCILIATION'
      || finalizedAtMs === null) throw failure('CONFLICT');
    const artifactRevision = unsignedBigint(row.state_revision);
    const artifactUpdate = await client.query(`UPDATE execution_signed_transactions SET
      state='RECONCILED',state_revision=$2::BIGINT,
      reconciled_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
      purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond')
      WHERE artifact_id=$1 AND state='AMBIGUOUS' AND state_revision=$4::BIGINT`, [
      artifact.artifactId, (artifactRevision + 1n).toString(), finalizedAtMs,
      artifactRevision.toString(),
    ]);
    const positionRevision = unsignedBigint(row.position_revision);
    const positionUpdate = row.position_state === 'UNKNOWN'
      ? await client.query(`UPDATE execution_live_positions SET
          state='EXIT_PENDING',state_revision=$2::BIGINT
          WHERE position_id=$1 AND state='UNKNOWN' AND state_revision=$3::BIGINT`, [
        row.position_id, (positionRevision + 1n).toString(), positionRevision.toString(),
      ]) : null;
    const authorizationRevision = unsignedBigint(row.authorization_revision);
    const authorizationUpdate = await client.query(`UPDATE execution_exit_authorizations SET
      state='ACTIVE',state_revision=$2::BIGINT,locked_intent_id=NULL,locked_attempt_number=NULL
      WHERE authorization_id=$1 AND state='LOCKED' AND state_revision=$3::BIGINT`, [
      artifact.exitAuthorizationId, (authorizationRevision + 1n).toString(),
      authorizationRevision.toString(),
    ]);
    const riskRevision = unsignedBigint(row.risk_revision);
    const riskUpdate = await client.query(`UPDATE execution_wallet_risk_state SET
      state_revision=$2::BIGINT,
      unknown_block=(EXISTS (SELECT 1 FROM execution_exposure_reservations reservation
          WHERE reservation.generation_id=$1 AND reservation.state='UNKNOWN_HELD')
        OR EXISTS (SELECT 1 FROM execution_reconciliation_evidence unresolved
          WHERE unresolved.generation_id=$1 AND unresolved.result IN ('UNKNOWN','MISMATCH')
            AND unresolved.resolved_by_evidence_id IS NULL)),
      updated_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')
      WHERE generation_id=$1 AND state_revision=$4::BIGINT`, [
      artifact.generationId, (riskRevision + 1n).toString(), finalizedAtMs,
      riskRevision.toString(),
    ]);
    const transition = await client.query(`INSERT INTO execution_intent_transitions (
      intent_id,previous_status,next_status,reason_code,human_message,activation_phase,
      attempt_number,evidence,occurred_at
    ) VALUES ($1,'UNKNOWN_REQUIRES_RECONCILIATION','RETRY_READY',
      'RECONCILIATION_PROVED_NO_EFFECT','Finalized canary exit had no effect; retry enabled.',
      'CANARY',$2,jsonb_build_object('payloadVersion',1,'attemptNumber',$2::INTEGER,
        'sourceEventId',NULL,'observedAtMs',$3::BIGINT),
      TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'))`, [
      artifact.intentId, artifact.attemptNumber, finalizedAtMs,
    ]);
    const intentRevision = unsignedBigint(row.intent_revision);
    const intentUpdate = await client.query(`UPDATE execution_intents SET
      status='RETRY_READY',state_revision=$2::BIGINT,
      last_reason_code='RECONCILIATION_PROVED_NO_EFFECT',
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
      updated_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')
      WHERE id=$1 AND status='UNKNOWN_REQUIRES_RECONCILIATION'
        AND state_revision=$4::BIGINT`, [
      artifact.intentId, (intentRevision + 1n).toString(), finalizedAtMs,
      intentRevision.toString(),
    ]);
    const attemptUpdate = await client.query(`UPDATE execution_attempts SET
      status='ABANDONED',completed_at=TIMESTAMPTZ 'epoch'
        +($3::BIGINT*INTERVAL '1 millisecond'),
      reason_code='RECONCILIATION_PROVED_NO_EFFECT'
      WHERE intent_id=$1 AND attempt_number=$2 AND status='STARTED'`, [
      artifact.intentId, artifact.attemptNumber, finalizedAtMs,
    ]);
    const updates = [artifactUpdate, authorizationUpdate, riskUpdate, transition,
      intentUpdate, attemptUpdate];
    if (positionUpdate !== null) updates.push(positionUpdate);
    if (updates.some((update) => update.rowCount !== 1)) throw failure('CONFLICT');
    await insertLiveStateEvent(
      client, artifact, 'AMBIGUOUS', 'RECONCILED',
      'RECONCILIATION_PROVED_NO_EFFECT', finalizedAtMs,
    );
    return Object.freeze({
      payloadVersion: 1,
      result: 'NO_EFFECT',
      artifact,
      position: null,
      exitAuthorization: null,
    });
  }
  if (finalizedAtMs === null || evidence.observedSlot === null) throw failure('CONFLICT');
  let artifactRevision = unsignedBigint(row.state_revision);
  if (initialArtifactState !== 'CONFIRMED') {
    const confirmed = await client.query(`UPDATE execution_signed_transactions SET
      state='CONFIRMED',state_revision=$2::BIGINT,
      submitted_at=COALESCE(submitted_at,
        TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')),
      confirmed_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
      confirmed_slot=$4::BIGINT
      WHERE artifact_id=$1 AND state=$5 AND state_revision=$6::BIGINT`, [
      artifact.artifactId, (artifactRevision + 1n).toString(), finalizedAtMs,
      evidence.observedSlot.toString(), initialArtifactState, artifactRevision.toString(),
    ]);
    if (confirmed.rowCount !== 1) throw failure('CONFLICT');
    await insertLiveStateEvent(
      client, artifact, initialArtifactState as 'ACCEPTED' | 'AMBIGUOUS', 'CONFIRMED',
      'CONFIRMATION_OBSERVED', finalizedAtMs,
    );
    artifactRevision += 1n;
  }
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
    WHERE position_id=$1 AND state=$6 AND state_revision=$5::BIGINT`, [
    row.position_id, (positionRevision + 1n).toString(), evidence.evidenceFingerprint,
    finalizedAtMs, positionRevision.toString(), row.position_state,
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
    unknown_block=(EXISTS (SELECT 1 FROM execution_exposure_reservations reservation
        WHERE reservation.generation_id=$1 AND reservation.state='UNKNOWN_HELD')
      OR EXISTS (SELECT 1 FROM execution_reconciliation_evidence unresolved
        WHERE unresolved.generation_id=$1 AND unresolved.result IN ('UNKNOWN','MISMATCH')
          AND unresolved.resolved_by_evidence_id IS NULL)),
    updated_at=TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond')
    WHERE generation_id=$1 AND state_revision=$6::BIGINT`, [
    artifact.generationId, (riskRevision + 1n).toString(),
    (reservedExposure - quoteCost).toString(), openPositions - 1,
    finalizedAtMs, riskRevision.toString(),
  ]);
  let inferredIntentTransition: QueryResult | null = null;
  if (initialIntentStatus !== 'CONFIRMED') {
    inferredIntentTransition = await client.query(`INSERT INTO execution_intent_transitions (
      intent_id,previous_status,next_status,reason_code,human_message,activation_phase,
      attempt_number,evidence,occurred_at
    ) VALUES ($1,$2,'CONFIRMED','CONFIRMATION_OBSERVED',
      'Finalized canary exit effect confirmed.','CANARY',$3,
      jsonb_build_object('payloadVersion',1,'attemptNumber',$3::INTEGER,
        'sourceEventId',NULL,'observedAtMs',$4::BIGINT),
      TIMESTAMPTZ 'epoch'+($4::BIGINT*INTERVAL '1 millisecond'))`, [
      artifact.intentId, initialIntentStatus, artifact.attemptNumber, finalizedAtMs,
    ]);
  }
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
  const intentRevisionIncrement = inferredIntentTransition === null ? 1n : 2n;
  const intentUpdate = await client.query(`UPDATE execution_intents SET
    status='SUCCEEDED',state_revision=$2::BIGINT,last_reason_code='INTENT_SUCCEEDED',
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
    terminal_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    reconciliation_completed_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond'),
    purge_after=TIMESTAMPTZ 'epoch'+(($3::BIGINT+14400000)*INTERVAL '1 millisecond'),
    updated_at=TIMESTAMPTZ 'epoch'+($3::BIGINT*INTERVAL '1 millisecond')
    WHERE id=$1 AND status=$4 AND state_revision=$5::BIGINT`, [
    artifact.intentId, (intentRevision + intentRevisionIncrement).toString(), finalizedAtMs,
    initialIntentStatus, intentRevision.toString(),
  ]);
  const attemptUpdate = await client.query(`UPDATE execution_attempts SET
    status='COMPLETED',completed_at=TIMESTAMPTZ 'epoch'
      +($3::BIGINT*INTERVAL '1 millisecond'),reason_code='ATTEMPT_COMPLETED'
    WHERE intent_id=$1 AND attempt_number=$2 AND status='STARTED'`, [
    artifact.intentId, artifact.attemptNumber, finalizedAtMs,
  ]);
  const requiredUpdates = [artifactUpdate, positionUpdate, authorizationUpdate, armamentUpdate,
    riskUpdate, transition, intentUpdate, attemptUpdate];
  if (inferredIntentTransition !== null) requiredUpdates.push(inferredIntentTransition);
  if (requiredUpdates.some((result) => result.rowCount !== 1)) {
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

async function deadlinePositionGeneration(
  client: DatabaseClient,
  positionId: string,
): Promise<string> {
  const identity = exactRow(singleRow(await client.query(`SELECT generation_id
    FROM execution_live_positions WHERE position_id=$1`, [positionId])), [
    'generation_id',
  ] as const);
  const generationId = text(identity.generation_id);
  if (!/^execution_wallet_generation_[0-9a-f]{64}$/u.test(generationId)) {
    throw failure('INVALID_DATA');
  }
  return generationId;
}

async function createDeadlineExitIntentLocked(
  client: DatabaseClient,
  input: Readonly<{
    readonly positionId: string;
    readonly observedAtMs: number;
    readonly generationId: string;
  }>,
): Promise<ExecutionDeadlineExitResultV1> {
  const row = exactRow(singleRow(await client.query(`SELECT
    position.position_id,position.generation_id,position.state,
    position.state_revision::TEXT AS position_revision,
    position.exit_intent_id,position.mint,position.quote_mint,
    position.remaining_base_raw::TEXT AS remaining_base_raw,
    trunc(EXTRACT(EPOCH FROM position.exit_deadline_at)*1000)::TEXT AS exit_deadline_at_ms,
    position.entry_reconciliation_fingerprint,
    buy.quote_token_program,buy.quote_decimals
    FROM execution_live_positions position
    JOIN execution_intents buy ON buy.id=position.buy_intent_id
    WHERE position.position_id=$1 FOR UPDATE OF position`, [input.positionId])), [
    'position_id', 'generation_id', 'state', 'position_revision', 'exit_intent_id', 'mint',
    'quote_mint', 'remaining_base_raw', 'exit_deadline_at_ms',
    'entry_reconciliation_fingerprint', 'quote_token_program', 'quote_decimals',
  ] as const);
  if (row.position_id !== input.positionId || row.generation_id !== input.generationId) {
    throw failure('INVALID_DATA');
  }
  const databaseNowMs = await freshDatabaseNow(client);
  if (input.observedAtMs > databaseNowMs) throw failure('INVALID_INPUT');
  const exitDeadlineAtMs = timestampText(row.exit_deadline_at_ms);
  if (input.observedAtMs < exitDeadlineAtMs) {
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
      intent: await findDeadlineIntent(
        client, draft, exitDeadlineAtMs, input.observedAtMs,
      ),
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
    intent: await findDeadlineIntent(client, draft, exitDeadlineAtMs, input.observedAtMs),
  });
}

async function findDeadlineIntent(
  client: DatabaseClient,
  draft: ExecutionIntentDraftV1,
  exitDeadlineAtMs: number,
  requestedAtUpperBoundMs: number,
): Promise<ExecutionIntentV1> {
  const row = exactRow(singleRow(await client.query(`SELECT
    id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,
    logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,
    quote_decimals,quote_amount_raw::TEXT AS quote_amount_raw,
    base_amount_raw::TEXT AS base_amount_raw,
    minimum_amount_out_raw::TEXT AS minimum_amount_out_raw,
    decision_event_id,decision_fingerprint,
    trunc(EXTRACT(EPOCH FROM requested_at)*1000)::TEXT AS requested_at_ms,
    trunc(EXTRACT(EPOCH FROM expires_at)*1000)::TEXT AS expires_at_ms,
    status,attempt_count,state_revision::TEXT AS state_revision,last_reason_code,
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
    'id', 'payload_version', 'logical_order_key', 'strategy_id', 'strategy_version',
    'position_id', 'logical_command_id', 'mint', 'side', 'venue_policy', 'quote_mint',
    'quote_token_program', 'quote_decimals', 'quote_amount_raw', 'base_amount_raw',
    'minimum_amount_out_raw', 'decision_event_id', 'decision_fingerprint',
    'requested_at_ms', 'expires_at_ms', 'status', 'attempt_count', 'state_revision',
    'last_reason_code', 'terminal_at_ms',
    'reconciliation_completed_at_ms', 'purge_after_ms', 'created_at_ms', 'updated_at_ms',
  ] as const);
  const candidate = Object.freeze({
    id: text(row.id),
    payloadVersion: integer(row.payload_version),
    logicalOrderKey: text(row.logical_order_key),
    strategyId: text(row.strategy_id),
    strategyVersion: integer(row.strategy_version),
    positionId: text(row.position_id),
    logicalCommandId: text(row.logical_command_id),
    mint: text(row.mint),
    side: row.side,
    venuePolicy: row.venue_policy,
    quoteMint: text(row.quote_mint),
    quoteTokenProgram: row.quote_token_program,
    quoteDecimals: integer(row.quote_decimals),
    quoteAmountRaw: nullableUnsignedBigint(row.quote_amount_raw),
    baseAmountRaw: nullableUnsignedBigint(row.base_amount_raw),
    minimumAmountOutRaw: unsignedBigint(row.minimum_amount_out_raw),
    decisionEventId: text(row.decision_event_id),
    decisionFingerprint: text(row.decision_fingerprint),
    requestedAtMs: timestampText(row.requested_at_ms),
    expiresAtMs: timestampText(row.expires_at_ms),
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
  if (!sameDeadlineIntentContext(candidate, draft)
    || candidate.requestedAtMs < exitDeadlineAtMs
    || candidate.requestedAtMs > requestedAtUpperBoundMs
    || candidate.expiresAtMs - candidate.requestedAtMs !== 120_000) {
    throw failure('INVALID_DATA');
  }
  return candidate;
}

function sameDeadlineIntentContext(
  persisted: ExecutionIntentV1,
  expected: ExecutionIntentDraftV1,
): boolean {
  return persisted.id === expected.id
    && persisted.logicalOrderKey === expected.logicalOrderKey
    && persisted.strategyId === expected.strategyId
    && persisted.strategyVersion === expected.strategyVersion
    && persisted.positionId === expected.positionId
    && persisted.logicalCommandId === expected.logicalCommandId
    && persisted.mint === expected.mint
    && persisted.side === expected.side
    && persisted.venuePolicy === expected.venuePolicy
    && persisted.quoteMint === expected.quoteMint
    && persisted.quoteTokenProgram === expected.quoteTokenProgram
    && persisted.quoteDecimals === expected.quoteDecimals
    && persisted.quoteAmountRaw === expected.quoteAmountRaw
    && persisted.baseAmountRaw === expected.baseAmountRaw
    && persisted.minimumAmountOutRaw === expected.minimumAmountOutRaw
    && persisted.decisionEventId === expected.decisionEventId
    && persisted.decisionFingerprint === expected.decisionFingerprint;
}

async function lockGeneration(client: DatabaseClient, generationId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))', [generationId]);
}

async function workerGenerationId(
  client: DatabaseClient,
  claim: ClaimedExecutionIntent,
): Promise<string> {
  const row = exactRow(singleRow(await client.query(`SELECT generation_id
    FROM execution_signed_transactions
    WHERE intent_id=$1 AND attempt_number=$2::INTEGER`, [
    claim.intent.id, claim.intent.attemptCount,
  ])), ['generation_id'] as const);
  const generationId = text(row.generation_id);
  if (!/^execution_wallet_generation_[0-9a-f]{64}$/u.test(generationId)) {
    throw failure('INVALID_DATA');
  }
  return generationId;
}

async function freshDatabaseNow(client: DatabaseClient): Promise<number> {
  const row = exactRow(singleRow(await client.query(`SELECT
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms`)), [
    'now_ms',
  ] as const);
  return timestampText(row.now_ms);
}

function assertWorkerClaim(
  row: Row,
  claim: ClaimedExecutionIntent,
  nowMs: number,
): void {
  if (row.intent_id !== claim.intent.id
    || row.intent_status !== claim.intent.status
    || unsignedBigint(row.intent_revision) !== claim.intent.stateRevision
    || integer(row.attempt_count) !== claim.intent.attemptCount
    || row.lease_owner !== claim.leaseOwner
    || row.lease_token !== claim.leaseToken
    || row.lease_expires_at_ms === null
    || timestampText(row.lease_expires_at_ms) <= nowMs) throw failure('LEASE_LOST');
}

function providerIdentifier(value: unknown): string {
  const candidate = text(value);
  if (!PROVIDER_ID.test(candidate)) throw failure('INVALID_DATA');
  return candidate;
}

function reconciliationSignature(value: unknown): string {
  return canonicalBase58Bytes(value, 64, 64, 96);
}

function solanaAddress(value: unknown): string {
  return canonicalBase58Bytes(value, 32, 32, 44);
}

function canonicalBase58Bytes(
  value: unknown,
  expectedByteLength: number,
  minimumLength: number,
  maximumLength: number,
): string {
  try {
    const candidate = text(value);
    if (candidate.length < minimumLength || candidate.length > maximumLength
      || !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(candidate)) throw new TypeError();
    const decoded = bs58.decode(candidate);
    if (decoded.byteLength !== expectedByteLength || bs58.encode(decoded) !== candidate) {
      throw new TypeError();
    }
    return candidate;
  } catch {
    throw failure('INVALID_DATA');
  }
}

function assertCausalArtifactId(
  row: Row,
  artifactId: string,
  intentId: string,
  attemptNumber: number,
  generationId: string,
  signature: string,
): void {
  try {
    const reservationId = row.artifact_reservation_id === null
      ? null
      : text(row.artifact_reservation_id);
    if (reservationId !== null
      && !/^execution_exposure_reservation_[0-9a-f]{64}$/u.test(reservationId)) {
      throw new TypeError();
    }
    const expectedArtifactId = createSignedTransactionArtifactId({
      intentId,
      attemptNumber,
      generationId,
      reservationId,
      messageHash: fingerprintText(row.artifact_message_hash),
      quoteObservedAtMs: timestampText(row.artifact_quote_observed_at_ms),
      quoteExpiresAtMs: timestampText(row.artifact_quote_expires_at_ms),
      signature,
    });
    if (expectedArtifactId !== artifactId) throw new TypeError();
  } catch {
    throw failure('INVALID_DATA');
  }
}

function reconciliationStatePair(
  intentStatus: string,
  artifactState: unknown,
): boolean {
  if (intentStatus === 'CONFIRMED' || intentStatus === 'RECONCILING') {
    return artifactState === 'CONFIRMED';
  }
  return intentStatus === 'UNKNOWN_REQUIRES_RECONCILIATION'
    && artifactState === 'AMBIGUOUS';
}

function executionSide(value: unknown): 'BUY' | 'SELL' {
  if (value !== 'BUY' && value !== 'SELL') throw failure('INVALID_DATA');
  return value;
}

function executionVenue(value: unknown): 'PUMP_FUN' | 'PUMP_SWAP' {
  if (value !== 'PUMP_FUN' && value !== 'PUMP_SWAP') throw failure('INVALID_DATA');
  return value;
}

function fingerprintText(value: unknown): string {
  const candidate = text(value);
  if (!HASH.test(candidate)) throw failure('INVALID_DATA');
  return candidate;
}

function patternedText(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw failure('INVALID_DATA');
  return value;
}

function positiveInteger(value: unknown): number {
  const candidate = integer(value);
  if (candidate < 1) throw failure('INVALID_DATA');
  return candidate;
}

function assertReconciliationExpected(value: Readonly<{
  readonly intentId: string;
  readonly attemptNumber: number;
  readonly walletGeneration: number;
  readonly providerId: string;
  readonly side: 'BUY' | 'SELL';
  readonly signature: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly messageHash: string;
  readonly buildFingerprint: string;
  readonly snapshotFingerprint: string;
  readonly maximumFeeLamports: bigint;
  readonly maximumFeePayerLamportDebit: bigint;
}>): void {
  try {
    evaluateExecutionReconciliation({
      expected: value,
      observed: Object.freeze({
        signatureHistory: 'UNKNOWN', confirmationStatus: 'NOT_FOUND',
        finalizedBlockHeight: 0n, observedSlot: null, transaction: null,
        feeLamports: 0n, walletLamportDelta: 0n, baseDeltaRaw: 0n,
        quoteDeltaRaw: 0n, unexpectedResidualTokenBalanceRaw: 0n,
        observedAtMs: 0, finalizedAtMs: null,
      }),
    });
  } catch {
    throw failure('INVALID_DATA');
  }
}

async function lockProvider(client: DatabaseClient, providerId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51006))', [providerId]);
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

function nullableUnsignedBigint(value: unknown): bigint | null {
  return value === null ? null : unsignedBigint(value);
}

function signedBigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw failure('INVALID_DATA');
  }
  const parsed = BigInt(value);
  if (parsed < -(1n << 63n) || parsed > (1n << 63n) - 1n) throw failure('INVALID_DATA');
  return parsed;
}

function unsigned(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= 18_446_744_073_709_551_615n;
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

function text(value: unknown): string {
  if (typeof value !== 'string') throw failure('INVALID_DATA');
  return value;
}

function livePositionState(value: unknown): ExecutionLivePositionState {
  if (value !== 'OPEN' && value !== 'EXIT_PENDING' && value !== 'CLOSED'
    && value !== 'UNKNOWN') throw failure('INVALID_DATA');
  return value;
}

function inspectableSignedState(value: unknown): ExecutionLiveSignedTransactionInspectionV1['state'] {
  if (typeof value !== 'string' || ![
    'PERSISTED', 'SIGNED_SIMULATED', 'SUBMISSION_STARTED',
    'ACCEPTED', 'AMBIGUOUS', 'REVOKED_NO_SEND',
  ].includes(value)) throw failure('CONFLICT');
  return value as ExecutionLiveSignedTransactionInspectionV1['state'];
}

function inspectionIntentStatusMatches(
  state: Exclude<ExecutionLiveSignedTransactionInspectionV1['state'], 'REVOKED_NO_SEND'>,
  status: unknown,
): boolean {
  if (state === 'PERSISTED' || state === 'SIGNED_SIMULATED'
    || state === 'SUBMISSION_STARTED') return status === 'SIGNED_NOT_SUBMITTED';
  if (state === 'ACCEPTED') return status === 'SUBMITTED';
  return status === 'UNKNOWN_REQUIRES_RECONCILIATION';
}

function exitAuthorizationState(value: unknown): ExecutionExitAuthorizationState {
  if (value !== 'ACTIVE' && value !== 'LOCKED' && value !== 'CONSUMED'
    && value !== 'REVOKED') throw failure('INVALID_DATA');
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
