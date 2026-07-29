import { reconcileConfirmationStatus } from '../domain/confirmation-status.js';
import type { ChainConfirmationStatus } from '../domain/types.js';
import {
  createMigrationPendingTransition,
  createPumpSwapActiveTransition,
  type StateTransition,
} from '../domain/state-transitions.js';
import type {
  CanonicalMarketPool,
  MarketTrade,
  RawMarketObservation,
} from '../domain/market.js';
import type {
  MigrationObservedEventV1,
  PumpSwapPoolActivatedEventV1,
} from '../domain/migration-events.js';
import type {
  MarketObservationBatch,
  MarketObservationRepository,
  MarketObservationResult,
  MarketReserveObservation,
} from '../ports/market-observation-repository.js';
import { fromJsonValue, stringifyJson, toJsonValue } from '../utils/json.js';
import { getDatabasePool } from './database.js';

interface QueryResultLike {
  readonly rows: readonly unknown[];
  readonly rowCount?: number | null;
}
interface QueryClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResultLike>;
  release(): void;
}
interface Connectable {
  connect(): Promise<QueryClient>;
}
interface RawWrite {
  readonly firstObservation: boolean;
  readonly becameOrphaned: boolean;
}

export class MarketObservationPayloadConflictError extends Error {
  public constructor(public readonly eventId: string) {
    super(`Payload contradictoire pour ${eventId}.`);
    this.name = 'MarketObservationPayloadConflictError';
  }
}

export class MarketObservationStateError extends Error {
  public constructor(public readonly mint: string, public readonly state: string) {
    super(`État ${state} incompatible avec la migration de ${mint}.`);
    this.name = 'MarketObservationStateError';
  }
}

export class PostgresMarketObservationRepository
implements MarketObservationRepository {
  public constructor(
    private readonly pool: Connectable = getDatabasePool(),
    private readonly dataRetentionHours = 4,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(dataRetentionHours) || dataRetentionHours <= 0) {
      throw new RangeError('dataRetentionHours doit être un entier positif.');
    }
  }

  public async record(batch: MarketObservationBatch): Promise<MarketObservationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockTransactions(client, batch.rawEvents);
      const migrations: MigrationObservedEventV1[] = [];
      const activations: PumpSwapPoolActivatedEventV1[] = [];
      for (const match of batch.matches) {
        const migrationRaw = findRaw(batch.rawEvents, match.migrationEvent.id);
        const migrationWrite = await this.writeRaw(client, migrationRaw);
        if (migrationWrite.becameOrphaned) {
          await this.retractMigration(client, match.migrationEvent);
        } else if (match.migrationEvent.confirmationStatus !== 'orphaned') {
          await this.writeMigration(client, migrationRaw.id, match.migrationEvent);
          migrations.push(match.migrationEvent);
        }
        if (match.activationEvent !== null) {
          const activationRaw = findRaw(batch.rawEvents, match.activationEvent.id);
          const activationWrite = await this.writeRaw(client, activationRaw);
          if (activationWrite.becameOrphaned) {
            await this.retractActivation(client, match.activationEvent);
          } else if (match.activationEvent.confirmationStatus !== 'orphaned') {
            await this.writeActivation(client, activationRaw.id, match.activationEvent);
            activations.push(match.activationEvent);
          }
        }
      }
      for (const reserves of batch.reserveSnapshots) {
        await this.writeReserves(client, reserves);
      }
      for (const trade of batch.trades) {
        const raw = findRaw(batch.rawEvents, trade.id);
        const write = await this.writeRaw(client, raw);
        if (write.becameOrphaned) {
          await this.retractTrade(client, trade);
        } else if (trade.confirmationStatus !== 'orphaned') {
          await this.writeTrade(client, trade);
        }
      }
      await client.query('COMMIT');
      return Object.freeze({
        migrations: Object.freeze(migrations),
        activations: Object.freeze(activations),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async loadActivePools(): Promise<readonly CanonicalMarketPool[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT payload FROM market_pools
         WHERE pool_state = 'active' AND confirmation_status <> 'orphaned'
         ORDER BY slot, transaction_index, instruction_index,
           COALESCE(inner_instruction_index, -1)`,
      );
      return Object.freeze(result.rows.map(decodePoolRow));
    } finally {
      client.release();
    }
  }

  private async lockTransactions(
    client: QueryClient,
    events: readonly RawMarketObservation[],
  ): Promise<void> {
    const keys = [...new Set(events.map((event) =>
      `${event.source}\u001f${event.program}\u001f${event.signature}`))].sort();
    for (const key of keys) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [key],
      );
    }
  }

  private async writeRaw(
    client: QueryClient,
    event: RawMarketObservation,
  ): Promise<RawWrite> {
    const existing = await client.query(
      `SELECT confirmation_status, payload FROM raw_chain_events
       WHERE event_id = $1 FOR UPDATE`,
      [event.id],
    );
    const row = optionalRecord(existing.rows[0]);
    if (row === null) {
      const terminal = event.confirmationStatus === 'orphaned'
        ? this.retentionTimes()
        : null;
      await client.query(
        `INSERT INTO raw_chain_events (
          event_id, source, program, mint, signature, slot, transaction_index,
          instruction_index, inner_instruction_index, confirmation_status,
          blockchain_time, observed_at, payload_version, payload, processing_status,
          terminal_at, purge_after
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'processed',$15,$16)`,
        [
          ...rawValues(event),
          terminal?.terminalAt ?? null,
          terminal?.purgeAfter ?? null,
        ],
      );
      return {
        firstObservation: true,
        becameOrphaned: event.confirmationStatus === 'orphaned',
      };
    }
    if (!sameJson(row.payload, event.payload)) {
      throw new MarketObservationPayloadConflictError(event.id);
    }
    const current = confirmation(row.confirmation_status);
    const reconciliation = reconcileConfirmationStatus(
      current,
      event.confirmationStatus,
    );
    const next = reconciliation === 'update' ? event.confirmationStatus : current;
    await client.query(
      `UPDATE raw_chain_events SET confirmation_status = $2,
       blockchain_time = CASE WHEN $3::timestamptz IS NULL THEN blockchain_time
         WHEN blockchain_time IS NULL THEN $3 ELSE LEAST(blockchain_time, $3) END,
       observed_at = LEAST(observed_at, $4), updated_at = NOW()
       WHERE event_id = $1`,
      [event.id, next, date(event.blockchainTimeMs), new Date(event.observedAtMs)],
    );
    return {
      firstObservation: false,
      becameOrphaned: current !== 'orphaned' && next === 'orphaned',
    };
  }

  private async writeMigration(
    client: QueryClient,
    rawId: string,
    event: MigrationObservedEventV1,
  ): Promise<void> {
    await writeDomainEvent(client, rawId, event);
    const launch = await client.query(
      'SELECT current_state FROM token_launches WHERE mint = $1 FOR UPDATE',
      [event.mint],
    );
    const current = requiredText(launch.rows[0], 'current_state');
    const migration = event.payload.migration;
    await client.query(
      `INSERT INTO migrations (
        migration_id,event_id,mint,bonding_curve,announced_pool,instruction_kind,
        quote_mint,quote_decimals,base_token_program,quote_token_program,
        confirmation_status,payload_version,payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (migration_id) DO UPDATE SET
        confirmation_status = EXCLUDED.confirmation_status`,
      [
        event.id, event.id, event.mint, migration.bondingCurve,
        migration.announcedPool, migration.instruction, migration.quoteAsset.mint,
        migration.quoteAsset.decimals, migration.baseTokenProgram,
        migration.quoteAsset.tokenProgram, event.confirmationStatus,
        event.payloadVersion, toJsonValue(event.payload),
      ],
    );
    if (current === 'OBSERVING' || current === 'BONDING_CURVE_COMPLETE') {
      const transition = createMigrationPendingTransition(current, event);
      await writeTransition(client, transition);
      await updateLaunchState(client, event.mint, 'MIGRATION_PENDING', transition.occurredAtMs);
    } else if (current !== 'MIGRATION_PENDING' && current !== 'PUMPSWAP_ACTIVE') {
      throw new MarketObservationStateError(event.mint, current);
    }
  }

  private async writeActivation(
    client: QueryClient,
    rawId: string,
    event: PumpSwapPoolActivatedEventV1,
  ): Promise<void> {
    await writeDomainEvent(client, rawId, event);
    const launch = await client.query(
      'SELECT current_state FROM token_launches WHERE mint = $1 FOR UPDATE',
      [event.mint],
    );
    const current = requiredText(launch.rows[0], 'current_state');
    const pool = event.payload.pool;
    await client.query(
      `INSERT INTO market_pools (
        pool_address,market,program_id,pool_index,creator,base_mint,quote_mint,
        quote_decimals,base_token_program,quote_token_program,base_vault,quote_vault,
        lp_mint,migration_id,activation_event_id,pool_state,confirmation_status,
        slot,transaction_index,instruction_index,inner_instruction_index,
        payload_version,payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active',
        $16,$17,$18,$19,$20,$21,$22)
      ON CONFLICT (pool_address) DO UPDATE SET
        confirmation_status = EXCLUDED.confirmation_status`,
      [
        pool.address, pool.market, pool.programId, pool.index, pool.creator,
        pool.baseMint, pool.quoteAsset.mint, pool.quoteAsset.decimals,
        pool.baseTokenProgram, pool.quoteAsset.tokenProgram, pool.baseVault,
        pool.quoteVault, pool.lpMint, event.payload.migrationEventId, event.id,
        event.confirmationStatus, pool.activatedAt.slot.toString(),
        pool.activatedAt.transactionIndex, pool.activatedAt.instructionIndex,
        pool.activatedAt.innerInstructionIndex, event.payloadVersion,
        toJsonValue(pool),
      ],
    );
    if (current === 'MIGRATION_PENDING') {
      const transition = createPumpSwapActiveTransition(event);
      await writeTransition(client, transition);
      await updateLaunchState(client, event.mint, 'PUMPSWAP_ACTIVE', transition.occurredAtMs);
    } else if (current !== 'PUMPSWAP_ACTIVE') {
      throw new MarketObservationStateError(event.mint, current);
    }
  }

  private async writeReserves(
    client: QueryClient,
    observation: MarketReserveObservation,
  ): Promise<void> {
    const { reserves } = observation;
    await client.query(
      `INSERT INTO market_reserve_snapshots (
        snapshot_id,pool_address,base_reserves_raw,quote_vault_amount_raw,
        virtual_quote_reserves_raw,effective_quote_reserves_raw,observed_slot,
        trigger_slot,
        transaction_index,instruction_index,inner_instruction_index,
        confirmation_status,observed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (snapshot_id) DO UPDATE SET
        confirmation_status = EXCLUDED.confirmation_status`,
      [
        observation.id, reserves.pool, reserves.baseReservesRaw.toString(),
        reserves.quoteVaultAmountRaw.toString(),
        reserves.virtualQuoteReservesRaw.toString(),
        reserves.effectiveQuoteReservesRaw.toString(),
        reserves.observedSlot.toString(),
        observation.triggerCursor.slot.toString(),
        observation.triggerCursor.transactionIndex,
        observation.triggerCursor.instructionIndex,
        observation.triggerCursor.innerInstructionIndex,
        observation.confirmationStatus,
        new Date(reserves.observedAtMs),
      ],
    );
  }

  private async writeTrade(client: QueryClient, trade: MarketTrade): Promise<void> {
    await client.query(
      `INSERT INTO market_trades (
        trade_id,pool_address,mint,quote_mint,trade_kind,trader,base_amount_raw,
        quote_amount_raw,signature,slot,transaction_index,instruction_index,
        inner_instruction_index,confirmation_status,payload_version,payload,observed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16)
      ON CONFLICT (trade_id) DO UPDATE SET
        confirmation_status = EXCLUDED.confirmation_status`,
      [
        trade.id, trade.pool, trade.mint, trade.quoteAsset.mint, trade.kind,
        trade.trader, trade.baseAmountRaw.toString(), trade.quoteAmountRaw.toString(),
        trade.signature, trade.cursor.slot.toString(), trade.cursor.transactionIndex,
        trade.cursor.instructionIndex, trade.cursor.innerInstructionIndex,
        trade.confirmationStatus, toJsonValue(trade), new Date(trade.observedAtMs),
      ],
    );
  }

  private async retractMigration(
    client: QueryClient,
    event: MigrationObservedEventV1,
  ): Promise<void> {
    const times = this.retentionTimes();
    await client.query(
      `UPDATE migrations SET confirmation_status='orphaned',terminal_at=$2,purge_after=$3
       WHERE migration_id=$1`,
      [event.id, times.terminalAt, times.purgeAfter],
    );
    await client.query(
      `UPDATE market_pools SET pool_state='retracted',confirmation_status='orphaned',
       terminal_at=$2,purge_after=$3 WHERE migration_id=$1`,
      [event.id, times.terminalAt, times.purgeAfter],
    );
    await client.query(
      `UPDATE market_reserve_snapshots SET terminal_at=$2,purge_after=$3
       WHERE pool_address IN (
         SELECT pool_address FROM market_pools WHERE migration_id=$1
       )`,
      [event.id, times.terminalAt, times.purgeAfter],
    );
    await client.query(
      `UPDATE market_trades SET terminal_at=$2,purge_after=$3
       WHERE pool_address IN (
         SELECT pool_address FROM market_pools WHERE migration_id=$1
       )`,
      [event.id, times.terminalAt, times.purgeAfter],
    );
    await this.retractDomainAndTransition(client, event.id, times);
    await client.query(
      `UPDATE token_launches SET current_state='BONDING_CURVE_COMPLETE',updated_at=$2
       WHERE mint=$1 AND current_state IN ('MIGRATION_PENDING','PUMPSWAP_ACTIVE')`,
      [event.mint, times.terminalAt],
    );
  }

  private async retractActivation(
    client: QueryClient,
    event: PumpSwapPoolActivatedEventV1,
  ): Promise<void> {
    const times = this.retentionTimes();
    await client.query(
      `UPDATE market_pools SET pool_state='retracted',confirmation_status='orphaned',
       terminal_at=$2,purge_after=$3 WHERE activation_event_id=$1`,
      [event.id, times.terminalAt, times.purgeAfter],
    );
    await client.query(
      `UPDATE market_reserve_snapshots SET terminal_at=$2,purge_after=$3
       WHERE pool_address=$1`,
      [event.payload.pool.address, times.terminalAt, times.purgeAfter],
    );
    await client.query(
      `UPDATE market_trades SET terminal_at=$2,purge_after=$3
       WHERE pool_address=$1`,
      [event.payload.pool.address, times.terminalAt, times.purgeAfter],
    );
    await this.retractDomainAndTransition(client, event.id, times);
    await client.query(
      `UPDATE token_launches SET current_state='MIGRATION_PENDING',updated_at=$2
       WHERE mint=$1 AND current_state='PUMPSWAP_ACTIVE'`,
      [event.mint, times.terminalAt],
    );
  }

  private async retractTrade(
    client: QueryClient,
    trade: MarketTrade,
  ): Promise<void> {
    const times = this.retentionTimes();
    await client.query(
      `UPDATE market_trades SET confirmation_status='orphaned',
       terminal_at=$2,purge_after=$3 WHERE trade_id=$1`,
      [trade.id, times.terminalAt, times.purgeAfter],
    );
  }

  private async retractDomainAndTransition(
    client: QueryClient,
    eventId: string,
    times: { readonly terminalAt: Date; readonly purgeAfter: Date },
  ): Promise<void> {
    await client.query(
      `UPDATE domain_events SET confirmation_status='orphaned',
       terminal_at=$2,purge_after=$3 WHERE event_id=$1`,
      [eventId, times.terminalAt, times.purgeAfter],
    );
    await client.query(
      `UPDATE state_transitions SET terminal_at=$2,purge_after=$3 WHERE event_id=$1`,
      [eventId, times.terminalAt, times.purgeAfter],
    );
  }

  private retentionTimes(): {
    readonly terminalAt: Date;
    readonly purgeAfter: Date;
  } {
    const terminalAtMs = this.now();
    const purgeAfterMs = terminalAtMs + this.dataRetentionHours * 3_600_000;
    if (!Number.isSafeInteger(terminalAtMs) || !Number.isSafeInteger(purgeAfterMs)) {
      throw new RangeError('Fenêtre de rétention hors plage.');
    }
    return {
      terminalAt: new Date(terminalAtMs),
      purgeAfter: new Date(purgeAfterMs),
    };
  }
}

async function writeDomainEvent(
  client: QueryClient,
  rawId: string,
  event: MigrationObservedEventV1 | PumpSwapPoolActivatedEventV1,
): Promise<void> {
  await client.query(
    `INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,
      transaction_index,instruction_index,inner_instruction_index,
      confirmation_status,blockchain_time,observed_at,payload_version,payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (event_id) DO UPDATE SET
      confirmation_status = EXCLUDED.confirmation_status`,
    [
      event.id, rawId, event.type, event.mint, event.source, event.program,
      event.signature, event.cursor.slot.toString(), event.cursor.transactionIndex,
      event.cursor.instructionIndex, event.cursor.innerInstructionIndex,
      event.confirmationStatus, date(event.blockchainTimeMs),
      new Date(event.observedAtMs), event.payloadVersion, toJsonValue(event.payload),
    ],
  );
}

async function writeTransition(
  client: QueryClient,
  transition: StateTransition,
): Promise<void> {
  await client.query(
    `INSERT INTO state_transitions (
      transition_id,mint,event_id,occurred_at,trigger_event,previous_state,
      new_state,reason_code,human_message,evidence
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (transition_id) DO NOTHING`,
    [
      transition.id, transition.mint, transition.triggeringEventId,
      new Date(transition.occurredAtMs), transition.triggeringEventType,
      transition.previousStatus, transition.newStatus, transition.reasonCode,
      transition.message, toJsonValue(transition.evidence),
    ],
  );
}

async function updateLaunchState(
  client: QueryClient,
  mint: string,
  state: string,
  occurredAtMs: number,
): Promise<void> {
  await client.query(
    'UPDATE token_launches SET current_state=$2,updated_at=$3 WHERE mint=$1',
    [mint, state, new Date(occurredAtMs)],
  );
}

function rawValues(event: RawMarketObservation): readonly unknown[] {
  return [
    event.id, event.source, event.program, event.mint, event.signature,
    event.cursor.slot.toString(), event.cursor.transactionIndex,
    event.cursor.instructionIndex, event.cursor.innerInstructionIndex,
    event.confirmationStatus, date(event.blockchainTimeMs),
    new Date(event.observedAtMs), event.payloadVersion, toJsonValue(event.payload),
  ];
}

function findRaw(
  events: readonly RawMarketObservation[],
  sourceId: string,
): RawMarketObservation {
  const event = events.find((candidate) => {
    const payload = candidate.payload.value;
    return typeof payload === 'object'
      && payload !== null
      && 'id' in payload
      && payload.id === sourceId;
  });
  if (event === undefined) {
    throw new Error(`Événement brut absent pour ${sourceId}.`);
  }
  return event;
}

function sameJson(left: unknown, right: unknown): boolean {
  return stringifyJson(fromJsonValue(left)) === stringifyJson(right);
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Ligne PostgreSQL invalide.');
  }
  return value as Record<string, unknown>;
}

function requiredText(row: unknown, field: string): string {
  const record = optionalRecord(row);
  const value = record?.[field];
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`Colonne ${field} absente.`);
  }
  return value;
}

function confirmation(value: unknown): ChainConfirmationStatus {
  if (
    value !== 'processed' && value !== 'confirmed'
    && value !== 'finalized' && value !== 'orphaned'
  ) {
    throw new TypeError('Statut de confirmation PostgreSQL invalide.');
  }
  return value;
}

function date(timestampMs: number | null): Date | null {
  return timestampMs === null ? null : new Date(timestampMs);
}

function decodePoolRow(row: unknown): CanonicalMarketPool {
  const record = optionalRecord(row);
  if (record === null || !('payload' in record)) {
    throw new TypeError('Pool PumpSwap PostgreSQL invalide.');
  }
  return fromJsonValue(record.payload) as CanonicalMarketPool;
}
