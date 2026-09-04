import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  assertExecutionAttemptStatusReason,
  assertExecutionIntent,
  assertExecutionIntentTransitionReason,
  EXECUTION_INTENT_REASON_CODES,
  EXECUTION_INTENT_STATUSES,
  type ExecutionIntentDraftV1,
  type ExecutionIntentReasonCode,
  type ExecutionIntentStatus,
  type ExecutionIntentV1,
} from '../domain/execution-intent.js';
import type {
  ClaimedExecutionIntent,
  ExecutionBeginAttemptResult,
  ExecutionClaimOptions,
  ExecutionClaimPurpose,
  ExecutionIntentRepository,
  ExecutionIntentTransitionEvidenceV1,
  ExecutionIntentTransitionInput,
} from '../ports/execution-intent-repository.js';
import { getDatabasePool } from './database.js';

type Row = Readonly<Record<string, unknown>>;

interface LeaseIdentity {
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
}

interface QueryResult {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface ExecutionIntentTransactionClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
}

interface ExecutionIntentClient extends ExecutionIntentTransactionClient {
  release(error?: boolean): void;
}

export interface ExecutionIntentPool {
  connect(): Promise<ExecutionIntentClient>;
}

const LIVE_SELL_PRESENCE_LOCK_SQL = `SELECT pg_advisory_xact_lock(
  hashtextextended('execution-live-sell-presence:v1', 51008))`;

export type ExecutionIntentRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_DATA'
  | 'DATABASE_FAILURE'
  | 'OPERATION_ABORTED'
  | 'INTENT_DUPLICATE'
  | 'INTENT_LEASE_LOST'
  | 'ATTEMPT_EXHAUSTED'
  | 'ATTEMPT_CONFLICT';

export class ExecutionIntentRepositoryError extends Error {
  public constructor(
    public readonly code: ExecutionIntentRepositoryErrorCode,
    options?: ErrorOptions,
  ) {
    super('Execution intent repository operation failed.', options);
    this.name = 'ExecutionIntentRepositoryError';
  }
}

const DATE_MAX_MS = 8_640_000_000_000_000;
const U64_MAX = 18_446_744_073_709_551_615n;
const INT32_MAX = 2_147_483_647;
const INT64_MAX = 9_223_372_036_854_775_807n;
const MAX_LEASE_MS = 86_400_000;
const MAX_EXPIRE_BATCH = 1_000;
const RETENTION_MS = 14_400_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TERMINAL_STATUSES = new Set<ExecutionIntentStatus>([
  'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED',
]);
const INTERNAL_ERRORS = new WeakSet<ExecutionIntentRepositoryError>();

const DRAFT_KEYS = Object.freeze([
  'id', 'payloadVersion', 'logicalOrderKey', 'strategyId', 'strategyVersion',
  'positionId', 'logicalCommandId', 'mint', 'side', 'venuePolicy', 'quoteMint',
  'quoteTokenProgram', 'quoteDecimals', 'quoteAmountRaw', 'baseAmountRaw',
  'minimumAmountOutRaw', 'decisionEventId', 'decisionFingerprint',
  'requestedAtMs', 'expiresAtMs',
] as const);

const CLAIM_OPTION_KEYS = Object.freeze(['ownerId', 'leaseMs', 'purpose'] as const);
const LIVE_EXECUTE_CLAIM_OPTION_KEYS = Object.freeze([
  'ownerId', 'leaseMs', 'purpose', 'side',
] as const);
const CLAIM_KEYS = Object.freeze([
  'intent', 'leaseOwner', 'leaseToken', 'leaseExpiresAtMs',
] as const);
const TRANSITION_KEYS = Object.freeze([
  'intentId', 'expectedStatus', 'nextStatus', 'leaseToken', 'reasonCode',
  'humanMessage', 'activationPhase', 'evidence',
] as const);
const EVIDENCE_KEYS = Object.freeze([
  'payloadVersion', 'attemptNumber', 'sourceEventId', 'observedAtMs',
] as const);
const FINISH_ATTEMPT_KEYS = Object.freeze([
  'attemptNumber', 'status', 'effectiveVenue', 'providerId', 'reasonCode',
] as const);

const INTENT_ROW_KEYS = Object.freeze([
  'id', 'payload_version', 'logical_order_key', 'strategy_id', 'strategy_version',
  'position_id', 'logical_command_id', 'mint', 'side', 'venue_policy', 'quote_mint',
  'quote_token_program', 'quote_decimals', 'quote_amount_raw', 'base_amount_raw',
  'minimum_amount_out_raw', 'decision_event_id', 'decision_fingerprint',
  'requested_at_ms', 'expires_at_ms', 'status', 'attempt_count', 'state_revision', 'last_reason_code',
  'terminal_at_ms', 'reconciliation_completed_at_ms', 'purge_after_ms',
  'created_at_ms', 'updated_at_ms', 'lease_owner', 'lease_token',
  'lease_expires_at_ms',
] as const);
const CLAIM_ROW_KEYS = Object.freeze([...INTENT_ROW_KEYS, 'claim_at_ms'] as const);
const ATTEMPT_ROW_KEYS = Object.freeze([
  'attempt_number', 'status', 'effective_venue', 'provider_id', 'started_at_ms', 'completed_at_ms',
  'reason_code',
] as const);
const ATTEMPT_LEDGER_ROW_KEYS = Object.freeze([
  'fenced_count', 'attempt_count', 'max_attempt_number', 'started_count',
  'latest_attempt_number', 'latest_status', 'latest_effective_venue', 'latest_provider_id',
  'latest_started_at_ms', 'latest_completed_at_ms', 'latest_reason_code',
] as const);

const INTENT_PROJECTION = `
  intent.id,
  intent.payload_version,
  intent.logical_order_key,
  intent.strategy_id,
  intent.strategy_version,
  intent.position_id,
  intent.logical_command_id,
  intent.mint,
  intent.side,
  intent.venue_policy,
  intent.quote_mint,
  intent.quote_token_program,
  intent.quote_decimals,
  intent.quote_amount_raw::TEXT AS quote_amount_raw,
  intent.base_amount_raw::TEXT AS base_amount_raw,
  intent.minimum_amount_out_raw::TEXT AS minimum_amount_out_raw,
  intent.decision_event_id,
  intent.decision_fingerprint,
  trunc(EXTRACT(EPOCH FROM intent.requested_at) * 1000)::TEXT AS requested_at_ms,
  trunc(EXTRACT(EPOCH FROM intent.expires_at) * 1000)::TEXT AS expires_at_ms,
  intent.status,
  intent.attempt_count,
  intent.state_revision::TEXT AS state_revision,
  intent.last_reason_code,
  CASE WHEN intent.terminal_at IS NULL THEN NULL
    ELSE trunc(EXTRACT(EPOCH FROM intent.terminal_at) * 1000)::TEXT END AS terminal_at_ms,
  CASE WHEN intent.reconciliation_completed_at IS NULL THEN NULL
    ELSE trunc(EXTRACT(EPOCH FROM intent.reconciliation_completed_at) * 1000)::TEXT
    END AS reconciliation_completed_at_ms,
  CASE WHEN intent.purge_after IS NULL THEN NULL
    ELSE trunc(EXTRACT(EPOCH FROM intent.purge_after) * 1000)::TEXT END AS purge_after_ms,
  trunc(EXTRACT(EPOCH FROM intent.created_at) * 1000)::TEXT AS created_at_ms,
  trunc(EXTRACT(EPOCH FROM intent.updated_at) * 1000)::TEXT AS updated_at_ms,
  intent.lease_owner,
  intent.lease_token::TEXT AS lease_token,
  CASE WHEN intent.lease_expires_at IS NULL THEN NULL
    ELSE trunc(EXTRACT(EPOCH FROM intent.lease_expires_at) * 1000)::TEXT
    END AS lease_expires_at_ms`;

const CLAIM_PROJECTION = `${INTENT_PROJECTION},
  trunc(EXTRACT(EPOCH FROM operation.at) * 1000)::TEXT AS claim_at_ms`;

const CLAIM_SQL: Readonly<Record<ExecutionClaimPurpose, string>> = Object.freeze({
  EXECUTE: claimSql(
    "intent.status IN ('PENDING', 'RETRY_READY', 'PROCESSING')",
    true,
  ),
  CONFIRM: claimSql("intent.status IN ('SUBMITTED')", false),
  RECONCILE: claimSql(`intent.status IN (
    'CONFIRMED', 'RECONCILING', 'UNKNOWN_REQUIRES_RECONCILIATION'
  )`, false),
  DRY_RUN: dryRunClaimSql(),
});
const LIVE_EXECUTE_SELL_SQL = claimSql(`intent.side = 'SELL'
      AND intent.status IN ('PENDING', 'RETRY_READY', 'PROCESSING')`, true);
const LIVE_EXECUTE_BUY_SQL = claimSql(`intent.side = 'BUY'
      AND intent.status IN ('PENDING', 'RETRY_READY', 'PROCESSING')
      AND NOT EXISTS (
        SELECT 1
        FROM execution_intents AS blocking_sell
        WHERE blocking_sell.side = 'SELL'
          AND (
            (blocking_sell.status IN ('PENDING', 'RETRY_READY', 'PROCESSING')
              AND blocking_sell.expires_at > statement_timestamp())
            OR blocking_sell.status = 'SIGNED_NOT_SUBMITTED'
          )
      )`, true);
const LIVE_RECOVER_SQL = claimSql("intent.status = 'SIGNED_NOT_SUBMITTED'", false);

export async function createExecutionIntentInTransaction(
  client: ExecutionIntentTransactionClient,
  draftValue: ExecutionIntentDraftV1,
): Promise<Readonly<{
  readonly kind: 'CREATED' | 'REPLAYED';
  readonly intent: ExecutionIntentV1;
}>> {
  const draft = draftInput(draftValue);
  if (draft.side === 'SELL') await lockLiveSellPresenceInTransaction(client);
  const inserted = await client.query(
    `INSERT INTO execution_intents AS intent (
       id,payload_version,logical_order_key,strategy_id,strategy_version,
       position_id,logical_command_id,mint,side,venue_policy,quote_mint,
       quote_token_program,quote_decimals,quote_amount_raw,base_amount_raw,
       minimum_amount_out_raw,decision_event_id,decision_fingerprint,
       requested_at,expires_at,status
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
       TIMESTAMPTZ 'epoch' + ($19::BIGINT * INTERVAL '1 millisecond'),
       TIMESTAMPTZ 'epoch' + ($20::BIGINT * INTERVAL '1 millisecond'),
       'PENDING'
     )
     ON CONFLICT DO NOTHING
     RETURNING ${INTENT_PROJECTION}`,
    draftValues(draft),
  );
  const tombstone = await client.query(
    `SELECT tombstone.intent_id,tombstone.logical_order_key
     FROM execution_intent_tombstones AS tombstone
     WHERE tombstone.intent_id = $1 OR tombstone.logical_order_key = $2
     ORDER BY CASE WHEN tombstone.intent_id = $1 THEN 0 ELSE 1 END,
       tombstone.intent_id
     LIMIT 1`,
    [draft.id, draft.logicalOrderKey],
  );
  if (tombstone.rowCount === 1 && tombstone.rows.length === 1) throw duplicateError();
  if (tombstone.rowCount !== 0 || tombstone.rows.length !== 0) throw dataError();
  if (inserted.rowCount === 1 && inserted.rows.length === 1) {
    const intent = intentFromRow(requiredRow(inserted.rows));
    if (intent.status !== 'PENDING' || intent.stateRevision !== 0n
      || !sameImmutableIntent(draft, intent)) throw dataError();
    return createResult('CREATED', intent);
  }
  if (inserted.rowCount !== 0 || inserted.rows.length !== 0) throw dataError();

  const conflict = await client.query(
    `SELECT ${INTENT_PROJECTION}
     FROM execution_intents AS intent
     WHERE intent.id = $1 OR intent.logical_order_key = $2
     ORDER BY CASE WHEN intent.id = $1 THEN 0 ELSE 1 END, intent.id
     FOR SHARE`,
    [draft.id, draft.logicalOrderKey],
  );
  if (conflict.rowCount !== 1 || conflict.rows.length !== 1) throw duplicateError();
  const stored = intentFromRow(requiredRow(conflict.rows));
  if (!sameImmutableIntent(draft, stored)) throw duplicateError();
  return createResult('REPLAYED', stored);
}

export async function lockLiveSellPresenceInTransaction(
  client: ExecutionIntentTransactionClient,
): Promise<void> {
  await client.query(LIVE_SELL_PRESENCE_LOCK_SQL);
}

export class PostgresExecutionIntentRepository implements ExecutionIntentRepository {
  public constructor(
    private readonly pool: ExecutionIntentPool = getDatabasePool(),
  ) {}

  public async create(draftValue: ExecutionIntentDraftV1): Promise<Readonly<{
    readonly kind: 'CREATED' | 'REPLAYED';
    readonly intent: ExecutionIntentV1;
  }>> {
    return this.safely(async () => {
      return this.transaction((client) => createExecutionIntentInTransaction(client, draftValue));
    });
  }

  public async claim(
    optionsValue: ExecutionClaimOptions,
    signal?: AbortSignal,
  ): Promise<ClaimedExecutionIntent | null> {
    return this.safely(async () => {
      const options = claimOptions(optionsValue);
      if (signal?.aborted === true) throw operationAbortedError();
      const leaseToken = randomUUID();
      const claimFromClient = async (
        client: ExecutionIntentClient,
      ): Promise<ClaimedExecutionIntent | null> => {
        const claimed = await client.query(
          claimSqlFor(options),
          [options.ownerId, options.leaseMs, leaseToken],
        );
        if (claimed.rowCount === 0 && claimed.rows.length === 0) return null;
        if (claimed.rowCount !== 1 || claimed.rows.length !== 1) throw dataError();
        const { claim, claimAtMs } = claimFromRow(requiredRow(claimed.rows));
        if (claim.leaseOwner !== options.ownerId || claim.leaseToken !== leaseToken) {
          throw dataError();
        }
        if (!intentMatchesClaimOptions(claim.intent, options)) throw dataError();
        if (claim.leaseExpiresAtMs - claimAtMs !== options.leaseMs) throw dataError();
        if ((options.purpose === 'EXECUTE' || options.purpose === 'LIVE_EXECUTE')
          && claim.intent.expiresAtMs <= claimAtMs) throw dataError();
        if (options.purpose === 'DRY_RUN' && claim.intent.expiresAtMs <= claim.leaseExpiresAtMs) {
          throw dataError();
        }
        return claim;
      };
      if (options.purpose === 'LIVE_EXECUTE' && options.side === 'BUY') {
        return this.transaction(async (client) => {
          await lockLiveSellPresenceInTransaction(client);
          if (signal?.aborted === true) throw operationAbortedError();
          return claimFromClient(client);
        }, signal, 'READ_COMMITTED');
      }
      return this.withClaimClient(signal, options.purpose === 'DRY_RUN', claimFromClient);
    });
  }

  public async beginAttempt(claimValue: ClaimedExecutionIntent): Promise<ExecutionBeginAttemptResult> {
    return this.safely(async () => {
      const claim = claimedInput(claimValue);
      if (claim.intent.status !== 'PROCESSING') throw attemptConflictError();
      return this.transaction(async (client) => {
        const locked = await lockClaimedIntent(client, claim);
        const ledger = await lockAttemptLedger(client, locked);
        if (ledger.latest?.status === 'STARTED') {
          return Object.freeze({
            claim: locked,
            attempt: Object.freeze({
              intentId: locked.intent.id,
              attemptNumber: ledger.latest.attemptNumber,
              startedAtMs: ledger.latest.startedAtMs,
            }),
          });
        }
        if (locked.intent.attemptCount === INT32_MAX) throw attemptExhaustedError();
        const attemptNumber = locked.intent.attemptCount + 1;
        const inserted = await client.query(
          `WITH operation AS MATERIALIZED (
             SELECT date_trunc('milliseconds', statement_timestamp()) AS at
           )
           INSERT INTO execution_attempts (intent_id,attempt_number,status,started_at)
           SELECT intent.id,$5,'STARTED',operation.at
           FROM execution_intents AS intent CROSS JOIN operation
           WHERE intent.id=$1 AND intent.status=$2
             AND intent.lease_token=$3::UUID
             AND intent.state_revision=$4::BIGINT
             AND intent.lease_expires_at > statement_timestamp()
           RETURNING trunc(EXTRACT(EPOCH FROM started_at) * 1000)::TEXT AS started_at_ms`,
          [claim.intent.id, claim.intent.status, claim.leaseToken,
            claim.intent.stateRevision.toString(), attemptNumber],
        );
        if (inserted.rowCount === 0 && inserted.rows.length === 0) throw leaseLostError();
        if (inserted.rowCount !== 1 || inserted.rows.length !== 1) throw dataError();
        const started = exactRecord(requiredRow(inserted.rows), ['started_at_ms'], 'INVALID_DATA');
        const startedAtMs = timestampFromDatabase(started.started_at_ms);
        const updated = await client.query(
          `WITH operation AS MATERIALIZED (
             SELECT date_trunc('milliseconds', statement_timestamp()) AS at
           )
           UPDATE execution_intents AS intent
           SET attempt_count=$5, updated_at=operation.at
           FROM operation
           WHERE intent.id=$1 AND intent.status=$2
             AND intent.lease_token=$3::UUID
             AND intent.state_revision=$4::BIGINT
             AND intent.lease_expires_at > statement_timestamp()
           RETURNING ${INTENT_PROJECTION}`,
          [claim.intent.id, claim.intent.status, claim.leaseToken,
            claim.intent.stateRevision.toString(), attemptNumber],
        );
        if (updated.rowCount === 0 && updated.rows.length === 0) throw leaseLostError();
        if (updated.rowCount !== 1 || updated.rows.length !== 1) throw dataError();
        const row = requiredRow(updated.rows);
        const intent = intentFromRow(row);
        const lease = leaseFromIntentRow(row);
        if (lease === null || !sameBegunAttemptClaim(locked, intent, lease, attemptNumber)) {
          throw dataError();
        }
        return Object.freeze({
          claim: Object.freeze({ intent, ...lease }),
          attempt: Object.freeze({ intentId: intent.id, attemptNumber, startedAtMs }),
        });
      });
    });
  }

  public async finishAttempt(
    claimValue: ClaimedExecutionIntent,
    inputValue: Readonly<{
      readonly attemptNumber: number;
      readonly status: 'COMPLETED' | 'ABANDONED';
      readonly effectiveVenue: 'PUMP_FUN' | 'PUMP_SWAP' | null;
      readonly providerId: string | null;
      readonly reasonCode: ExecutionIntentReasonCode;
    }>,
  ): Promise<boolean> {
    return this.safely(async () => {
      const claim = claimedInput(claimValue);
      const input = finishAttemptInput(inputValue);
      if (claim.intent.status !== 'PROCESSING') throw attemptConflictError();
      return this.transaction(async (client) => {
        const locked = await lockClaimedIntent(client, claim);
        const ledger = await lockAttemptLedger(client, locked);
        if (input.attemptNumber !== locked.intent.attemptCount || locked.intent.attemptCount === 0
          || ledger.latest === null) {
          throw attemptConflictError();
        }
        const attempt = ledger.latest;
        if (attempt.attemptNumber !== input.attemptNumber) throw dataError();
        if (attempt.status !== 'STARTED') {
          if (attempt.status === input.status
            && attempt.effectiveVenue === input.effectiveVenue
            && attempt.providerId === input.providerId
            && attempt.reasonCode === input.reasonCode) return false;
          throw attemptConflictError();
        }
        const updated = await client.query(
          `WITH operation AS MATERIALIZED (
             SELECT date_trunc('milliseconds', statement_timestamp()) AS at
           )
           UPDATE execution_attempts AS attempt
             SET status=$6,effective_venue=$7,provider_id=$8,
             completed_at=operation.at,reason_code=$9
           FROM execution_intents AS intent CROSS JOIN operation
           WHERE attempt.intent_id=$1 AND attempt.attempt_number=$5
             AND attempt.status='STARTED'
             AND intent.id=attempt.intent_id AND intent.id=$1 AND intent.status=$2
             AND intent.lease_token=$3::UUID
             AND intent.state_revision=$4::BIGINT
             AND intent.lease_expires_at > statement_timestamp()`,
          [claim.intent.id, claim.intent.status, claim.leaseToken,
            claim.intent.stateRevision.toString(), input.attemptNumber,
            input.status, input.effectiveVenue, input.providerId, input.reasonCode],
        );
        if (updated.rowCount === 0) throw leaseLostError();
        if (updated.rowCount !== 1) throw dataError();
        return true;
      });
    });
  }

  public async renew(
    claimValue: ClaimedExecutionIntent,
    leaseMsValue: number,
  ): Promise<ClaimedExecutionIntent> {
    return this.safely(async () => {
      const claim = claimedInput(claimValue);
      const leaseMs = positiveInteger(leaseMsValue, MAX_LEASE_MS, 'INVALID_INPUT');
      return this.transaction(async (client) => {
        await lockClaimedIntent(client, claim);
        const renewed = await client.query(
          `WITH operation AS MATERIALIZED (
             SELECT date_trunc('milliseconds', statement_timestamp()) AS at
           )
           UPDATE execution_intents AS intent
           SET lease_expires_at=date_trunc(
                 'milliseconds', statement_timestamp() + ($5::BIGINT * INTERVAL '1 millisecond')
               ),
               updated_at=operation.at
           FROM operation
           WHERE intent.id=$1 AND intent.status=$2
             AND intent.lease_token=$3::UUID
             AND intent.state_revision=$4::BIGINT
             AND intent.lease_expires_at > statement_timestamp()
           RETURNING ${INTENT_PROJECTION}`,
          [claim.intent.id, claim.intent.status, claim.leaseToken,
            claim.intent.stateRevision.toString(), leaseMs],
        );
        if (renewed.rowCount === 0 && renewed.rows.length === 0) throw leaseLostError();
        if (renewed.rowCount !== 1 || renewed.rows.length !== 1) throw dataError();
        const row = requiredRow(renewed.rows);
        const intent = intentFromRow(row);
        const lease = leaseFromIntentRow(row);
        if (lease === null || !sameRenewedClaim(claim, intent, lease, leaseMs)) throw dataError();
        return Object.freeze({ intent, ...lease });
      });
    });
  }

  public async release(claimValue: ClaimedExecutionIntent): Promise<boolean> {
    return this.safely(async () => {
      const claim = claimedInput(claimValue);
      return this.transaction(async (client) => {
        await lockClaimedIntent(client, claim);
        const released = await client.query(
          `WITH operation AS MATERIALIZED (
             SELECT date_trunc('milliseconds', statement_timestamp()) AS at
           )
           UPDATE execution_intents AS intent
           SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=operation.at
           FROM operation
           WHERE intent.id=$1 AND intent.status=$2
             AND intent.lease_token=$3::UUID
             AND intent.state_revision=$4::BIGINT
             AND intent.lease_expires_at > statement_timestamp()`,
          [claim.intent.id, claim.intent.status, claim.leaseToken,
            claim.intent.stateRevision.toString()],
        );
        return fencedBooleanMutation(released);
      });
    });
  }

  public async transition(
    claimValue: ClaimedExecutionIntent,
    inputValue: ExecutionIntentTransitionInput,
  ): Promise<ExecutionIntentV1> {
    return this.safely(async () => {
      const claim = claimedInput(claimValue);
      const input = transitionInput(inputValue, claim);
      return this.transaction(async (client) => {
        if (claim.intent.side === 'SELL'
          && claim.intent.status === 'UNKNOWN_REQUIRES_RECONCILIATION'
          && input.nextStatus === 'RETRY_READY') {
          await lockLiveSellPresenceInTransaction(client);
        }
        const locked = await lockClaimedIntent(client, claim);
        if (locked.intent.stateRevision === INT64_MAX) throw dataError();
        if ((locked.intent.attemptCount === 0) !== (input.evidence.attemptNumber === null)
          || (locked.intent.attemptCount > 0
            && input.evidence.attemptNumber !== locked.intent.attemptCount)) {
          throw inputError();
        }
        const ledger = await lockAttemptLedger(client, locked);
        if (locked.intent.attemptCount > 0) {
          if (ledger.latest?.status === undefined
            || ledger.latest.status === 'STARTED'
            || input.evidence.attemptNumber !== ledger.latest.attemptNumber) {
            throw attemptConflictError();
          }
        }
        const journaled = await client.query(
          `INSERT INTO execution_intent_transitions (
             intent_id,previous_status,next_status,reason_code,human_message,
             activation_phase,attempt_number,evidence
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::JSONB)`,
          [input.intentId, input.expectedStatus, input.nextStatus, input.reasonCode,
            input.humanMessage, input.activationPhase, input.evidence.attemptNumber,
            evidenceJson(input.evidence)],
        );
        requireOneMutation(journaled);
        const terminal = TERMINAL_STATUSES.has(input.nextStatus);
        const updateValues = terminal
          ? [input.intentId, input.expectedStatus, input.leaseToken, input.nextStatus,
            claim.intent.stateRevision.toString(), input.reasonCode, true]
          : [input.intentId, input.expectedStatus, input.leaseToken, input.nextStatus,
            claim.intent.stateRevision.toString(), input.reasonCode];
        const updated = await client.query(
          transitionUpdateSql(terminal),
          updateValues,
        );
        if (updated.rowCount === 0 && updated.rows.length === 0) throw leaseLostError();
        if (updated.rowCount !== 1 || updated.rows.length !== 1) throw dataError();
        const returnedRow = requiredRow(updated.rows);
        const transitioned = intentFromRow(returnedRow);
        const returnedLease = leaseFromIntentRow(returnedRow);
        if (!sameImmutableIntent(locked.intent, transitioned)
          || transitioned.status !== input.nextStatus
          || transitioned.attemptCount !== locked.intent.attemptCount
          || transitioned.stateRevision !== locked.intent.stateRevision + 1n
          || transitioned.lastReasonCode !== input.reasonCode
          || (!terminal && !sameLeaseIdentity(returnedLease, locked))
          || (terminal && returnedLease !== null)
          || (terminal && (
            transitioned.terminalAtMs === null
            || transitioned.reconciliationCompletedAtMs !== transitioned.terminalAtMs
            || transitioned.purgeAfterMs !== transitioned.terminalAtMs + RETENTION_MS
            || transitioned.updatedAtMs !== transitioned.terminalAtMs
          ))) throw dataError();
        return transitioned;
      });
    });
  }

  public async expirePreSubmission(limitValue: number): Promise<number> {
    return this.safely(async () => {
      const limit = positiveInteger(limitValue, MAX_EXPIRE_BATCH, 'INVALID_INPUT');
      return this.transaction(async (client) => {
        const expired = await client.query(
          `WITH operation AS MATERIALIZED (
             SELECT date_trunc('milliseconds', statement_timestamp()) AS at
           ), candidates AS MATERIALIZED (
             SELECT intent.id,intent.status,intent.attempt_count,intent.state_revision
             FROM execution_intents AS intent CROSS JOIN operation
             WHERE intent.status IN ('PENDING','RETRY_READY','PROCESSING','SIMULATED')
               AND intent.expires_at <= statement_timestamp()
               AND (intent.lease_expires_at IS NULL
                 OR intent.lease_expires_at <= statement_timestamp())
               AND intent.state_revision < 9223372036854775807
               AND (SELECT COUNT(*) FROM execution_attempts AS attempt
                 WHERE attempt.intent_id=intent.id) = intent.attempt_count
               AND COALESCE((SELECT MAX(attempt.attempt_number)
                 FROM execution_attempts AS attempt WHERE attempt.intent_id=intent.id),0)
                 = intent.attempt_count
               AND (SELECT COUNT(*) FROM execution_attempts AS attempt
                 WHERE attempt.intent_id=intent.id AND attempt.status='STARTED') <= 1
               AND NOT EXISTS (SELECT 1 FROM execution_attempts AS attempt
                 WHERE attempt.intent_id=intent.id AND attempt.status='STARTED'
                   AND attempt.attempt_number<>intent.attempt_count)
             ORDER BY intent.requested_at,intent.id
             FOR UPDATE OF intent SKIP LOCKED
             LIMIT $1
           ), abandoned AS (
             UPDATE execution_attempts AS attempt
             SET status='ABANDONED',completed_at=operation.at,
               reason_code='INTENT_EXPIRED'
             FROM candidates AS candidate CROSS JOIN operation
             WHERE attempt.intent_id=candidate.id AND attempt.status='STARTED'
             RETURNING attempt.intent_id
           ), journal AS (
             INSERT INTO execution_intent_transitions (
               intent_id,previous_status,next_status,reason_code,human_message,
               activation_phase,attempt_number,evidence,occurred_at
             )
             SELECT candidate.id,candidate.status,'EXPIRED','INTENT_EXPIRED',
               'Execution intent expired before signature.','NONE',
               CASE WHEN candidate.attempt_count=0 THEN NULL ELSE candidate.attempt_count END,
               jsonb_build_object(
                 'payloadVersion',1,
                 'attemptNumber',CASE WHEN candidate.attempt_count=0
                   THEN NULL ELSE candidate.attempt_count END,
                 'sourceEventId',NULL,
                 'observedAtMs',(EXTRACT(EPOCH FROM operation.at) * 1000)::BIGINT
               ),operation.at
             FROM candidates AS candidate CROSS JOIN operation
             RETURNING intent_id
           ), updated AS (
             UPDATE execution_intents AS intent
             SET status='EXPIRED',last_reason_code='INTENT_EXPIRED',
               terminal_at=operation.at,reconciliation_completed_at=operation.at,
               purge_after=operation.at + INTERVAL '4 hours',
               lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
               updated_at=operation.at,state_revision=candidate.state_revision + 1
             FROM candidates AS candidate CROSS JOIN operation
             WHERE intent.id=candidate.id
               AND EXISTS (SELECT 1 FROM journal WHERE journal.intent_id=intent.id)
             RETURNING intent.id
           )
           SELECT COUNT(*)::INTEGER AS expired_count FROM updated`,
          [limit],
        );
        if (expired.rowCount !== 1 || expired.rows.length !== 1) throw dataError();
        const row = exactRecord(requiredRow(expired.rows), ['expired_count'], 'INVALID_DATA');
        return nonNegativeInteger(row.expired_count, 'INVALID_DATA');
      });
    });
  }

  public async read(intentIdValue: string): Promise<ExecutionIntentV1 | null> {
    return this.safely(async () => {
      const intentId = boundedText(intentIdValue, 'INVALID_INPUT');
      return this.withClient(async (client) => {
        const result = await client.query(
          `SELECT ${INTENT_PROJECTION}
           FROM execution_intents AS intent WHERE intent.id=$1`,
          [intentId],
        );
        if (result.rowCount === 0 && result.rows.length === 0) return null;
        if (result.rowCount !== 1 || result.rows.length !== 1) throw dataError();
        const intent = intentFromRow(requiredRow(result.rows));
        if (intent.id !== intentId) throw dataError();
        return intent;
      });
    });
  }

  private async transaction<TResult>(
    run: (client: ExecutionIntentClient) => Promise<TResult>,
    signal?: AbortSignal,
    isolationLevel?: 'READ_COMMITTED',
  ): Promise<TResult> {
    let client: ExecutionIntentClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw databaseError(1);
    }
    if (signal?.aborted === true) abortBeforeClaim(client);
    let transactionStarted = false;
    let primaryFailure: unknown;
    let result: TResult | undefined;
    let completed = false;
    let cleanupFailureCount = 0;
    let evict = false;
    try {
      transactionStarted = true;
      await client.query(isolationLevel === 'READ_COMMITTED'
        ? 'BEGIN ISOLATION LEVEL READ COMMITTED'
        : 'BEGIN');
      result = await run(client);
      await client.query('COMMIT');
      transactionStarted = false;
      completed = true;
    } catch (error) {
      primaryFailure = error;
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch {
          cleanupFailureCount += 1;
          evict = true;
        }
      }
    } finally {
      try {
        client.release(evict);
      } catch {
        cleanupFailureCount += 1;
      }
    }
    if (completed && cleanupFailureCount === 0) return result as TResult;
    if (cleanupFailureCount === 0 && isInternalError(primaryFailure)) throw primaryFailure;
    throw databaseError((primaryFailure === undefined ? 0 : 1) + cleanupFailureCount);
  }

  private async withClient<TResult>(
    run: (client: ExecutionIntentClient) => Promise<TResult>,
  ): Promise<TResult> {
    let client: ExecutionIntentClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw databaseError(1);
    }
    let result: TResult | undefined;
    let primaryFailure: unknown;
    let completed = false;
    let releaseFailed = false;
    try {
      result = await run(client);
      completed = true;
    } catch (error) {
      primaryFailure = error;
    } finally {
      try {
        client.release();
      } catch {
        releaseFailed = true;
      }
    }
    if (completed && !releaseFailed) return result as TResult;
    if (!releaseFailed && isInternalError(primaryFailure)) throw primaryFailure;
    throw databaseError((primaryFailure === undefined ? 0 : 1) + (releaseFailed ? 1 : 0));
  }

  private async withClaimClient<TResult>(
    signal: AbortSignal | undefined,
    evictOnFailure: boolean,
    run: (client: ExecutionIntentClient) => Promise<TResult>,
  ): Promise<TResult> {
    let client: ExecutionIntentClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw databaseError(1);
    }
    if (signal?.aborted === true) abortBeforeClaim(client);
    let result: TResult | undefined;
    let primaryFailure: unknown;
    let completed = false;
    let releaseFailed = false;
    try {
      result = await run(client);
      completed = true;
    } catch (error) {
      primaryFailure = error;
    } finally {
      try {
        if (completed) client.release();
        else if (evictOnFailure) client.release(true);
        else client.release();
      } catch {
        releaseFailed = true;
      }
    }
    if (completed && !releaseFailed) return result as TResult;
    if (!releaseFailed && isInternalError(primaryFailure)) throw primaryFailure;
    throw databaseError((primaryFailure === undefined ? 0 : 1) + (releaseFailed ? 1 : 0));
  }

  private async safely<TResult>(run: () => Promise<TResult>): Promise<TResult> {
    try {
      return await run();
    } catch (error) {
      if (isInternalError(error)) throw error;
      throw databaseError(1);
    }
  }
}

function claimSql(statusPredicate: string, requireLiveIntent: boolean): string {
  const expirationPredicate = requireLiveIntent
    ? '\n      AND intent.expires_at > statement_timestamp()'
    : '';
  return `WITH candidate AS MATERIALIZED (
    SELECT intent.id
    FROM execution_intents AS intent
    WHERE ${statusPredicate}${expirationPredicate}
      AND (intent.lease_expires_at IS NULL
        OR intent.lease_expires_at <= statement_timestamp())
    ORDER BY intent.requested_at,intent.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), operation AS MATERIALIZED (
    SELECT date_trunc('milliseconds', statement_timestamp()) AS at
  )
  UPDATE execution_intents AS intent
  SET lease_owner=$1,
      lease_token=$3::UUID,
      lease_expires_at=date_trunc(
        'milliseconds', statement_timestamp() + ($2::BIGINT * INTERVAL '1 millisecond')
      ),
      updated_at=operation.at
  FROM candidate CROSS JOIN operation
  WHERE intent.id=candidate.id
  RETURNING ${CLAIM_PROJECTION}`;
}

function claimSqlFor(options: ExecutionClaimOptions): string {
  switch (options.purpose) {
    case 'LIVE_EXECUTE':
      return options.side === 'SELL' ? LIVE_EXECUTE_SELL_SQL : LIVE_EXECUTE_BUY_SQL;
    case 'LIVE_RECOVER': return LIVE_RECOVER_SQL;
    case 'EXECUTE': return CLAIM_SQL.EXECUTE;
    case 'CONFIRM': return CLAIM_SQL.CONFIRM;
    case 'RECONCILE': return CLAIM_SQL.RECONCILE;
    case 'DRY_RUN': return CLAIM_SQL.DRY_RUN;
  }
}

function dryRunClaimSql(): string {
  return `WITH operation AS MATERIALIZED (
    SELECT date_trunc('milliseconds', statement_timestamp()) AS at
  ), candidate AS MATERIALIZED (
    SELECT intent.id
    FROM execution_intents AS intent CROSS JOIN operation
    WHERE intent.status IN ('PENDING', 'RETRY_READY')
      AND intent.expires_at > operation.at + ($2::BIGINT * INTERVAL '1 millisecond')
      AND (intent.lease_expires_at IS NULL
        OR intent.lease_expires_at <= operation.at)
      AND NOT EXISTS (
        SELECT 1
        FROM execution_dry_run_assessments AS assessment
        WHERE assessment.intent_id = intent.id
          AND assessment.evaluator_version = 1
      )
    ORDER BY intent.requested_at,intent.id
    FOR UPDATE OF intent SKIP LOCKED
    LIMIT 1
  )
  UPDATE execution_intents AS intent
  SET lease_owner=$1,
      lease_token=$3::UUID,
      lease_expires_at=date_trunc(
        'milliseconds', operation.at + ($2::BIGINT * INTERVAL '1 millisecond')
      )
  FROM candidate CROSS JOIN operation
  WHERE intent.id=candidate.id
  RETURNING ${CLAIM_PROJECTION}`;
}

function transitionUpdateSql(terminal: boolean): string {
  if (!terminal) {
    return `WITH operation AS MATERIALIZED (
      SELECT date_trunc('milliseconds', statement_timestamp()) AS at
    )
    UPDATE execution_intents AS intent
    SET status=$4,last_reason_code=$6,updated_at=operation.at,
      state_revision=intent.state_revision + 1
    FROM operation
    WHERE intent.id=$1 AND intent.status=$2
      AND intent.lease_token=$3::UUID
      AND intent.state_revision=$5::BIGINT
      AND intent.state_revision < 9223372036854775807
      AND intent.lease_expires_at > statement_timestamp()
    RETURNING ${INTENT_PROJECTION}`;
  }
  return `WITH operation AS MATERIALIZED (
    SELECT date_trunc('milliseconds', statement_timestamp()) AS at
  )
  UPDATE execution_intents AS intent
  SET status=$4,last_reason_code=$6,terminal_at=operation.at,
      reconciliation_completed_at=CASE WHEN $7::BOOLEAN THEN operation.at ELSE NULL END,
      purge_after=CASE WHEN $7::BOOLEAN THEN operation.at + INTERVAL '4 hours' ELSE NULL END,
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=operation.at
      ,state_revision=intent.state_revision + 1
  FROM operation
  WHERE intent.id=$1 AND intent.status=$2
    AND intent.lease_token=$3::UUID
    AND intent.state_revision=$5::BIGINT
    AND intent.state_revision < 9223372036854775807
    AND intent.lease_expires_at > statement_timestamp()
  RETURNING ${INTENT_PROJECTION}`;
}

async function lockClaimedIntent(
  client: ExecutionIntentClient,
  claim: ClaimedExecutionIntent,
): Promise<ClaimedExecutionIntent> {
  const selected = await client.query(
    `SELECT ${INTENT_PROJECTION}
     FROM execution_intents AS intent
     WHERE intent.id=$1 AND intent.status=$2
       AND intent.lease_token=$3::UUID
       AND intent.state_revision=$4::BIGINT
       AND intent.lease_expires_at > statement_timestamp()
     FOR UPDATE`,
    [claim.intent.id, claim.intent.status, claim.leaseToken, claim.intent.stateRevision.toString()],
  );
  if (selected.rowCount === 0 && selected.rows.length === 0) {
    throw leaseLostError();
  }
  if (selected.rowCount !== 1 || selected.rows.length !== 1) throw dataError();
  const row = requiredRow(selected.rows);
  const intent = intentFromRow(row);
  const lease = leaseFromIntentRow(row);
  if (lease === null) throw dataError();
  const locked = Object.freeze({ intent, ...lease });
  if (!sameImmutableIntent(locked.intent, claim.intent)
    || locked.intent.id !== claim.intent.id
    || locked.intent.status !== claim.intent.status
    || locked.intent.stateRevision !== claim.intent.stateRevision
    || locked.leaseOwner !== claim.leaseOwner
    || locked.leaseToken !== claim.leaseToken) throw dataError();
  return locked;
}

function draftValues(draft: ExecutionIntentDraftV1): readonly unknown[] {
  return [
    draft.id, draft.payloadVersion, draft.logicalOrderKey, draft.strategyId,
    draft.strategyVersion, draft.positionId, draft.logicalCommandId, draft.mint,
    draft.side, draft.venuePolicy, draft.quoteMint, draft.quoteTokenProgram,
    draft.quoteDecimals, draft.quoteAmountRaw?.toString() ?? null,
    draft.baseAmountRaw?.toString() ?? null, draft.minimumAmountOutRaw.toString(),
    draft.decisionEventId, draft.decisionFingerprint, draft.requestedAtMs.toString(),
    draft.expiresAtMs.toString(),
  ];
}

function draftInput(value: unknown): ExecutionIntentDraftV1 {
  const row = exactRecord(value, DRAFT_KEYS, 'INVALID_INPUT');
  const draft: unknown = Object.freeze({
    id: row.id,
    payloadVersion: row.payloadVersion,
    logicalOrderKey: row.logicalOrderKey,
    strategyId: row.strategyId,
    strategyVersion: row.strategyVersion,
    positionId: row.positionId,
    logicalCommandId: row.logicalCommandId,
    mint: row.mint,
    side: row.side,
    venuePolicy: row.venuePolicy,
    quoteMint: row.quoteMint,
    quoteTokenProgram: row.quoteTokenProgram,
    quoteDecimals: row.quoteDecimals,
    quoteAmountRaw: row.quoteAmountRaw,
    baseAmountRaw: row.baseAmountRaw,
    minimumAmountOutRaw: row.minimumAmountOutRaw,
    decisionEventId: row.decisionEventId,
    decisionFingerprint: row.decisionFingerprint,
    requestedAtMs: row.requestedAtMs,
    expiresAtMs: row.expiresAtMs,
  });
  const candidate: unknown = Object.freeze({
    ...(draft as Readonly<Record<string, unknown>>),
    status: 'PENDING', attemptCount: 0, lastReasonCode: null, terminalAtMs: null,
    stateRevision: 0n,
    reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: row.requestedAtMs, updatedAtMs: row.requestedAtMs,
  });
  try {
    assertExecutionIntent(candidate);
  } catch {
    throw inputError();
  }
  return draft as ExecutionIntentDraftV1;
}

function claimOptions(value: unknown): ExecutionClaimOptions {
  let hasSide: boolean;
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      throw new Error();
    }
    hasSide = Reflect.ownKeys(value).includes('side');
  } catch { throw inputError(); }
  const row = exactRecord(
    value,
    hasSide ? LIVE_EXECUTE_CLAIM_OPTION_KEYS : CLAIM_OPTION_KEYS,
    'INVALID_INPUT',
  );
  const ownerId = boundedText(row.ownerId, 'INVALID_INPUT');
  const leaseMs = positiveInteger(row.leaseMs, MAX_LEASE_MS, 'INVALID_INPUT');
  const purpose = claimPurpose(row.purpose);
  if (purpose === 'LIVE_EXECUTE') {
    if (!hasSide || (row.side !== 'BUY' && row.side !== 'SELL')) throw inputError();
    return Object.freeze({ ownerId, leaseMs, purpose, side: row.side });
  }
  if (hasSide) throw inputError();
  return Object.freeze({ ownerId, leaseMs, purpose });
}

function claimedInput(value: unknown): ClaimedExecutionIntent {
  const row = exactRecord(value, CLAIM_KEYS, 'INVALID_INPUT');
  try {
    assertExecutionIntent(row.intent);
  } catch {
    throw inputError();
  }
  const leaseOwner = boundedText(row.leaseOwner, 'INVALID_INPUT');
  const leaseToken = uuid(row.leaseToken, 'INVALID_INPUT');
  const leaseExpiresAtMs = timestamp(row.leaseExpiresAtMs, 'INVALID_INPUT');
  return Object.freeze({
    intent: row.intent, leaseOwner, leaseToken, leaseExpiresAtMs,
  } as ClaimedExecutionIntent);
}

function transitionInput(
  value: unknown,
  claim: ClaimedExecutionIntent,
): ExecutionIntentTransitionInput {
  const row = exactRecord(value, TRANSITION_KEYS, 'INVALID_INPUT');
  const intentId = boundedText(row.intentId, 'INVALID_INPUT');
  const expectedStatus = status(row.expectedStatus, 'INVALID_INPUT');
  const nextStatus = status(row.nextStatus, 'INVALID_INPUT');
  const leaseToken = uuid(row.leaseToken, 'INVALID_INPUT');
  const reasonCode = reason(row.reasonCode, 'INVALID_INPUT');
  const humanMessage = boundedText(row.humanMessage, 'INVALID_INPUT');
  const activationPhase = phase(row.activationPhase);
  const evidence = transitionEvidence(row.evidence);
  if (intentId !== claim.intent.id
    || expectedStatus !== claim.intent.status
    || leaseToken !== claim.leaseToken) throw inputError();
  try {
    assertExecutionIntentTransitionReason(expectedStatus, nextStatus, reasonCode);
  } catch {
    throw inputError();
  }
  return Object.freeze({
    intentId, expectedStatus, nextStatus, leaseToken, reasonCode, humanMessage,
    activationPhase, evidence,
  });
}

function transitionEvidence(value: unknown): ExecutionIntentTransitionEvidenceV1 {
  const row = exactRecord(value, EVIDENCE_KEYS, 'INVALID_INPUT');
  if (row.payloadVersion !== 1) throw inputError();
  const attemptNumber = row.attemptNumber === null
    ? null
    : positiveInteger(row.attemptNumber, INT32_MAX, 'INVALID_INPUT');
  const sourceEventId = row.sourceEventId === null
    ? null
    : boundedText(row.sourceEventId, 'INVALID_INPUT');
  const observedAtMs = timestamp(row.observedAtMs, 'INVALID_INPUT');
  return Object.freeze({ payloadVersion: 1, attemptNumber, sourceEventId, observedAtMs });
}

function finishAttemptInput(value: unknown): Readonly<{
  readonly attemptNumber: number;
  readonly status: 'COMPLETED' | 'ABANDONED';
  readonly effectiveVenue: 'PUMP_FUN' | 'PUMP_SWAP' | null;
  readonly providerId: string | null;
  readonly reasonCode: ExecutionIntentReasonCode;
}> {
  const row = exactRecord(value, FINISH_ATTEMPT_KEYS, 'INVALID_INPUT');
  const attemptNumber = positiveInteger(row.attemptNumber, INT32_MAX, 'INVALID_INPUT');
  if (row.status !== 'COMPLETED' && row.status !== 'ABANDONED') throw inputError();
  if (row.effectiveVenue !== null
    && row.effectiveVenue !== 'PUMP_FUN'
    && row.effectiveVenue !== 'PUMP_SWAP') throw inputError();
  const providerId = row.providerId === null
    ? null
    : boundedText(row.providerId, 'INVALID_INPUT');
  const reasonCode = reason(row.reasonCode, 'INVALID_INPUT');
  try {
    assertExecutionAttemptStatusReason(row.status, reasonCode);
  } catch {
    throw inputError();
  }
  return Object.freeze({
    attemptNumber, status: row.status, effectiveVenue: row.effectiveVenue,
    providerId, reasonCode,
  });
}

function intentFromRow(value: unknown): ExecutionIntentV1 {
  const row = exactRecord(value, INTENT_ROW_KEYS, 'INVALID_DATA');
  const intentStatus = status(row.status, 'INVALID_DATA');
  void leaseFromRow(row, intentStatus);
  const intent: unknown = Object.freeze({
    id: boundedText(row.id, 'INVALID_DATA'),
    payloadVersion: exactOne(row.payload_version, 'INVALID_DATA'),
    logicalOrderKey: boundedText(row.logical_order_key, 'INVALID_DATA'),
    strategyId: boundedText(row.strategy_id, 'INVALID_DATA'),
    strategyVersion: positiveInteger(row.strategy_version, INT32_MAX, 'INVALID_DATA'),
    positionId: boundedText(row.position_id, 'INVALID_DATA'),
    logicalCommandId: boundedText(row.logical_command_id, 'INVALID_DATA'),
    mint: boundedText(row.mint, 'INVALID_DATA'),
    side: side(row.side),
    venuePolicy: venuePolicy(row.venue_policy),
    quoteMint: boundedText(row.quote_mint, 'INVALID_DATA'),
    quoteTokenProgram: quoteTokenProgram(row.quote_token_program),
    quoteDecimals: boundedInteger(row.quote_decimals, 0, 255, 'INVALID_DATA'),
    quoteAmountRaw: nullableU64(row.quote_amount_raw),
    baseAmountRaw: nullableU64(row.base_amount_raw),
    minimumAmountOutRaw: u64(row.minimum_amount_out_raw),
    decisionEventId: boundedText(row.decision_event_id, 'INVALID_DATA'),
    decisionFingerprint: fingerprint(row.decision_fingerprint),
    requestedAtMs: timestampFromDatabase(row.requested_at_ms),
    expiresAtMs: timestampFromDatabase(row.expires_at_ms),
    status: intentStatus,
    attemptCount: nonNegativeInteger(row.attempt_count, 'INVALID_DATA'),
    stateRevision: stateRevision(row.state_revision),
    lastReasonCode: row.last_reason_code === null ? null : reason(row.last_reason_code, 'INVALID_DATA'),
    terminalAtMs: nullableTimestampFromDatabase(row.terminal_at_ms),
    reconciliationCompletedAtMs: nullableTimestampFromDatabase(row.reconciliation_completed_at_ms),
    purgeAfterMs: nullableTimestampFromDatabase(row.purge_after_ms),
    createdAtMs: timestampFromDatabase(row.created_at_ms),
    updatedAtMs: timestampFromDatabase(row.updated_at_ms),
  });
  try {
    assertExecutionIntent(intent);
  } catch {
    throw dataError();
  }
  return intent;
}

function leaseFromRow(row: Row, intentStatus: ExecutionIntentStatus): LeaseIdentity | null {
  const absent = row.lease_owner === null
    && row.lease_token === null
    && row.lease_expires_at_ms === null;
  if (absent) return null;
  if (TERMINAL_STATUSES.has(intentStatus)) throw dataError();
  if (row.lease_owner === null || row.lease_token === null || row.lease_expires_at_ms === null) {
    throw dataError();
  }
  return Object.freeze({
    leaseOwner: boundedText(row.lease_owner, 'INVALID_DATA'),
    leaseToken: uuid(row.lease_token, 'INVALID_DATA'),
    leaseExpiresAtMs: timestampFromDatabase(row.lease_expires_at_ms),
  });
}

function leaseFromIntentRow(value: unknown): LeaseIdentity | null {
  const row = exactRecord(value, INTENT_ROW_KEYS, 'INVALID_DATA');
  return leaseFromRow(row, status(row.status, 'INVALID_DATA'));
}

function sameLeaseIdentity(
  actual: LeaseIdentity | null,
  expected: LeaseIdentity,
): boolean {
  if (actual === null) return false;
  return actual.leaseOwner === expected.leaseOwner
    && actual.leaseToken === expected.leaseToken
    && actual.leaseExpiresAtMs === expected.leaseExpiresAtMs;
}

function sameRenewedClaim(
  previous: ClaimedExecutionIntent,
  renewed: ExecutionIntentV1,
  lease: LeaseIdentity,
  leaseMs: number,
): boolean {
  return sameImmutableIntent(previous.intent, renewed)
    && renewed.status === previous.intent.status
    && renewed.attemptCount === previous.intent.attemptCount
    && renewed.stateRevision === previous.intent.stateRevision
    && renewed.lastReasonCode === previous.intent.lastReasonCode
    && renewed.terminalAtMs === previous.intent.terminalAtMs
    && renewed.reconciliationCompletedAtMs === previous.intent.reconciliationCompletedAtMs
    && renewed.purgeAfterMs === previous.intent.purgeAfterMs
    && renewed.updatedAtMs >= previous.intent.updatedAtMs
    && lease.leaseOwner === previous.leaseOwner
    && lease.leaseToken === previous.leaseToken
    && lease.leaseExpiresAtMs >= previous.leaseExpiresAtMs
    && lease.leaseExpiresAtMs === renewed.updatedAtMs + leaseMs;
}

function sameBegunAttemptClaim(
  previous: ClaimedExecutionIntent,
  refreshed: ExecutionIntentV1,
  lease: LeaseIdentity,
  attemptNumber: number,
): boolean {
  return sameImmutableIntent(previous.intent, refreshed)
    && refreshed.status === 'PROCESSING'
    && refreshed.attemptCount === attemptNumber
    && attemptNumber === previous.intent.attemptCount + 1
    && refreshed.stateRevision === previous.intent.stateRevision
    && refreshed.lastReasonCode === previous.intent.lastReasonCode
    && refreshed.terminalAtMs === previous.intent.terminalAtMs
    && refreshed.reconciliationCompletedAtMs === previous.intent.reconciliationCompletedAtMs
    && refreshed.purgeAfterMs === previous.intent.purgeAfterMs
    && refreshed.updatedAtMs >= previous.intent.updatedAtMs
    && sameLeaseIdentity(lease, previous);
}

function claimFromRow(value: unknown): Readonly<{
  readonly claim: ClaimedExecutionIntent;
  readonly claimAtMs: number;
}> {
  const row = exactRecord(value, CLAIM_ROW_KEYS, 'INVALID_DATA');
  const intentValues: Record<string, unknown> = {};
  for (const key of INTENT_ROW_KEYS) intentValues[key] = row[key];
  const intent = intentFromRow(intentValues);
  const lease = leaseFromRow(row, intent.status);
  if (lease === null) throw dataError();
  return Object.freeze({
    claim: Object.freeze({ intent, ...lease }),
    claimAtMs: timestampFromDatabase(row.claim_at_ms),
  });
}

type AttemptStatus = 'STARTED' | 'COMPLETED' | 'ABANDONED';

interface StoredAttempt {
  readonly attemptNumber: number;
  readonly status: AttemptStatus;
  readonly effectiveVenue: 'PUMP_FUN' | 'PUMP_SWAP' | null;
  readonly providerId: string | null;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly reasonCode: ExecutionIntentReasonCode | null;
}

interface AttemptLedger {
  readonly latest: StoredAttempt | null;
}

async function lockAttemptLedger(
  client: ExecutionIntentClient,
  claim: ClaimedExecutionIntent,
): Promise<AttemptLedger> {
  const result = await client.query(
    `WITH fenced_intent AS MATERIALIZED (
       SELECT intent.id
       FROM execution_intents AS intent
       WHERE intent.id=$1 AND intent.status=$2
         AND intent.lease_token=$3::UUID
         AND intent.state_revision=$4::BIGINT
         AND intent.lease_expires_at > statement_timestamp()
       FOR UPDATE
     ), locked_attempts AS MATERIALIZED (
       SELECT attempt.*
       FROM execution_attempts AS attempt
       JOIN fenced_intent ON fenced_intent.id=attempt.intent_id
       FOR UPDATE OF attempt
     ), latest AS MATERIALIZED (
       SELECT * FROM locked_attempts ORDER BY attempt_number DESC LIMIT 1
     )
     SELECT
       (SELECT COUNT(*)::INTEGER FROM fenced_intent) AS fenced_count,
       COUNT(*)::INTEGER AS attempt_count,
       COALESCE(MAX(locked_attempts.attempt_number),0)::INTEGER AS max_attempt_number,
       COUNT(*) FILTER (WHERE locked_attempts.status='STARTED')::INTEGER AS started_count,
       (SELECT attempt_number FROM latest) AS latest_attempt_number,
       (SELECT status FROM latest) AS latest_status,
       (SELECT effective_venue FROM latest) AS latest_effective_venue,
       (SELECT provider_id FROM latest) AS latest_provider_id,
       (SELECT trunc(EXTRACT(EPOCH FROM started_at) * 1000)::TEXT FROM latest)
         AS latest_started_at_ms,
       (SELECT CASE WHEN completed_at IS NULL THEN NULL
         ELSE trunc(EXTRACT(EPOCH FROM completed_at) * 1000)::TEXT END FROM latest)
         AS latest_completed_at_ms,
       (SELECT reason_code FROM latest) AS latest_reason_code
     FROM locked_attempts`,
    [claim.intent.id, claim.intent.status, claim.leaseToken, claim.intent.stateRevision.toString()],
  );
  if (result.rowCount !== 1 || result.rows.length !== 1) throw dataError();
  const row = exactRecord(requiredRow(result.rows), ATTEMPT_LEDGER_ROW_KEYS, 'INVALID_DATA');
  const fencedCount = boundedInteger(row.fenced_count, 0, 1, 'INVALID_DATA');
  if (fencedCount === 0) throw leaseLostError();
  const count = nonNegativeInteger(row.attempt_count, 'INVALID_DATA');
  const maximum = nonNegativeInteger(row.max_attempt_number, 'INVALID_DATA');
  const startedCount = boundedInteger(row.started_count, 0, 1, 'INVALID_DATA');
  if (count !== claim.intent.attemptCount || maximum !== count) throw attemptConflictError();
  if (count === 0) {
    if (startedCount !== 0 || row.latest_attempt_number !== null || row.latest_status !== null
      || row.latest_effective_venue !== null || row.latest_provider_id !== null
      || row.latest_started_at_ms !== null || row.latest_completed_at_ms !== null
      || row.latest_reason_code !== null) throw dataError();
    return Object.freeze({ latest: null });
  }
  const attempt = attemptFromRow({
    attempt_number: row.latest_attempt_number,
    status: row.latest_status,
    effective_venue: row.latest_effective_venue,
    provider_id: row.latest_provider_id,
    started_at_ms: row.latest_started_at_ms,
    completed_at_ms: row.latest_completed_at_ms,
    reason_code: row.latest_reason_code,
  });
  if (attempt.attemptNumber !== count
    || (startedCount === 1) !== (attempt.status === 'STARTED')) throw attemptConflictError();
  return Object.freeze({ latest: attempt });
}

function attemptFromRow(value: unknown): StoredAttempt {
  const row = exactRecord(value, ATTEMPT_ROW_KEYS, 'INVALID_DATA');
  const attemptNumber = positiveInteger(row.attempt_number, INT32_MAX, 'INVALID_DATA');
  if (row.status !== 'STARTED' && row.status !== 'COMPLETED' && row.status !== 'ABANDONED') {
    throw dataError();
  }
  if (row.effective_venue !== null
    && row.effective_venue !== 'PUMP_FUN'
    && row.effective_venue !== 'PUMP_SWAP') throw dataError();
  const providerId = row.provider_id === null
    ? null
    : boundedText(row.provider_id, 'INVALID_DATA');
  const startedAtMs = timestampFromDatabase(row.started_at_ms);
  const completedAtMs = nullableTimestampFromDatabase(row.completed_at_ms);
  const reasonCode = row.reason_code === null ? null : reason(row.reason_code, 'INVALID_DATA');
  try {
    assertExecutionAttemptStatusReason(row.status, reasonCode);
  } catch {
    throw dataError();
  }
  if (row.status === 'STARTED') {
    if (row.effective_venue !== null || providerId !== null
      || completedAtMs !== null || reasonCode !== null) throw dataError();
  } else if (completedAtMs === null || reasonCode === null) throw dataError();
  return Object.freeze({
    attemptNumber, status: row.status, effectiveVenue: row.effective_venue,
    providerId, startedAtMs, completedAtMs, reasonCode,
  });
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: 'INVALID_INPUT' | 'INVALID_DATA',
): Row {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
      throw new Error();
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length) throw new Error();
    const record: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      if (!keys.includes(key)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error();
      }
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    throw repositoryError(code);
  }
}

function sameImmutableIntent(draft: ExecutionIntentDraftV1, intent: ExecutionIntentV1): boolean {
  return draft.id === intent.id
    && draft.logicalOrderKey === intent.logicalOrderKey
    && draft.strategyId === intent.strategyId
    && draft.strategyVersion === intent.strategyVersion
    && draft.positionId === intent.positionId
    && draft.logicalCommandId === intent.logicalCommandId
    && draft.mint === intent.mint
    && draft.side === intent.side
    && draft.venuePolicy === intent.venuePolicy
    && draft.quoteMint === intent.quoteMint
    && draft.quoteTokenProgram === intent.quoteTokenProgram
    && draft.quoteDecimals === intent.quoteDecimals
    && draft.quoteAmountRaw === intent.quoteAmountRaw
    && draft.baseAmountRaw === intent.baseAmountRaw
    && draft.minimumAmountOutRaw === intent.minimumAmountOutRaw
    && draft.decisionEventId === intent.decisionEventId
    && draft.decisionFingerprint === intent.decisionFingerprint
    && draft.requestedAtMs === intent.requestedAtMs
    && draft.expiresAtMs === intent.expiresAtMs;
}

function createResult(
  kind: 'CREATED' | 'REPLAYED',
  intent: ExecutionIntentV1,
): Readonly<{ readonly kind: 'CREATED' | 'REPLAYED'; readonly intent: ExecutionIntentV1 }> {
  return Object.freeze({ kind, intent });
}

function evidenceJson(evidence: ExecutionIntentTransitionEvidenceV1): string {
  return JSON.stringify({
    payloadVersion: evidence.payloadVersion,
    attemptNumber: evidence.attemptNumber,
    sourceEventId: evidence.sourceEventId,
    observedAtMs: evidence.observedAtMs,
  });
}

function claimPurpose(value: unknown): ExecutionClaimOptions['purpose'] {
  if (value !== 'LIVE_EXECUTE' && value !== 'LIVE_RECOVER'
    && value !== 'EXECUTE' && value !== 'CONFIRM'
    && value !== 'RECONCILE' && value !== 'DRY_RUN') {
    throw inputError();
  }
  return value;
}

function intentMatchesClaimOptions(
  intent: ExecutionIntentV1,
  options: ExecutionClaimOptions,
): boolean {
  const status = intent.status;
  if (options.purpose === 'LIVE_EXECUTE') {
    return intent.side === options.side
      && (status === 'PENDING' || status === 'RETRY_READY' || status === 'PROCESSING');
  }
  if (options.purpose === 'EXECUTE') {
    return status === 'PENDING' || status === 'RETRY_READY' || status === 'PROCESSING';
  }
  if (options.purpose === 'LIVE_RECOVER') return status === 'SIGNED_NOT_SUBMITTED';
  if (options.purpose === 'CONFIRM') return status === 'SUBMITTED';
  if (options.purpose === 'DRY_RUN') return status === 'PENDING' || status === 'RETRY_READY';
  return status === 'CONFIRMED' || status === 'RECONCILING'
    || status === 'UNKNOWN_REQUIRES_RECONCILIATION';
}

function status(
  value: unknown,
  code: 'INVALID_INPUT' | 'INVALID_DATA',
): ExecutionIntentStatus {
  if (!(EXECUTION_INTENT_STATUSES as readonly unknown[]).includes(value)) throw repositoryError(code);
  return value as ExecutionIntentStatus;
}

function reason(
  value: unknown,
  code: 'INVALID_INPUT' | 'INVALID_DATA',
): ExecutionIntentReasonCode {
  if (!(EXECUTION_INTENT_REASON_CODES as readonly unknown[]).includes(value)) throw repositoryError(code);
  return value as ExecutionIntentReasonCode;
}

function side(value: unknown): 'BUY' | 'SELL' {
  if (value !== 'BUY' && value !== 'SELL') throw dataError();
  return value;
}

function venuePolicy(value: unknown): 'PUMP_FUN_ONLY' | 'CANONICAL_EXIT' {
  if (value !== 'PUMP_FUN_ONLY' && value !== 'CANONICAL_EXIT') throw dataError();
  return value;
}

function quoteTokenProgram(value: unknown): 'SPL_TOKEN' | 'TOKEN_2022' {
  if (value !== 'SPL_TOKEN' && value !== 'TOKEN_2022') throw dataError();
  return value;
}

function phase(value: unknown): 'NONE' | 'CANARY' | 'MICRO_LIVE' | 'PILOT' {
  if (value !== 'NONE' && value !== 'CANARY' && value !== 'MICRO_LIVE' && value !== 'PILOT') {
    throw inputError();
  }
  return value;
}

function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw dataError();
  return value;
}

function boundedText(
  value: unknown,
  code: 'INVALID_INPUT' | 'INVALID_DATA',
): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 256) {
    throw repositoryError(code);
  }
  return value;
}

function uuid(
  value: unknown,
  code: 'INVALID_INPUT' | 'INVALID_DATA',
): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw repositoryError(code);
  return value;
}

function exactOne(value: unknown, code: 'INVALID_INPUT' | 'INVALID_DATA'): 1 {
  if (value !== 1) throw repositoryError(code);
  return 1;
}

function positiveInteger(
  value: unknown,
  maximum: number,
  code: 'INVALID_INPUT' | 'INVALID_DATA',
): number {
  return boundedInteger(value, 1, maximum, code);
}

function nonNegativeInteger(value: unknown, code: 'INVALID_DATA'): number {
  return boundedInteger(value, 0, INT32_MAX, code);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: 'INVALID_INPUT' | 'INVALID_DATA',
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum
    || (value as number) > maximum || Object.is(value, -0)) throw repositoryError(code);
  return value as number;
}

function timestamp(value: unknown, code: 'INVALID_INPUT' | 'INVALID_DATA'): number {
  return boundedInteger(value, 0, DATE_MAX_MS, code);
}

function timestampFromDatabase(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/u.test(value)) throw dataError();
  const timestampMs = Number(value);
  return timestamp(timestampMs, 'INVALID_DATA');
}

function nullableTimestampFromDatabase(value: unknown): number | null {
  return value === null ? null : timestampFromDatabase(value);
}

function u64(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(value)) throw dataError();
  const amount = BigInt(value);
  if (amount > U64_MAX) throw dataError();
  return amount;
}

function nullableU64(value: unknown): bigint | null {
  return value === null ? null : u64(value);
}

function stateRevision(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(value)) throw dataError();
  const revision = BigInt(value);
  if (revision > INT64_MAX) throw dataError();
  return revision;
}

function attemptConflictError(): ExecutionIntentRepositoryError {
  return repositoryError('ATTEMPT_CONFLICT');
}

function attemptExhaustedError(): ExecutionIntentRepositoryError {
  return repositoryError('ATTEMPT_EXHAUSTED');
}

function duplicateError(): ExecutionIntentRepositoryError {
  return repositoryError('INTENT_DUPLICATE');
}

function leaseLostError(): ExecutionIntentRepositoryError {
  return repositoryError('INTENT_LEASE_LOST');
}

function operationAbortedError(): ExecutionIntentRepositoryError {
  return repositoryError('OPERATION_ABORTED');
}

function inputError(): ExecutionIntentRepositoryError {
  return repositoryError('INVALID_INPUT');
}

function dataError(): ExecutionIntentRepositoryError {
  return repositoryError('INVALID_DATA');
}

function databaseError(failureCount: number): ExecutionIntentRepositoryError {
  const count = Math.max(1, failureCount);
  const cause = new AggregateError(
    Array.from({ length: count }, () => new Error('Execution intent database operation or cleanup failed.')),
    'Execution intent database failures were aggregated.',
  );
  return repositoryError('DATABASE_FAILURE', { cause });
}

function repositoryError(
  code: ExecutionIntentRepositoryErrorCode,
  options?: ErrorOptions,
): ExecutionIntentRepositoryError {
  const error = options === undefined
    ? new ExecutionIntentRepositoryError(code)
    : new ExecutionIntentRepositoryError(code, options);
  INTERNAL_ERRORS.add(error);
  return error;
}

function isInternalError(value: unknown): value is ExecutionIntentRepositoryError {
  return typeof value === 'object' && value !== null
    && INTERNAL_ERRORS.has(value as ExecutionIntentRepositoryError);
}

function abortBeforeClaim(client: ExecutionIntentClient): never {
  try {
    client.release();
  } catch {
    try { client.release(true); } catch { /* The fixed database error remains authoritative. */ }
    throw databaseError(1);
  }
  throw operationAbortedError();
}

function requiredRow(rows: readonly Row[]): Row {
  const row = rows[0];
  if (row === undefined) throw dataError();
  return row;
}

function requireOneMutation(result: QueryResult): void {
  if (result.rowCount !== 1) throw dataError();
}

function fencedBooleanMutation(result: QueryResult): boolean {
  if (result.rowCount === 0) throw leaseLostError();
  if (result.rowCount !== 1) throw dataError();
  return true;
}
