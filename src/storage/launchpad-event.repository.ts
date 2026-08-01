import {
  createBondingCurveTradeObservedEvent,
  createTokenLaunchDetectedEvent,
  type LaunchpadObservationEventV1,
} from '../domain/launchpad-events.js';
import { reconcileConfirmationStatus } from '../domain/confirmation-status.js';
import { reconcileTransitionOccurrence } from '../domain/state-transitions.js';
import type { InitialDetectedStateTransition } from '../domain/state-transitions.js';
import type { ChainConfirmationStatus } from '../domain/types.js';
import type { LaunchpadTrade, TokenLaunch } from '../domain/types.js';
import {
  assertValidLaunchpadEventBatch,
  type EventRecordOutcome,
  type LaunchpadEventBatch,
  type LaunchpadEventBatchResult,
  type LaunchpadEventSink,
} from '../ports/launchpad-event-sink.js';
import type { LaunchpadProjectionReader } from '../ports/launchpad-projection-reader.js';
import {
  canonicalStringifyJson,
  fromJsonValue,
  MAX_CANONICAL_JSON_STRING_BYTES,
  MAX_CANONICAL_JSON_TEXT_BYTES,
  stringifyJson,
  toJsonValue,
} from '../utils/json.js';
import { getDatabasePool } from './database.js';
import { createRepositoryId } from './repositories.js';

interface Result { readonly rows: readonly unknown[]; readonly rowCount?: number | null }
interface Client { query(text: string, values?: readonly unknown[]): Promise<Result>; release(): void }
interface Pool { connect(): Promise<Client>; query?(text: string, values?: readonly unknown[]): Promise<Result> }
const trustedErrors = new WeakSet();

export class LaunchpadEventConflictError extends Error {
  public constructor(public readonly conflict: 'identity' | 'payload') {
    super('Launchpad event immutable state conflicts.');
    this.name = 'LaunchpadEventConflictError';
  }
}

export class LaunchpadEventRepositoryError extends Error {
  public constructor(public readonly operation: 'record' | 'read') {
    super('Launchpad event repository operation failed.');
    this.name = 'LaunchpadEventRepositoryError';
  }
}

export class PostgresLaunchpadEventRepository
implements LaunchpadEventSink, LaunchpadProjectionReader {
  public constructor(
    private readonly pool: Pool = getDatabasePool(),
    private readonly retentionHours = 4,
    private readonly now: () => number = Date.now,
  ) {}

  public async record(input: LaunchpadEventBatch): Promise<LaunchpadEventBatchResult> {
    const batch = prepareLaunchpadBatch(input);
    const ids = new Set<string>();
    for (const event of batch.events) {
      if (ids.has(event.id)) throw conflict('identity');
      ids.add(event.id);
      assertEventFingerprint(event);
    }
    const terminal = this.terminal(batch.confirmationStatus);
    const transitionsByEventId = new Map(
      batch.transitions.map((transition) => [transition.triggeringEventId, transition]),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let client: Client;
      try { client = await this.pool.connect(); } catch { throw new LaunchpadEventRepositoryError('record'); }
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [batch.signature]);
        const byId = new Map<string, EventRecordOutcome>();
        const ordered = [...batch.events].sort((left, right) =>
          left.type === right.type ? 0 : left.type === 'TokenLaunchDetected' ? -1 : 1);
        for (const event of ordered) {
          byId.set(event.id, await this.writeEvent(
            client,
            event,
            transitionsByEventId.get(event.id),
            terminal,
          ));
        }
        await client.query('COMMIT');
        return Object.freeze({
          events: Object.freeze(batch.events.map((event) => Object.freeze({
            eventId: event.id,
            outcome: requiredOutcome(byId, event.id),
          }))),
          affectedMints: Object.freeze(
            [...new Set(batch.events.map((event) => event.mint))].sort(),
          ),
        });
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { throw new LaunchpadEventRepositoryError('record'); }
        if (typeof error === 'object' && error !== null && trustedErrors.has(error)) throw error;
        if (attempt === 2) throw new LaunchpadEventRepositoryError('record');
      } finally { releaseClient(client, 'record'); }
    }
    throw new LaunchpadEventRepositoryError('record');
  }

  public async listTrackedMints(): Promise<ReadonlySet<string>> {
    return this.read(async (client) => {
      const result = await client.query(`SELECT mint FROM token_launches
        WHERE terminal_at IS NULL ORDER BY mint`);
      const values = result.rows.map((row) => requiredText(row, 'mint'));
      return immutableSet(values);
    });
  }

  public async listActiveEventsBySignature(signature: string): Promise<readonly LaunchpadObservationEventV1[]> {
    return this.read(async (client) => {
      const result = await client.query(`SELECT domain.event_id,domain.raw_event_id,
        domain.type,domain.mint,domain.source,domain.program,domain.signature,
        domain.slot::text AS slot,domain.transaction_index,domain.instruction_index,
        domain.inner_instruction_index,domain.confirmation_status,
        domain.blockchain_time,domain.observed_at,domain.payload_version,domain.payload,
        raw.payload AS raw_payload,raw.confirmation_status AS raw_confirmation_status
        FROM domain_events AS domain
        JOIN raw_chain_events AS raw ON raw.event_id=domain.raw_event_id
        WHERE domain.signature=$1 AND domain.confirmation_status <> 'orphaned'
          AND domain.terminal_at IS NULL
        ORDER BY domain.slot,domain.transaction_index,domain.instruction_index,
          COALESCE(domain.inner_instruction_index,-1),domain.event_id`, [signature]);
      return Object.freeze(result.rows.map(restoreEvent));
    });
  }

  private async read<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    let client: Client;
    try { client = await this.pool.connect(); } catch { throw new LaunchpadEventRepositoryError('read'); }
    try { return await operation(client); }
    catch { throw new LaunchpadEventRepositoryError('read'); }
    finally { releaseClient(client, 'read'); }
  }

  private async writeEvent(
    client: Client,
    event: LaunchpadObservationEventV1,
    transition: InitialDetectedStateTransition | undefined,
    terminal: readonly [Date | null, Date | null],
  ): Promise<EventRecordOutcome> {
    const rawPayload = rawSnapshot(event);
    const rawId = rawFingerprint(event.id);
    const found = await client.query(`SELECT event_id,source,program,mint,signature,
      slot::text AS slot,transaction_index,instruction_index,inner_instruction_index,
      payload_version,payload,confirmation_status FROM raw_chain_events
      WHERE event_id=$1 FOR UPDATE`, [rawId]);
    const current = found.rows[0];
    let status = event.confirmationStatus;
    let outcome: EventRecordOutcome = 'created';
    let becameOrphaned = false;
    if (current !== undefined) {
      assertRawMatches(current, event, rawPayload);
      const oldStatus = confirmation(requiredText(current, 'confirmation_status'));
      const reconciliation = reconcileStatus(oldStatus, status);
      status = reconciliation === 'update' ? status : oldStatus;
      outcome = reconciliation === 'update' ? 'confirmation_updated' : 'duplicate';
      becameOrphaned = reconciliation === 'update' && status === 'orphaned';
      if (reconciliation === 'update') await exact(client, `UPDATE raw_chain_events SET
        confirmation_status=$2,terminal_at=$3,purge_after=$4,updated_at=clock_timestamp()
        WHERE event_id=$1`, [rawId, status, ...terminal]);
    } else {
      await exact(client, `INSERT INTO raw_chain_events (
        event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
        inner_instruction_index,confirmation_status,blockchain_time,observed_at,
        payload_version,payload,processing_status,terminal_at,purge_after
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'processed',$15,$16)`, [
        rawId,event.source,event.program,event.mint,event.signature,event.cursor.slot.toString(),
        event.cursor.transactionIndex,event.cursor.instructionIndex,event.cursor.innerInstructionIndex,
        status,date(event.blockchainTimeMs),new Date(event.observedAtMs),event.payloadVersion,
        toJsonValue(rawPayload), ...terminal,
      ]);
    }
    if (status === 'orphaned') {
      if (becameOrphaned) await this.retract(client, event, terminal);
      return outcome;
    }
    await this.writeDomain(client, rawId, event, status);
    if (event.type === 'TokenLaunchDetected') {
      if (transition === undefined) throw conflict('identity');
      await this.writeLaunch(client, event, transition);
    }
    else await this.writeTrade(client, event, status);
    return outcome;
  }

  private async writeDomain(client: Client, rawId: string, event: LaunchpadObservationEventV1, status: ChainConfirmationStatus): Promise<void> {
    const existing = await client.query('SELECT raw_event_id,payload,type,mint,source,program,signature,slot::text AS slot,transaction_index,instruction_index,inner_instruction_index,payload_version FROM domain_events WHERE event_id=$1 FOR UPDATE', [event.id]);
    if (existing.rows[0] !== undefined) assertDomainMatches(existing.rows[0], event, rawId);
    const result = await client.query(`INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
      instruction_index,inner_instruction_index,confirmation_status,blockchain_time,
      observed_at,payload_version,payload,terminal_at,purge_after
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NULL,NULL)
    ON CONFLICT (event_id) DO UPDATE SET confirmation_status=EXCLUDED.confirmation_status,
      terminal_at=NULL,purge_after=NULL RETURNING event_id`, [event.id,rawId,event.type,event.mint,
      event.source,event.program,event.signature,event.cursor.slot.toString(),event.cursor.transactionIndex,
      event.cursor.instructionIndex,event.cursor.innerInstructionIndex,status,date(event.blockchainTimeMs),
      new Date(event.observedAtMs),event.payloadVersion,toJsonValue(event.payload)]);
    requireOne(result);
  }

  private async writeLaunch(
    client: Client,
    event: Extract<LaunchpadObservationEventV1, {type: 'TokenLaunchDetected'}>,
    transition: InitialDetectedStateTransition,
  ): Promise<void> {
    const launch = event.payload.launch;
    const existing = await client.query(`SELECT mint,launchpad,program_id,creator,
      token_program,quote_assets,created_signature,created_slot::text AS created_slot,
      created_transaction_index,created_instruction_index,created_inner_instruction_index
      FROM token_launches WHERE mint=$1 FOR UPDATE`, [event.mint]);
    if (existing.rows[0] !== undefined) assertLaunchMatches(existing.rows[0], event);
    const result = await client.query(`INSERT INTO token_launches (
      mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
      created_signature,created_slot,created_transaction_index,created_instruction_index,
      created_inner_instruction_index,detected_at,updated_at,terminal_at,purge_after
    ) VALUES ($1,$2,$3,$4,$5,$6,'DETECTED',$7,$8,$9,$10,$11,$12,$12,NULL,NULL)
    ON CONFLICT (mint) DO UPDATE SET terminal_at=NULL,purge_after=NULL,updated_at=EXCLUDED.updated_at
    RETURNING mint`, [launch.mint,launch.launchpad,event.program,launch.creator,launch.tokenProgram,
      stringifyJson(launch.quoteAssets),event.signature,launch.createdAt.slot.toString(),launch.createdAt.transactionIndex,
      launch.createdAt.instructionIndex,launch.createdAt.innerInstructionIndex,new Date(event.blockchainTimeMs ?? event.observedAtMs)]);
    requireOne(result);
    await writeTransition(client, transition);
  }

  private async writeTrade(client: Client, event: Extract<LaunchpadObservationEventV1,{type:'BondingCurveTradeObserved'}>, status: ChainConfirmationStatus): Promise<void> {
    const trade = event.payload.trade;
    const existing = await client.query(`SELECT trade_id,mint,trade_kind,trader,
      base_amount_raw::text AS base_amount_raw,quote_amount_raw::text AS quote_amount_raw,
      quote_mint,quote_decimals,quote_token_program,slot::text AS slot,
      transaction_index,instruction_index,inner_instruction_index
      FROM launch_trades WHERE trade_id=$1 FOR UPDATE`, [trade.id]);
    if (existing.rows[0] !== undefined) assertTradeMatches(existing.rows[0], event);
    const result = await client.query(`INSERT INTO launch_trades (
      trade_id,mint,trade_kind,trader,base_amount_raw,quote_amount_raw,quote_mint,
      quote_decimals,quote_token_program,slot,transaction_index,instruction_index,
      inner_instruction_index,confirmation_status,purge_after
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL)
    ON CONFLICT (trade_id) DO UPDATE SET confirmation_status=EXCLUDED.confirmation_status,
      purge_after=NULL RETURNING trade_id`, [trade.id,trade.launchMint,trade.kind,trade.trader,
      trade.baseAmountRaw.toString(),trade.quoteAmountRaw.toString(),trade.quoteAsset.mint,
      trade.quoteAsset.decimals,trade.quoteAsset.tokenProgram,trade.cursor.slot.toString(),
      trade.cursor.transactionIndex,trade.cursor.instructionIndex,trade.cursor.innerInstructionIndex,status]);
    requireOne(result);
  }

  private async retract(
    client: Client,
    event: LaunchpadObservationEventV1,
    terminal: readonly [Date | null, Date | null],
  ): Promise<void> {
    const [terminalAt, purgeAfter] = terminal;
      await exact(client, `UPDATE domain_events SET confirmation_status='orphaned',terminal_at=$2,purge_after=$3 WHERE event_id=$1`, [event.id,terminalAt,purgeAfter]);
    if (event.type === 'TokenLaunchDetected') {
      await exact(client, 'UPDATE state_transitions SET terminal_at=$2,purge_after=$3 WHERE event_id=$1', [event.id,terminalAt,purgeAfter]);
      await exact(client, 'UPDATE token_launches SET current_state=\'RETRACTED\',terminal_at=$2,purge_after=$3,updated_at=$2 WHERE mint=$1', [event.mint,terminalAt,purgeAfter]);
    } else await exact(client, `UPDATE launch_trades SET confirmation_status='orphaned',purge_after=$2 WHERE trade_id=$1`, [event.payload.trade.id,purgeAfter]);
  }

  private terminal(status: ChainConfirmationStatus): readonly [Date|null,Date|null] {
    if (status !== 'orphaned') return [null,null];
    const terminal = this.now();
    return [new Date(terminal),new Date(terminal + this.retentionHours*3_600_000)];
  }
}

function rawSnapshot(event: LaunchpadObservationEventV1): object {
  const { confirmationStatus, blockchainTimeMs, observedAtMs, ...value } = event;
  void confirmationStatus;
  void blockchainTimeMs;
  void observedAtMs;
  return value;
}

function prepareLaunchpadBatch(value: unknown): LaunchpadEventBatch {
  try {
    const state = { nodes: 0, textBytes: 0, ancestors: new WeakSet() };
    const snapshot = snapshotBoundaryValue(value, 0, state);
    const serialized = stringifyJson(snapshot);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CANONICAL_JSON_TEXT_BYTES) {
      throw new RangeError('Batch serialized bounds exceeded.');
    }
    assertBatchShape(snapshot);
    assertValidLaunchpadEventBatch(snapshot as LaunchpadEventBatch);
    return snapshot as LaunchpadEventBatch;
  } catch {
    throw new LaunchpadEventRepositoryError('record');
  }
}

function snapshotBoundaryValue(
  value: unknown,
  depth: number,
  state: { nodes: number; textBytes: number; ancestors: WeakSet<object> },
): unknown {
  if (depth > 32 || ++state.nodes > 10_000) throw new RangeError('Batch bounds exceeded.');
  if (typeof value === 'string') {
    accountBatchText(value, state);
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') {
    if (value.toString().replace(/^-/, '').length > 78) throw new RangeError('Batch bigint bounds exceeded.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('Batch number is invalid.');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Batch value is invalid.');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new TypeError('Batch array prototype is invalid.');
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Batch object prototype is invalid.');
  }
  if (state.ancestors.has(value)) throw new TypeError('Batch must be acyclic.');
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 1_024) throw new RangeError('Batch array bounds exceeded.');
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || keys.some((key) => typeof key === 'symbol')) throw new TypeError('Batch array keys are invalid.');
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        accountBatchText(String(index), state);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Batch array property is invalid.');
        result.push(snapshotBoundaryValue(descriptor.value, depth + 1, state));
      }
      return Object.freeze(result);
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') throw new TypeError('Batch symbols are invalid.');
      accountBatchText(key, state);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Batch property is invalid.');
      Object.defineProperty(result, key, { value: snapshotBoundaryValue(descriptor.value, depth + 1, state), enumerable: true });
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(value);
  }
}

function accountBatchText(value: string, state: { textBytes: number }): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (
    bytes > MAX_CANONICAL_JSON_STRING_BYTES
    || state.textBytes + bytes > MAX_CANONICAL_JSON_TEXT_BYTES
  ) throw new RangeError('Batch text bounds exceeded.');
  state.textBytes += bytes;
}

function assertBatchShape(value: unknown): void {
  const batch = shapeRecord(value, ['source', 'program', 'signature', 'confirmationStatus', 'stateTransitionAction', 'events', 'transitions']);
  if (!Array.isArray(batch.events) || !Array.isArray(batch.transitions) || batch.events.length > 512 || batch.transitions.length > 512) throw new TypeError('Batch arrays are invalid.');
  for (const eventValue of batch.events) {
    const event = shapeRecord(eventValue, ['id', 'type', 'mint', 'source', 'program', 'signature', 'cursor', 'confirmationStatus', 'blockchainTimeMs', 'observedAtMs', 'payloadVersion', 'payload']);
    shapeRecord(event.cursor, ['slot', 'transactionIndex', 'instructionIndex', 'innerInstructionIndex']);
    const payload = shapeRecord(event.payload, event.type === 'TokenLaunchDetected' ? ['launch'] : ['trade']);
    if (event.type === 'TokenLaunchDetected') {
      const launch = shapeRecord(payload.launch, ['mint', 'creator', 'tokenProgram', 'quoteAssets', 'launchpad', 'createdAt', 'parameters']);
      shapeRecord(launch.createdAt, ['slot', 'transactionIndex', 'instructionIndex', 'innerInstructionIndex']);
      if (!Array.isArray(launch.quoteAssets) || launch.quoteAssets.length > 64) throw new TypeError('Quote assets are invalid.');
      for (const quote of launch.quoteAssets) shapeRecord(quote, ['mint', 'decimals', 'tokenProgram']);
      shapeRecord(launch.parameters, Object.keys(shapeRecord(launch.parameters)));
    } else if (event.type === 'BondingCurveTradeObserved') {
      const trade = shapeRecord(payload.trade, ['id', 'launchMint', 'kind', 'trader', 'baseAmountRaw', 'quoteAmountRaw', 'quoteAsset', 'cursor']);
      shapeRecord(trade.quoteAsset, ['mint', 'decimals', 'tokenProgram']);
      shapeRecord(trade.cursor, ['slot', 'transactionIndex', 'instructionIndex', 'innerInstructionIndex']);
    } else throw new TypeError('Event type is invalid.');
  }
  for (const transitionValue of batch.transitions) {
    const transition = shapeRecord(transitionValue, ['id', 'payloadVersion', 'mint', 'triggeringEventId', 'triggeringEventType', 'occurredAtMs', 'occurredAtSource', 'previousStatus', 'newStatus', 'reasonCode', 'message', 'evidence']);
    shapeRecord(transition.evidence, ['source', 'program']);
  }
}

function shapeRecord(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Batch object is invalid.');
  const record = value as Record<string, unknown>;
  if (allowed !== undefined) {
    const keys = Object.keys(record).sort();
    const expected = [...allowed].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new TypeError('Batch object keys are invalid.');
  }
  return record;
}

function assertEventFingerprint(event: LaunchpadObservationEventV1): void {
  const transaction = {
    signature: event.signature,
    confirmationStatus: event.confirmationStatus,
    blockTimeMs: event.blockchainTimeMs,
    observedAtMs: event.observedAtMs,
    cursor: { slot: event.cursor.slot, transactionIndex: event.cursor.transactionIndex },
    raw: null,
  };
  const expected = event.type === 'TokenLaunchDetected'
    ? createTokenLaunchDetectedEvent({ source: event.source, program: event.program, transaction, launch: event.payload.launch })
    : createBondingCurveTradeObservedEvent({ source: event.source, program: event.program, transaction, trade: event.payload.trade });
  if (!canonicalEqual(expected, event)) throw conflict('identity');
}

function date(value: number | null): Date | null { return value === null ? null : new Date(value); }
function optionalRecord(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function requiredField(row: unknown, field: string): unknown { const record = optionalRecord(row); if (record === null || !Object.hasOwn(record, field)) throw new TypeError('Invalid repository row.'); return record[field]; }
function requiredText(row: unknown, field: string): string { const value = optionalRecord(row)?.[field]; if (typeof value !== 'string') throw new TypeError('Invalid repository row.'); return value; }
function occurrenceSource(value: string): 'blockchain' | 'observation' { if (value !== 'blockchain' && value !== 'observation') throw new TypeError('Invalid transition occurrence source.'); return value; }
function confirmation(value: string): ChainConfirmationStatus { if (!['processed', 'confirmed', 'finalized', 'orphaned'].includes(value)) throw new TypeError('Invalid repository row.'); return value as ChainConfirmationStatus; }
function assertRawMatches(row: unknown, event: LaunchpadObservationEventV1, payload: unknown): void { const record = optionalRecord(row); if (record === null) throw conflict('identity'); assertFields(record, event); if (!canonicalEqual(fromJsonValue(record.payload), payload)) throw conflict('payload'); }
function assertDomainMatches(row: unknown, event: LaunchpadObservationEventV1, rawId: string): void { const record = optionalRecord(row); if (record === null) throw conflict('identity'); assertFields(record, event, event.type, rawId); if (!canonicalEqual(fromJsonValue(record.payload), event.payload)) throw conflict('payload'); }
function assertFields(record: Record<string, unknown>, event: LaunchpadObservationEventV1, type?: string, rawId?: string): void { const expected = { ...(rawId === undefined ? {} : { raw_event_id: rawId }), ...(type === undefined ? {} : { type }), source: event.source, program: event.program, mint: event.mint, signature: event.signature, slot: event.cursor.slot.toString(), transaction_index: event.cursor.transactionIndex, instruction_index: event.cursor.instructionIndex, inner_instruction_index: event.cursor.innerInstructionIndex, payload_version: event.payloadVersion }; assertExactColumns(record, expected); }
function assertExactColumns(record: Record<string, unknown>, expected: Readonly<Record<string, unknown>>): void { for (const [field, value] of Object.entries(expected)) if (record[field] !== value) throw conflict('identity'); }
function assertLaunchMatches(row: unknown, event: Extract<LaunchpadObservationEventV1, {type: 'TokenLaunchDetected'}>): void { const record = optionalRecord(row); if (record === null) throw conflict('identity'); const launch = event.payload.launch; assertExactColumns(record, { mint: launch.mint, launchpad: launch.launchpad, program_id: event.program, creator: launch.creator, token_program: launch.tokenProgram, created_signature: event.signature, created_slot: launch.createdAt.slot.toString(), created_transaction_index: launch.createdAt.transactionIndex, created_instruction_index: launch.createdAt.instructionIndex, created_inner_instruction_index: launch.createdAt.innerInstructionIndex }); if (!canonicalEqual(fromJsonValue(record.quote_assets), launch.quoteAssets)) throw conflict('payload'); }
function assertTradeMatches(row: unknown, event: Extract<LaunchpadObservationEventV1, {type: 'BondingCurveTradeObserved'}>): void { const record = optionalRecord(row); if (record === null) throw conflict('identity'); const trade = event.payload.trade; assertExactColumns(record, { trade_id: trade.id, mint: trade.launchMint, trade_kind: trade.kind, trader: trade.trader, base_amount_raw: trade.baseAmountRaw.toString(), quote_amount_raw: trade.quoteAmountRaw.toString(), quote_mint: trade.quoteAsset.mint, quote_decimals: trade.quoteAsset.decimals, quote_token_program: trade.quoteAsset.tokenProgram, slot: trade.cursor.slot.toString(), transaction_index: trade.cursor.transactionIndex, instruction_index: trade.cursor.instructionIndex, inner_instruction_index: trade.cursor.innerInstructionIndex }); }
async function exact(client: Client, text: string, values: readonly unknown[]): Promise<void> { requireOne(await client.query(text, values)); }
function requireOne(result: Result): void { if (result.rowCount !== 1) throw new TypeError('Unexpected repository row count.'); }
async function writeTransition(
  client: Client,
  transition: InitialDetectedStateTransition,
): Promise<void> {
  const existing = await client.query(`SELECT transition_id,mint,event_id,
    occurred_at,occurred_at_source,payload_version,trigger_event,previous_state,
    new_state,reason_code,human_message,evidence
    FROM state_transitions WHERE transition_id=$1 OR event_id=$2 FOR UPDATE`, [
    transition.id,
    transition.triggeringEventId,
  ]);
  if (existing.rows.length > 1) throw conflict('identity');
  const row = existing.rows[0];
  let occurrence = transition;
  if (row !== undefined) {
    assertTransitionMatches(row, transition);
    occurrence = {
      ...transition,
      ...reconcileTransitionOccurrence(
        {
          occurredAtMs: dateMs(requiredField(row, 'occurred_at')),
          occurredAtSource: occurrenceSource(requiredText(row, 'occurred_at_source')),
        },
        transition,
      ),
    };
  }
  const result = await client.query(`INSERT INTO state_transitions (
    transition_id,mint,event_id,occurred_at,occurred_at_source,payload_version,
    trigger_event,previous_state,new_state,reason_code,human_message,evidence,
    terminal_at,purge_after
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,NULL)
  ON CONFLICT (transition_id) DO UPDATE SET
    occurred_at=EXCLUDED.occurred_at,
    occurred_at_source=EXCLUDED.occurred_at_source,
    terminal_at=NULL,purge_after=NULL
  RETURNING transition_id`, [
    transition.id, transition.mint, transition.triggeringEventId,
    new Date(occurrence.occurredAtMs), occurrence.occurredAtSource,
    transition.payloadVersion, transition.triggeringEventType,
    transition.previousStatus, transition.newStatus, transition.reasonCode,
    transition.message, toJsonValue(transition.evidence),
  ]);
  requireOne(result);
}

function assertTransitionMatches(
  row: unknown,
  transition: InitialDetectedStateTransition,
): void {
  const record = optionalRecord(row);
  if (record === null) throw conflict('identity');
  const expected = {
    transition_id: transition.id,
    mint: transition.mint,
    event_id: transition.triggeringEventId,
    payload_version: transition.payloadVersion,
    trigger_event: transition.triggeringEventType,
    previous_state: transition.previousStatus,
    new_state: transition.newStatus,
    reason_code: transition.reasonCode,
    human_message: transition.message,
  };
  assertExactColumns(record, expected);
  if (!canonicalEqual(fromJsonValue(record.evidence), transition.evidence)) {
    throw conflict('payload');
  }
}

function restoreEvent(row: unknown): LaunchpadObservationEventV1 {
  const record = optionalRecord(row);
  if (record === null) throw new TypeError('Invalid repository row.');
  const transaction = { signature: requiredText(record, 'signature'), confirmationStatus: confirmation(requiredText(record, 'confirmation_status')), blockTimeMs: record.blockchain_time === null ? null : dateMs(record.blockchain_time), observedAtMs: dateMs(record.observed_at), cursor: { slot: BigInt(requiredText(record, 'slot')), transactionIndex: integer(record.transaction_index) }, raw: null };
  const payload = optionalRecord(fromJsonValue(record.payload));
  if (payload === null) throw new TypeError('Invalid event payload.');
  const common = { source: requiredText(record, 'source'), program: requiredText(record, 'program'), transaction };
  let event: LaunchpadObservationEventV1;
  if (record.type === 'TokenLaunchDetected') event = createTokenLaunchDetectedEvent({ ...common, launch: payload.launch as TokenLaunch });
  else if (record.type === 'BondingCurveTradeObserved') event = createBondingCurveTradeObservedEvent({ ...common, trade: payload.trade as LaunchpadTrade });
  else throw new TypeError('Invalid event type.');
  if (event.id !== requiredText(record, 'event_id') || event.payloadVersion !== integer(record.payload_version)) throw new TypeError('Invalid event fingerprint.');
  const rawPayload = fromJsonValue(record.raw_payload);
  if (
    requiredText(record, 'raw_event_id') !== rawFingerprint(event.id)
    || requiredText(record, 'raw_confirmation_status') !== event.confirmationStatus
    || !canonicalEqual(rawPayload, rawSnapshot(event))
  ) throw new TypeError('Invalid raw event fingerprint.');
  return event;
}

function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('Invalid repository row.'); return value; }
function dateMs(value: unknown): number { if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) throw new TypeError('Invalid repository row.'); return value.getTime(); }
function immutableSet(values: readonly string[]): ReadonlySet<string> {
  const target = new Set(values);
  const immutable = (): never => { throw new TypeError('Set is immutable.'); };
  const result = new Proxy(target, {
    get(set, property): unknown {
      if (property === 'add' || property === 'delete' || property === 'clear') return immutable;
      if (property === 'has') return (value: string): boolean => set.has(value);
      if (property === 'entries') return (): SetIterator<[string, string]> => set.entries();
      if (property === 'keys') return (): SetIterator<string> => set.keys();
      if (property === 'values' || property === Symbol.iterator) {
        return (): SetIterator<string> => set.values();
      }
      if (property === 'forEach') {
        return (callback: (value: string, key: string, owner: ReadonlySet<string>) => void, thisArg?: unknown): void => {
          set.forEach((value, key) => { callback.call(thisArg, value, key, result); });
        };
      }
      return Reflect.get(set, property, set) as unknown;
    },
  });
  return Object.freeze(result);
}
function requiredOutcome(values: ReadonlyMap<string, EventRecordOutcome>, id: string): EventRecordOutcome { const value = values.get(id); if (value === undefined) throw new TypeError('Missing event outcome.'); return value; }
function rawFingerprint(eventId: string): string { return createRepositoryId('launchpad_raw', [eventId]); }
function conflict(kind: 'identity' | 'payload'): LaunchpadEventConflictError { const error = new LaunchpadEventConflictError(kind); trustedErrors.add(error); return error; }
function reconcileStatus(current: ChainConfirmationStatus, incoming: ChainConfirmationStatus): ReturnType<typeof reconcileConfirmationStatus> { try { return reconcileConfirmationStatus(current, incoming); } catch (error) { if (typeof error === 'object' && error !== null) trustedErrors.add(error); throw error; } }
function releaseClient(client: Client, operation: 'record' | 'read'): void { try { client.release(); } catch { throw new LaunchpadEventRepositoryError(operation); } }
function canonicalEqual(left: unknown, right: unknown): boolean { return canonicalStringifyJson(left) === canonicalStringifyJson(right); }
