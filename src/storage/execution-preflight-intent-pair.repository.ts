import type { ExecutionIntentDraftV1 } from '../domain/execution-intent.js';
import {
  createExecutionPreflightIntentPairDraft,
  type ExecutionPreflightIntentPairDraftV1,
} from '../domain/execution-preflight-intent-pair.js';
import {
  createExecutionIntentInTransaction,
  ExecutionIntentRepositoryError,
} from './execution-intent.repository.js';

type Row = Readonly<Record<string, unknown>>;

interface QueryResult {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface ExecutionPreflightIntentPairTransactionClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
}

export type ExecutionPreflightIntentPairRepositoryErrorCode =
  | 'PAIR_DUPLICATE'
  | 'DATABASE_FAILURE';

export class ExecutionPreflightIntentPairRepositoryError extends Error {
  public constructor(
    public readonly code: ExecutionPreflightIntentPairRepositoryErrorCode,
    options?: ErrorOptions,
  ) {
    super('Execution preflight intent pair persistence failed.', options);
    this.name = 'ExecutionPreflightIntentPairRepositoryError';
  }
}

const PAIR_PROJECTION = `
  pair.pair_id,
  pair.payload_version,
  pair.pair_fingerprint,
  pair.target_intent_id,
  pair.simulation_intent_id,
  pair.decision_event_id,
  pair.decision_fingerprint,
  trunc(EXTRACT(EPOCH FROM pair.expires_at) * 1000)::TEXT AS expires_at_ms`;

export async function createExecutionPreflightIntentPairInTransaction(
  client: ExecutionPreflightIntentPairTransactionClient,
  targetDraft: ExecutionIntentDraftV1,
): Promise<Readonly<{
  readonly kind: 'CREATED' | 'REPLAYED';
  readonly pair: ExecutionPreflightIntentPairDraftV1;
}>> {
  const draft = createExecutionPreflightIntentPairDraft(targetDraft);
  try {
    await createExecutionIntentInTransaction(client, draft.simulationIntent);
    const inserted = await client.query(
      `INSERT INTO execution_preflight_intent_pairs AS pair (
         pair_id,payload_version,pair_fingerprint,target_intent_id,
         simulation_intent_id,decision_event_id,decision_fingerprint,expires_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,
         TIMESTAMPTZ 'epoch' + ($8::BIGINT * INTERVAL '1 millisecond')
       )
       ON CONFLICT DO NOTHING
       RETURNING ${PAIR_PROJECTION}`,
      pairValues(draft),
    );
    if (inserted.rowCount === 1 && inserted.rows.length === 1) {
      if (!samePair(draft, inserted.rows[0])) throw duplicateError();
      return Object.freeze({ kind: 'CREATED', pair: draft });
    }
    if (inserted.rowCount !== 0 || inserted.rows.length !== 0) throw duplicateError();

    const conflict = await selectPair(client, draft);
    if (conflict.rowCount !== 1 || conflict.rows.length !== 1
      || !samePair(draft, conflict.rows[0])) throw duplicateError();
    return Object.freeze({ kind: 'REPLAYED', pair: draft });
  } catch (error: unknown) {
    if (error instanceof ExecutionPreflightIntentPairRepositoryError) throw error;
    if (error instanceof ExecutionIntentRepositoryError && error.code === 'INTENT_DUPLICATE') {
      throw duplicateError();
    }
    throw new ExecutionPreflightIntentPairRepositoryError('DATABASE_FAILURE', { cause: error });
  }
}

export async function replayExecutionPreflightIntentPairInTransaction(
  client: ExecutionPreflightIntentPairTransactionClient,
  targetDraft: ExecutionIntentDraftV1,
): Promise<'ABSENT' | 'REPLAYED'> {
  const draft = createExecutionPreflightIntentPairDraft(targetDraft);
  try {
    const conflict = await selectPair(client, draft);
    if (conflict.rowCount === 0 && conflict.rows.length === 0) return 'ABSENT';
    if (conflict.rowCount !== 1 || conflict.rows.length !== 1
      || !samePair(draft, conflict.rows[0])) throw duplicateError();
    return 'REPLAYED';
  } catch (error: unknown) {
    if (error instanceof ExecutionPreflightIntentPairRepositoryError) throw error;
    throw new ExecutionPreflightIntentPairRepositoryError('DATABASE_FAILURE', { cause: error });
  }
}

function pairValues(draft: ExecutionPreflightIntentPairDraftV1): readonly unknown[] {
  return [
    draft.pairId,
    draft.payloadVersion,
    draft.pairFingerprint,
    draft.targetIntentId,
    draft.simulationIntent.id,
    draft.decisionEventId,
    draft.decisionFingerprint,
    draft.expiresAtMs,
  ];
}

function selectPair(
  client: ExecutionPreflightIntentPairTransactionClient,
  draft: ExecutionPreflightIntentPairDraftV1,
): Promise<QueryResult> {
  return client.query(
    `SELECT ${PAIR_PROJECTION}
     FROM execution_preflight_intent_pairs AS pair
     WHERE pair.pair_id = $1
        OR pair.target_intent_id = $2
        OR pair.simulation_intent_id = $3
     ORDER BY CASE WHEN pair.pair_id = $1 THEN 0 ELSE 1 END,pair.pair_id`,
    [draft.pairId, draft.targetIntentId, draft.simulationIntent.id],
  );
}

function samePair(draft: ExecutionPreflightIntentPairDraftV1, row: Row | undefined): boolean {
  if (row === undefined) return false;
  return row.pair_id === draft.pairId
    && row.payload_version === draft.payloadVersion
    && row.pair_fingerprint === draft.pairFingerprint
    && row.target_intent_id === draft.targetIntentId
    && row.simulation_intent_id === draft.simulationIntent.id
    && row.decision_event_id === draft.decisionEventId
    && row.decision_fingerprint === draft.decisionFingerprint
    && row.expires_at_ms === String(draft.expiresAtMs);
}

function duplicateError(): ExecutionPreflightIntentPairRepositoryError {
  return new ExecutionPreflightIntentPairRepositoryError('PAIR_DUPLICATE');
}
