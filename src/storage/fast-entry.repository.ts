import { createExecutionDecisionFingerprint } from '../application/execution-intent-producer.js';
import { createDeterministicDerivedEventId, type DomainEvent } from '../domain/events.js';
import { createExecutionIntentDraft, type ExecutionQuoteTokenProgram } from '../domain/execution-intent.js';
import {
  createEntryDecisionId,
  FAST_ENTRY_INTENT_TTL_MS,
  FAST_ENTRY_PROBE_STRATEGY_ID,
  FAST_ENTRY_RETENTION_MS,
  FAST_ENTRY_STRATEGY_ID,
  type FastEntryEnvelope,
  type FastEntryRejection,
} from '../domain/fast-entry.js';
import type { PaperExecutionQuote } from '../domain/paper-trading.js';
import type { ChainConfirmationStatus } from '../domain/types.js';
import { fromJsonValue } from '../utils/json.js';
import {
  createExecutionIntentInTransaction,
  type ExecutionIntentTransactionClient,
} from './execution-intent.repository.js';
import { FOUNDATION_RETENTION_SHARED_FENCE_SQL } from './foundation-retention-fence.js';
import { insertDomainEventWithRaw } from './paper-decision.repository.js';
import { lockWorkerTrackingMints } from './worker-tracking-mint-lock.js';

type Row = Readonly<Record<string, unknown>>;
interface Result { readonly rows: readonly Row[]; readonly rowCount: number | null }
interface Client extends ExecutionIntentTransactionClient {
  query(text: string, values?: readonly unknown[]): Promise<Result>;
  release(): void;
}
interface Pool {
  query(text: string, values?: readonly unknown[]): Promise<Result>;
  connect(): Promise<Client>;
}

export interface FastEntryLaunchContext {
  readonly mint: string;
  readonly quoteMint: string;
  readonly quoteDecimals: number;
  readonly quoteTokenProgram: ExecutionQuoteTokenProgram;
  readonly creator: string;
  readonly createSlot: bigint;
  readonly createBlockTimeMs: number | null;
  readonly launchEvent: DomainEvent;
  readonly creatorSoldInCreate: boolean;
}

export interface FastEntryRejectionInput {
  readonly launch: FastEntryLaunchContext;
  readonly decidedAtMs: number;
  readonly reason: FastEntryRejection;
  readonly roundTripLossBps: bigint | null;
  readonly buyQuote: PaperExecutionQuote | null;
  readonly reverseQuote: PaperExecutionQuote | null;
  readonly envelopeId: string | null;
}

export interface FastEntryBuyInput {
  readonly launch: FastEntryLaunchContext;
  readonly decidedAtMs: number;
  readonly envelope: FastEntryEnvelope;
  readonly buyQuote: PaperExecutionQuote;
  readonly reverseQuote: PaperExecutionQuote;
  readonly roundTripLossBps: bigint;
}

export interface FastEntryProbeInput {
  readonly launch: FastEntryLaunchContext;
  readonly decidedAtMs: number;
  readonly buyQuote: PaperExecutionQuote;
  readonly intervalMs: number;
}

export type FastEntryProbeResult =
  | { readonly kind: 'RECORDED'; readonly intentId: string }
  | { readonly kind: 'SKIPPED' };

export type FastEntryBuyResult =
  | { readonly kind: 'RECORDED'; readonly intentId: string }
  | { readonly kind: 'ALREADY_DECIDED' };

const LAUNCH_SQL = `SELECT launch.mint,launch.creator,launch.quote_assets,
    launch_event.event_id,launch_event.type,launch_event.mint AS event_mint,launch_event.source,
    launch_event.program,launch_event.signature,launch_event.slot::TEXT AS slot,
    launch_event.transaction_index,launch_event.instruction_index,
    launch_event.inner_instruction_index,launch_event.confirmation_status,
    launch_event.blockchain_time,launch_event.observed_at,launch_event.payload_version,
    launch_event.payload,
    EXISTS (
      SELECT 1 FROM domain_events AS trade
      WHERE trade.type='BondingCurveTradeObserved'
        AND trade.mint=launch.mint
        AND trade.signature=launch.created_signature
        AND trade.confirmation_status<>'orphaned'
        AND trade.payload->'trade'->>'kind'='SELL'
        AND trade.payload->'trade'->>'trader'=launch.creator
    ) AS creator_sold_in_create
  FROM token_launches AS launch
  JOIN domain_events AS launch_event
    ON launch_event.type='TokenLaunchDetected'
   AND launch_event.mint=launch.mint
   AND launch_event.signature=launch.created_signature
   AND launch_event.slot=launch.created_slot
   AND launch_event.transaction_index=launch.created_transaction_index
   AND launch_event.instruction_index=launch.created_instruction_index
   AND launch_event.inner_instruction_index IS NOT DISTINCT FROM
     launch.created_inner_instruction_index
  WHERE launch.mint=$1 AND launch.created_signature=$2
    AND launch_event.confirmation_status<>'orphaned'
    AND NOT EXISTS (SELECT 1 FROM entry_decisions AS decision WHERE decision.mint=launch.mint)`;

const ENVELOPE_SQL = `SELECT envelope_id,per_buy_quote_amount_raw::TEXT AS per_buy
  FROM execution_entry_envelopes
  WHERE state='ACTIVE' AND valid_from <= $1 AND valid_until > $1 AND buys_armed < max_buys
  ORDER BY created_at,envelope_id
  LIMIT 1`;

// Serializes probes across listener processes; checked again under the lock. Any ACTIVE envelope
// stops probing (stricter than "no ACTIVE v2"; the listener role cannot read payload_version).
const PROBE_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('fast-entry-probe:v1', 0))`;
const PROBE_DUE_SQL = `SELECT
    NOT EXISTS (SELECT 1 FROM execution_entry_envelopes WHERE state='ACTIVE')
    AND NOT EXISTS (SELECT 1 FROM execution_intents
      WHERE strategy_id=$1 AND requested_at > $2) AS due`;

const INSERT_DECISION_SQL = `INSERT INTO entry_decisions (
    decision_id,mint,launch_event_id,create_slot,create_block_time,observed_at,decided_at,
    entry_mode,decision,reason_code,round_trip_loss_bps,buy_quote,reverse_quote,intent_id,
    envelope_id,purge_after
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,'fast',$8,$9,$10,$11,$12,$13,$14,$15)
  ON CONFLICT (mint) DO NOTHING`;

export class PostgresFastEntryRepository {
  public constructor(private readonly pool: Pool) {}

  public async readLaunchForSignature(
    mint: string,
    signature: string,
  ): Promise<FastEntryLaunchContext | null> {
    const result = await this.pool.query(LAUNCH_SQL, [mint, signature]);
    const row = result.rows[0];
    if (row === undefined) return null;
    const quoteAssets = fromJsonValue(row.quote_assets);
    const first: unknown = Array.isArray(quoteAssets) ? quoteAssets[0] : undefined;
    // A launch without a quote asset cannot be quoted; the decider never sees it.
    if (typeof first !== 'object' || first === null) return null;
    const quote = first as Row;
    const launchEvent = launchEventFromRow(row);
    return Object.freeze({
      mint: text(row.mint),
      quoteMint: text(quote.mint),
      quoteDecimals: integer(quote.decimals),
      quoteTokenProgram: tokenProgram(quote.tokenProgram),
      creator: text(row.creator),
      createSlot: launchEvent.cursor.slot,
      createBlockTimeMs: launchEvent.blockchainTimeMs,
      launchEvent,
      creatorSoldInCreate: row.creator_sold_in_create === true,
    });
  }

  public async readActiveEnvelope(nowMs: number): Promise<FastEntryEnvelope | null> {
    const result = await this.pool.query(ENVELOPE_SQL, [new Date(nowMs)]);
    const row = result.rows[0];
    if (row === undefined) return null;
    return Object.freeze({
      envelopeId: text(row.envelope_id),
      perBuyQuoteAmountRaw: BigInt(text(row.per_buy)),
    });
  }

  public async recordRejection(input: FastEntryRejectionInput): Promise<'RECORDED' | 'ALREADY_DECIDED'> {
    const result = await this.pool.query(INSERT_DECISION_SQL, decisionValues(input.launch, input.decidedAtMs, {
      decision: 'REJECTED',
      reason: input.reason,
      roundTripLossBps: input.roundTripLossBps,
      buyQuote: input.buyQuote,
      reverseQuote: input.reverseQuote,
      intentId: null,
      envelopeId: input.envelopeId,
    }));
    return result.rowCount === 1 ? 'RECORDED' : 'ALREADY_DECIDED';
  }

  public async recordBuy(input: FastEntryBuyInput): Promise<FastEntryBuyResult> {
    const { launch, decidedAtMs } = input;
    const decisionId = createEntryDecisionId(launch.mint);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query(FOUNDATION_RETENTION_SHARED_FENCE_SQL);
      await lockWorkerTrackingMints(client, [launch.mint]);
      const existing = await client.query('SELECT 1 FROM entry_decisions WHERE mint=$1', [launch.mint]);
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return Object.freeze({ kind: 'ALREADY_DECIDED' });
      }
      const event = fastEntryDecidedEvent(launch, decisionId, {
        envelopeId: input.envelope.envelopeId,
        buyQuote: serializeQuote(input.buyQuote),
        reverseQuote: serializeQuote(input.reverseQuote),
        roundTripLossBps: input.roundTripLossBps.toString(),
      });
      await insertDomainEventWithRaw(client, null, event);
      const draft = createExecutionIntentDraft({
        strategyId: FAST_ENTRY_STRATEGY_ID,
        strategyVersion: 1,
        positionId: `fast_position_${decisionId.slice('entry_decision_'.length)}`,
        candidateId: null,
        logicalCommandId: decisionId,
        mint: launch.mint,
        side: 'BUY',
        venuePolicy: 'PUMP_FUN_ONLY',
        quoteMint: launch.quoteMint,
        quoteTokenProgram: launch.quoteTokenProgram,
        quoteDecimals: launch.quoteDecimals,
        quoteAmountRaw: input.buyQuote.amountInRaw,
        baseAmountRaw: null,
        minimumAmountOutRaw: input.buyQuote.minimumAmountOutRaw,
        decisionEventId: event.id,
        decisionFingerprint: createExecutionDecisionFingerprint(event),
        requestedAtMs: decidedAtMs,
        expiresAtMs: decidedAtMs + FAST_ENTRY_INTENT_TTL_MS,
      });
      const created = await createExecutionIntentInTransaction(client, draft);
      const inserted = await client.query(INSERT_DECISION_SQL, decisionValues(launch, decidedAtMs, {
        decision: 'BUY',
        reason: null,
        roundTripLossBps: input.roundTripLossBps,
        buyQuote: input.buyQuote,
        reverseQuote: input.reverseQuote,
        intentId: created.intent.id,
        envelopeId: input.envelope.envelopeId,
      }));
      if (inserted.rowCount !== 1) throw new Error('Fast entry decision insert was not applied.');
      await client.query('COMMIT');
      return Object.freeze({ kind: 'RECORDED', intentId: created.intent.id });
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Writes one unarmable probe BUY intent for the simulation-only worker (gate 10), unless an
   * envelope is ACTIVE or a probe was requested within the interval. No entry decision is
   * written: the mint keeps its NO_ENVELOPE_CAPACITY rejection, so the funnel is unchanged.
   */
  public async recordProbe(input: FastEntryProbeInput): Promise<FastEntryProbeResult> {
    const { launch, decidedAtMs } = input;
    const suffix = createEntryDecisionId(launch.mint).slice('entry_decision_'.length);
    const client = await this.pool.connect();
    try {
      // READ COMMITTED: the check below must see a probe committed while waiting for the lock.
      await client.query('BEGIN');
      await client.query(FOUNDATION_RETENTION_SHARED_FENCE_SQL);
      await client.query(PROBE_LOCK_SQL);
      const due = await client.query(PROBE_DUE_SQL, [
        FAST_ENTRY_PROBE_STRATEGY_ID, new Date(decidedAtMs - input.intervalMs),
      ]);
      if (due.rows[0]?.due !== true) {
        await client.query('ROLLBACK');
        return Object.freeze({ kind: 'SKIPPED' });
      }
      const event = fastEntryDecidedEvent(launch, `entry_probe_${suffix}`, {
        probe: true, envelopeId: null, buyQuote: serializeQuote(input.buyQuote),
      });
      await insertDomainEventWithRaw(client, null, event);
      const created = await createExecutionIntentInTransaction(client, createExecutionIntentDraft({
        strategyId: FAST_ENTRY_PROBE_STRATEGY_ID,
        strategyVersion: 1,
        positionId: `fast_probe_position_${suffix}`,
        candidateId: null,
        logicalCommandId: `entry_probe_${suffix}`,
        mint: launch.mint,
        side: 'BUY',
        venuePolicy: 'PUMP_FUN_ONLY',
        quoteMint: launch.quoteMint,
        quoteTokenProgram: launch.quoteTokenProgram,
        quoteDecimals: launch.quoteDecimals,
        quoteAmountRaw: input.buyQuote.amountInRaw,
        baseAmountRaw: null,
        minimumAmountOutRaw: input.buyQuote.minimumAmountOutRaw,
        decisionEventId: event.id,
        decisionFingerprint: createExecutionDecisionFingerprint(event),
        requestedAtMs: decidedAtMs,
        expiresAtMs: decidedAtMs + FAST_ENTRY_INTENT_TTL_MS,
      }));
      await client.query('COMMIT');
      return Object.freeze({ kind: 'RECORDED', intentId: created.intent.id });
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function fastEntryDecidedEvent(
  launch: FastEntryLaunchContext,
  decisionId: string,
  payload: Readonly<Record<string, unknown>>,
): DomainEvent {
  const launchEvent = launch.launchEvent;
  const type = 'FastEntryDecided';
  const source = 'fast-entry';
  return Object.freeze({
    id: createDeterministicDerivedEventId({
      type,
      mint: launch.mint,
      source,
      program: launchEvent.program,
      signature: launchEvent.signature,
      cursor: launchEvent.cursor,
      qualifier: decisionId,
    }),
    type,
    mint: launch.mint,
    source,
    program: launchEvent.program,
    signature: launchEvent.signature,
    cursor: launchEvent.cursor,
    confirmationStatus: launchEvent.confirmationStatus,
    blockchainTimeMs: launchEvent.blockchainTimeMs,
    observedAtMs: launchEvent.observedAtMs,
    payloadVersion: 1,
    payload: Object.freeze({ decisionId, ...payload }),
  });
}

function decisionValues(
  launch: FastEntryLaunchContext,
  decidedAtMs: number,
  decision: Readonly<{
    decision: 'BUY' | 'REJECTED';
    reason: FastEntryRejection | null;
    roundTripLossBps: bigint | null;
    buyQuote: PaperExecutionQuote | null;
    reverseQuote: PaperExecutionQuote | null;
    intentId: string | null;
    envelopeId: string | null;
  }>,
): unknown[] {
  return [
    createEntryDecisionId(launch.mint),
    launch.mint,
    launch.launchEvent.id,
    launch.createSlot.toString(),
    launch.createBlockTimeMs === null ? null : new Date(launch.createBlockTimeMs),
    new Date(launch.launchEvent.observedAtMs),
    new Date(decidedAtMs),
    decision.decision,
    decision.reason,
    decision.roundTripLossBps === null ? null : Number(decision.roundTripLossBps),
    decision.buyQuote === null ? null : serializeQuote(decision.buyQuote),
    decision.reverseQuote === null ? null : serializeQuote(decision.reverseQuote),
    decision.intentId,
    decision.envelopeId,
    new Date(decidedAtMs + FAST_ENTRY_RETENTION_MS),
  ];
}

/** Quote as JSON with every bigint as a decimal string. */
function serializeQuote(quote: PaperExecutionQuote): Readonly<Record<string, string | number>> {
  return Object.freeze({
    id: quote.id,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    amountInRaw: quote.amountInRaw.toString(),
    amountOutRaw: quote.amountOutRaw.toString(),
    minimumAmountOutRaw: quote.minimumAmountOutRaw.toString(),
    feesRaw: quote.feesRaw.toString(),
    slippageBps: quote.slippageBps.toString(),
    priceImpactBps: quote.priceImpactBps.toString(),
    observedAtMs: quote.observedAtMs,
    observedSlot: quote.observedSlot.toString(),
  });
}

function launchEventFromRow(row: Row): DomainEvent {
  const type = text(row.type);
  if (type !== 'TokenLaunchDetected') throw new TypeError('Fast entry launch event is invalid.');
  const blockchainTime = row.blockchain_time;
  return Object.freeze({
    id: text(row.event_id),
    type,
    mint: text(row.event_mint),
    source: text(row.source),
    program: text(row.program),
    signature: text(row.signature),
    cursor: Object.freeze({
      slot: BigInt(text(row.slot)),
      transactionIndex: integer(row.transaction_index),
      instructionIndex: integer(row.instruction_index),
      innerInstructionIndex: row.inner_instruction_index === null
        ? null
        : integer(row.inner_instruction_index),
    }),
    confirmationStatus: text(row.confirmation_status) as ChainConfirmationStatus,
    blockchainTimeMs: blockchainTime === null ? null : timestamp(blockchainTime),
    observedAtMs: timestamp(row.observed_at),
    payloadVersion: integer(row.payload_version),
    payload: deepFreeze(fromJsonValue(row.payload)) as Readonly<Record<string, unknown>>,
  });
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new TypeError('Fast entry row text is invalid.');
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Fast entry row integer is invalid.');
  }
  return value;
}

function timestamp(value: unknown): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Fast entry row timestamp is invalid.');
  }
  return value.getTime();
}

function tokenProgram(value: unknown): ExecutionQuoteTokenProgram {
  if (value !== 'SPL_TOKEN' && value !== 'TOKEN_2022') {
    throw new TypeError('Fast entry quote token program is invalid.');
  }
  return value;
}
