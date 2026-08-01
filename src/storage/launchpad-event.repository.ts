import { isDeepStrictEqual } from 'node:util';
import {
  createBondingCurveTradeObservedEvent,
  createTokenLaunchDetectedEvent,
  type LaunchpadObservationEventV1,
} from '../domain/launchpad-events.js';
import { reconcileConfirmationStatus } from '../domain/confirmation-status.js';
import { createInitialDetectedTransition } from '../domain/state-transitions.js';
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
import { fromJsonValue, stringifyJson, toJsonValue } from '../utils/json.js';
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

  public async record(batch: LaunchpadEventBatch): Promise<LaunchpadEventBatchResult> {
    assertValidLaunchpadEventBatch(batch);
    const ids = new Set<string>();
    for (const event of batch.events) {
      if (ids.has(event.id)) throw conflict('identity');
      ids.add(event.id);
      assertEventFingerprint(event);
    }
    const terminal = this.terminal(batch.confirmationStatus);
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
          byId.set(event.id, await this.writeEvent(client, event, terminal));
        }
        await client.query('COMMIT');
        return Object.freeze({
          events: Object.freeze(batch.events.map((event) => Object.freeze({
            eventId: event.id,
            outcome: requiredOutcome(byId, event.id),
          }))),
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
    terminal: readonly [Date | null, Date | null],
  ): Promise<EventRecordOutcome> {
    const rawPayload = rawSnapshot(event);
    const rawId = rawFingerprint(event.id, rawPayload);
    const found = await client.query(`SELECT event_id,source,program,mint,signature,
      slot::text AS slot,transaction_index,instruction_index,inner_instruction_index,
      payload_version,payload,confirmation_status FROM raw_chain_events
      WHERE event_id=$1 FOR UPDATE`, [rawId]);
    const current = found.rows[0];
    let status = event.confirmationStatus;
    let outcome: EventRecordOutcome = 'created';
    if (current !== undefined) {
      assertRawMatches(current, event, rawPayload);
      const oldStatus = confirmation(requiredText(current, 'confirmation_status'));
      const reconciliation = reconcileStatus(oldStatus, status);
      status = reconciliation === 'update' ? status : oldStatus;
      outcome = reconciliation === 'update' ? 'confirmation_updated' : 'duplicate';
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
      if (current !== undefined) await this.retract(client, event, terminal);
      return outcome;
    }
    await this.writeDomain(client, rawId, event, status);
    if (event.type === 'TokenLaunchDetected') await this.writeLaunch(client, event);
    else await this.writeTrade(client, event, status);
    return outcome;
  }

  private async writeDomain(client: Client, rawId: string, event: LaunchpadObservationEventV1, status: ChainConfirmationStatus): Promise<void> {
    const existing = await client.query('SELECT payload,type,mint,source,program,signature,slot::text AS slot,transaction_index,instruction_index,inner_instruction_index,payload_version FROM domain_events WHERE event_id=$1 FOR UPDATE', [event.id]);
    if (existing.rows[0] !== undefined) assertDomainMatches(existing.rows[0], event);
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

  private async writeLaunch(client: Client, event: Extract<LaunchpadObservationEventV1,{type:'TokenLaunchDetected'}>): Promise<void> {
    const launch = event.payload.launch;
    const existing = await client.query('SELECT * FROM token_launches WHERE mint=$1 FOR UPDATE', [event.mint]);
    if (existing.rows[0] !== undefined && requiredText(existing.rows[0], 'created_signature') !== event.signature) throw conflict('identity');
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
    const transition = createTransition(event);
    const transitionResult = await client.query(`INSERT INTO state_transitions (
      transition_id,mint,event_id,occurred_at,trigger_event,previous_state,new_state,
      reason_code,human_message,evidence,terminal_at,purge_after
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL)
    ON CONFLICT (transition_id) DO UPDATE SET terminal_at=NULL,purge_after=NULL RETURNING transition_id`, transition);
    requireOne(transitionResult);
  }

  private async writeTrade(client: Client, event: Extract<LaunchpadObservationEventV1,{type:'BondingCurveTradeObserved'}>, status: ChainConfirmationStatus): Promise<void> {
    const trade = event.payload.trade;
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
  if (!isDeepStrictEqual(expected, event)) throw conflict('identity');
}

function date(value: number | null): Date | null { return value === null ? null : new Date(value); }
function optionalRecord(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function requiredText(row: unknown, field: string): string { const value = optionalRecord(row)?.[field]; if (typeof value !== 'string') throw new TypeError('Invalid repository row.'); return value; }
function confirmation(value: string): ChainConfirmationStatus { if (!['processed', 'confirmed', 'finalized', 'orphaned'].includes(value)) throw new TypeError('Invalid repository row.'); return value as ChainConfirmationStatus; }
function assertRawMatches(row: unknown, event: LaunchpadObservationEventV1, payload: unknown): void { const record = optionalRecord(row); if (record === null) throw conflict('identity'); assertFields(record, event); if (!isDeepStrictEqual(fromJsonValue(record.payload), payload)) throw conflict('payload'); }
function assertDomainMatches(row: unknown, event: LaunchpadObservationEventV1): void { const record = optionalRecord(row); if (record === null) throw conflict('identity'); assertFields(record, event, event.type); if (!isDeepStrictEqual(fromJsonValue(record.payload), event.payload)) throw conflict('payload'); }
function assertFields(record: Record<string, unknown>, event: LaunchpadObservationEventV1, type?: string): void { const expected = { ...(type === undefined ? {} : { type }), source: event.source, program: event.program, mint: event.mint, signature: event.signature, slot: event.cursor.slot.toString(), transaction_index: event.cursor.transactionIndex, instruction_index: event.cursor.instructionIndex, inner_instruction_index: event.cursor.innerInstructionIndex, payload_version: event.payloadVersion }; for (const [key, value] of Object.entries(expected)) if (String(record[key]) !== String(value)) throw conflict('identity'); }
async function exact(client: Client, text: string, values: readonly unknown[]): Promise<void> { requireOne(await client.query(text, values)); }
function requireOne(result: Result): void { if (result.rowCount !== 1) throw new TypeError('Unexpected repository row count.'); }
function createTransition(event: Extract<LaunchpadObservationEventV1, {type: 'TokenLaunchDetected'}>): readonly unknown[] { const transition = createInitialDetectedTransition(event); return [transition.id, transition.mint, transition.triggeringEventId, new Date(transition.occurredAtMs), transition.triggeringEventType, transition.previousStatus, transition.newStatus, transition.reasonCode, transition.message, toJsonValue(transition.evidence)]; }

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
    requiredText(record, 'raw_event_id') !== rawFingerprint(event.id, rawSnapshot(event))
    || requiredText(record, 'raw_confirmation_status') !== event.confirmationStatus
    || !isDeepStrictEqual(rawPayload, rawSnapshot(event))
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
        return (callback: (value: string, key: string, owner: Set<string>) => void): void => {
          set.forEach(callback);
        };
      }
      return Reflect.get(set, property, set) as unknown;
    },
  });
  return Object.freeze(result);
}
function requiredOutcome(values: ReadonlyMap<string, EventRecordOutcome>, id: string): EventRecordOutcome { const value = values.get(id); if (value === undefined) throw new TypeError('Missing event outcome.'); return value; }
function rawFingerprint(eventId: string, payload: unknown): string { return createRepositoryId('launchpad_raw', [eventId, stringifyJson(payload)]); }
function conflict(kind: 'identity' | 'payload'): LaunchpadEventConflictError { const error = new LaunchpadEventConflictError(kind); trustedErrors.add(error); return error; }
function reconcileStatus(current: ChainConfirmationStatus, incoming: ChainConfirmationStatus): ReturnType<typeof reconcileConfirmationStatus> { try { return reconcileConfirmationStatus(current, incoming); } catch (error) { if (typeof error === 'object' && error !== null) trustedErrors.add(error); throw error; } }
function releaseClient(client: Client, operation: 'record' | 'read'): void { try { client.release(); } catch { throw new LaunchpadEventRepositoryError(operation); } }
