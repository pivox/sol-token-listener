import { createHash } from 'node:crypto';
import type {
  QueryResultRow,
} from 'pg';
import {
  reconcileConfirmationStatus,
} from '../domain/confirmation-status.js';
import {
  assertValidWalletFundingExtractionResult,
  type WalletFundingAssessment,
  type WalletFundingBuy,
  type WalletFundingEvidence,
} from '../domain/wallet-funding.js';
import type {
  ChainConfirmationStatus,
  ChainCursor,
  QuoteAsset,
} from '../domain/types.js';
import type {
  WalletEvidenceBatch,
  WalletEvidenceRepository,
} from '../ports/wallet-evidence-repository.js';
import {
  stringifyJson,
  toJsonValue,
} from '../utils/json.js';
import {
  getDatabasePool,
} from './database.js';

interface Queryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly QueryResultRow[];
    readonly rowCount: number | null;
  }>;
}

interface EvidenceClient extends Queryable {
  release(): void;
}

interface EvidencePool {
  connect(): Promise<EvidenceClient>;
}

interface StoredEvidenceRow extends QueryResultRow {
  readonly immutable_fingerprint: unknown;
  readonly confirmation_status: unknown;
}

export class WalletEvidencePersistenceError extends Error {
  public constructor(cause: unknown) {
    super('Wallet evidence persistence failed.', { cause });
    this.name = 'WalletEvidencePersistenceError';
  }
}

export class WalletEvidenceImmutableConflictError extends Error {
  public constructor(
    public readonly table: string,
    public readonly id: string,
  ) {
    super(`Stored wallet evidence immutable payload conflicts in ${table}.`);
    this.name = 'WalletEvidenceImmutableConflictError';
  }
}

export class PostgresWalletEvidenceRepository
implements WalletEvidenceRepository {
  public constructor(
    private readonly pool: EvidencePool = getDatabasePool(),
  ) {}

  public async record(batch: WalletEvidenceBatch): Promise<void> {
    validateBatch(batch);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const assessment of [...batch.assessments].sort((left, right) =>
        left.id.localeCompare(right.id))) {
        await this.upsertAssessment(client, assessment);
      }
      const assessmentByTrade = new Map(
        batch.assessments.map((assessment) => [
          assessment.buy.tradeId,
          assessment,
        ]),
      );
      for (const evidence of [...batch.evidence].sort((left, right) =>
        left.id.localeCompare(right.id))) {
        const assessment = assessmentByTrade.get(evidence.buyTradeId);
        if (assessment === undefined) {
          throw new TypeError('Wallet evidence has no persisted assessment.');
        }
        await this.upsertEvidence(client, assessment.id, evidence);
      }
      await client.query('COMMIT');
    } catch (cause) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackCause) {
        throw new WalletEvidencePersistenceError(
          new AggregateError(
            [cause, rollbackCause],
            'Wallet evidence transaction and rollback failed.',
          ),
        );
      }
      throw new WalletEvidencePersistenceError(cause);
    } finally {
      client.release();
    }
  }

  private async upsertAssessment(
    client: Queryable,
    assessment: WalletFundingAssessment,
  ): Promise<void> {
    const fingerprint = assessmentFingerprint(assessment);
    const stored = await lockStored(
      client,
      'wallet_funding_observations',
      'assessment_id',
      assessment.id,
    );
    if (stored !== null) {
      await reconcileStored(
        client,
        'wallet_funding_observations',
        'assessment_id',
        assessment.id,
        fingerprint,
        stored,
        assessment.buy.confirmationStatus,
        assessment.buy.blockchainTimeMs,
        assessment.buy.observedAtMs,
        toJsonValue(assessment),
      );
      return;
    }
    const { buy } = assessment;
    await client.query(
      `INSERT INTO wallet_funding_observations (
        assessment_id, immutable_fingerprint, mint, trade_event_id, trade_id,
        buyer, source, program, signature, quote_mint, quote_decimals,
        quote_token_program, slot, transaction_index, instruction_index,
        inner_instruction_index, confirmation_status, assessment_status,
        inspected_transfer_count, accepted_evidence_count,
        ignored_transfer_count, diagnostic_codes, payload_version, payload,
        blockchain_time, observed_at, purge_after
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20,$21,$22,$23,$24,$25,$26,
        (SELECT purge_after FROM token_launches WHERE mint = $3)
      )`,
      [
        assessment.id,
        fingerprint,
        buy.mint,
        buy.eventId,
        buy.tradeId,
        buy.buyer,
        buy.source,
        buy.program,
        buy.signature,
        buy.quoteAsset.mint,
        buy.quoteAsset.decimals,
        buy.quoteAsset.tokenProgram,
        buy.cursor.slot.toString(),
        buy.cursor.transactionIndex,
        buy.cursor.instructionIndex,
        buy.cursor.innerInstructionIndex,
        buy.confirmationStatus,
        assessment.status,
        assessment.inspectedTransferCount,
        assessment.acceptedEvidenceCount,
        assessment.ignoredTransferCount,
        toJsonValue(assessment.diagnosticCodes),
        assessment.payloadVersion,
        toJsonValue(assessment),
        dateOrNull(buy.blockchainTimeMs),
        new Date(buy.observedAtMs),
      ],
    );
  }

  private async upsertEvidence(
    client: Queryable,
    assessmentId: string,
    evidence: WalletFundingEvidence,
  ): Promise<void> {
    const fingerprint = evidenceFingerprint(evidence);
    const stored = await lockStored(
      client,
      'wallet_funding_evidence',
      'evidence_id',
      evidence.id,
    );
    if (stored !== null) {
      await reconcileStored(
        client,
        'wallet_funding_evidence',
        'evidence_id',
        evidence.id,
        fingerprint,
        stored,
        evidence.confirmationStatus,
        evidence.blockchainTimeMs,
        evidence.observedAtMs,
        toJsonValue(evidence),
      );
      return;
    }
    const transfer = evidence.transferCursor;
    await client.query(
      `INSERT INTO wallet_funding_evidence (
        evidence_id, immutable_fingerprint, assessment_id, mint, evidence_type,
        confidence, buyer, funder, quote_mint, quote_decimals,
        quote_token_program, amount_raw, source, program, signature,
        transfer_slot, transfer_transaction_index, transfer_instruction_index,
        transfer_inner_instruction_index, buy_event_id, buy_trade_id, buy_slot,
        buy_transaction_index, buy_instruction_index,
        buy_inner_instruction_index, confirmation_status, payload_version,
        payload, blockchain_time, observed_at, purge_after
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        (SELECT purge_after FROM token_launches WHERE mint = $4)
      )`,
      [
        evidence.id,
        fingerprint,
        assessmentId,
        evidence.mint,
        evidence.type,
        evidence.confidence,
        evidence.buyer,
        evidence.funder,
        evidence.quoteAsset.mint,
        evidence.quoteAsset.decimals,
        evidence.quoteAsset.tokenProgram,
        evidence.amountRaw?.toString() ?? null,
        evidence.source,
        evidence.program,
        evidence.signature,
        transfer?.slot.toString() ?? null,
        transfer?.transactionIndex ?? null,
        transfer?.instructionIndex ?? null,
        transfer?.innerInstructionIndex ?? null,
        evidence.buyEventId,
        evidence.buyTradeId,
        evidence.buyCursor.slot.toString(),
        evidence.buyCursor.transactionIndex,
        evidence.buyCursor.instructionIndex,
        evidence.buyCursor.innerInstructionIndex,
        evidence.confirmationStatus,
        evidence.payloadVersion,
        toJsonValue(evidence),
        dateOrNull(evidence.blockchainTimeMs),
        new Date(evidence.observedAtMs),
      ],
    );
  }
}

async function lockStored(
  client: Queryable,
  table: 'wallet_funding_observations' | 'wallet_funding_evidence',
  idColumn: 'assessment_id' | 'evidence_id',
  id: string,
): Promise<StoredEvidenceRow | null> {
  const result = await client.query(
    `SELECT immutable_fingerprint, confirmation_status
     FROM ${table}
     WHERE ${idColumn} = $1
     FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    immutable_fingerprint: row.immutable_fingerprint,
    confirmation_status: row.confirmation_status,
  };
}

async function reconcileStored(
  client: Queryable,
  table: 'wallet_funding_observations' | 'wallet_funding_evidence',
  idColumn: 'assessment_id' | 'evidence_id',
  id: string,
  fingerprint: string,
  stored: StoredEvidenceRow,
  incomingStatus: ChainConfirmationStatus,
  blockchainTimeMs: number | null,
  observedAtMs: number,
  payload: unknown,
): Promise<void> {
  if (stored.immutable_fingerprint !== fingerprint) {
    throw new WalletEvidenceImmutableConflictError(table, id);
  }
  const currentStatus = confirmationStatus(stored.confirmation_status);
  if (reconcileConfirmationStatus(currentStatus, incomingStatus) === 'keep') {
    return;
  }
  await client.query(
    `UPDATE ${table}
     SET confirmation_status = $2,
         blockchain_time = COALESCE(blockchain_time, $3),
         observed_at = LEAST(observed_at, $4),
         payload = $5
     WHERE ${idColumn} = $1`,
    [
      id,
      incomingStatus,
      dateOrNull(blockchainTimeMs),
      new Date(observedAtMs),
      payload,
    ],
  );
}

function validateBatch(batch: WalletEvidenceBatch): void {
  if (
    !Object.isFrozen(batch)
    || !Object.isFrozen(batch.assessments)
    || !Object.isFrozen(batch.evidence)
    || typeof batch.signature !== 'string'
    || batch.signature.length === 0
  ) {
    throw new TypeError('Wallet evidence batch is invalid.');
  }
  assertValidWalletFundingExtractionResult(Object.freeze({
    assessments: batch.assessments,
    evidence: batch.evidence,
  }));
  for (const assessment of batch.assessments) {
    if (
      assessment.buy.signature !== batch.signature
      || assessment.buy.confirmationStatus !== batch.confirmationStatus
    ) {
      throw new TypeError('Wallet evidence assessment does not match its batch.');
    }
  }
  for (const evidence of batch.evidence) {
    if (
      evidence.signature !== batch.signature
      || evidence.confirmationStatus !== batch.confirmationStatus
    ) {
      throw new TypeError('Wallet funding evidence does not match its batch.');
    }
  }
}

function assessmentFingerprint(
  assessment: WalletFundingAssessment,
): string {
  return fingerprint([
    assessment.id,
    buyFingerprintValues(assessment.buy),
    assessment.status,
    assessment.inspectedTransferCount,
    assessment.acceptedEvidenceCount,
    assessment.ignoredTransferCount,
    assessment.diagnosticCodes,
    assessment.payloadVersion,
  ]);
}

function evidenceFingerprint(evidence: WalletFundingEvidence): string {
  return fingerprint([
    evidence.id,
    evidence.type,
    evidence.confidence,
    evidence.mint,
    evidence.buyer,
    evidence.funder,
    quoteAssetValues(evidence.quoteAsset),
    evidence.amountRaw,
    evidence.source,
    evidence.program,
    evidence.signature,
    cursorValues(evidence.transferCursor),
    evidence.buyEventId,
    evidence.buyTradeId,
    cursorValues(evidence.buyCursor),
    evidence.payloadVersion,
  ]);
}

function buyFingerprintValues(buy: WalletFundingBuy): readonly unknown[] {
  return [
    buy.eventId,
    buy.tradeId,
    buy.mint,
    buy.buyer,
    buy.source,
    buy.program,
    quoteAssetValues(buy.quoteAsset),
    buy.signature,
    cursorValues(buy.cursor),
  ];
}

function quoteAssetValues(asset: QuoteAsset): readonly unknown[] {
  return [asset.mint, asset.decimals, asset.tokenProgram];
}

function cursorValues(cursor: ChainCursor | null): readonly unknown[] | null {
  return cursor === null
    ? null
    : [
      cursor.slot,
      cursor.transactionIndex,
      cursor.instructionIndex,
      cursor.innerInstructionIndex,
    ];
}

function fingerprint(values: readonly unknown[]): string {
  return createHash('sha256').update(stringifyJson(values)).digest('hex');
}

function confirmationStatus(value: unknown): ChainConfirmationStatus {
  if (
    value !== 'processed'
    && value !== 'confirmed'
    && value !== 'finalized'
    && value !== 'orphaned'
  ) {
    throw new TypeError('Stored wallet evidence confirmation is invalid.');
  }
  return value;
}

function dateOrNull(timestampMs: number | null): Date | null {
  return timestampMs === null ? null : new Date(timestampMs);
}
