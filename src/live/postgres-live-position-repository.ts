import type { LiveTokenBalanceReconciliation } from './live-token-reconciliation.js';
import type { ChainCursor } from '../domain/types.js';

interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
}
interface QueryClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(): void;
}
interface Connectable { connect(): Promise<QueryClient> }

export type LivePositionStatus = 'OPEN' | 'RECONCILIATION_REQUIRED' | 'CLOSED';
export type LivePositionMarketState = 'BONDING_CURVE' | 'WAITING_FOR_POOL' | 'PUMPSWAP' | 'RETRY_EXHAUSTED' | 'UNKNOWN';
export interface LivePositionMarketRoute {
  readonly positionId: string;
  readonly state: LivePositionMarketState;
  readonly poolAddress: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly retryGeneration?: number;
  readonly retryBudget?: number;
  readonly retryHistory?: readonly Readonly<{ state: LivePositionMarketState; attempts: number; error: string | null; at: string }>[];
  readonly resolutionSource?: 'LOCAL_INDEX' | 'RPC_CANONICAL_PDA' | null;
  readonly resolutionSlot?: bigint | null;
  readonly resolutionAtMs?: number | null;
  readonly resolutionEvidence?: Readonly<Record<string, unknown>> | null;
}
export interface LivePositionRecord {
  readonly positionId: string;
  readonly sessionId: string;
  readonly candidateId: string;
  readonly wallet: string;
  readonly mint: string;
  readonly tokenProgram: string;
  readonly entryCursor: ChainCursor;
  readonly externalBuyTarget: number;
  readonly countedExternalBuyIds: readonly string[];
  readonly status: LivePositionStatus;
  readonly walletTokenPreRaw: bigint | null;
  readonly acquiredRaw: bigint | null;
  readonly remainingRaw: bigint | null;
  readonly buySignature: string;
  readonly sellSignature: string | null;
}

export interface LivePositionFillInput {
  readonly orderId: string;
  readonly positionId: string;
  readonly sessionId: string;
  readonly candidateId: string;
  readonly wallet: string;
  readonly mint: string;
  readonly tokenProgram: string;
  readonly entryCursor: ChainCursor;
  readonly externalBuyTarget: number;
  readonly signature: string;
  readonly tokenBalance: LiveTokenBalanceReconciliation;
}

/** Idempotently applies confirmed token deltas in the same PostgreSQL transaction as the fill record. */
export class PostgresLivePositionRepository {
  public constructor(private readonly pool: Connectable) {}

  public async applyBuy(input: LivePositionFillInput): Promise<LivePositionRecord> {
    validateIdentity(input);
    if (input.tokenBalance.status === 'KNOWN' && input.tokenBalance.deltaRaw <= 0n) {
      throw new Error('Confirmed BUY did not acquire a positive token quantity.');
    }
    return this.transact(async (client) => {
      const existingFill = await client.query('SELECT position_id,applied FROM live_position_fills WHERE signature=$1 FOR UPDATE', [input.signature]);
      if (existingFill.rows.length > 0) {
        const existing = existingFill.rows[0];
        if (existing === undefined) throw new Error('Existing fill lookup returned no row.');
        if (existing.position_id !== input.positionId) throw new Error('Signature is already linked to another live position.');
        if (existing.applied === true) return requirePosition(await this.read(client, input.positionId));
      }

      const known = input.tokenBalance.status === 'KNOWN'
        && input.tokenBalance.owner === input.wallet && input.tokenBalance.mint === input.mint;
      const pre = known ? input.tokenBalance.preAmountRaw : null;
      const acquired = known ? input.tokenBalance.deltaRaw : null;
      const remaining = known ? input.tokenBalance.deltaRaw : null;
      if (existingFill.rows.length === 0) {
        await client.query(`INSERT INTO live_positions (
          position_id,session_id,candidate_id,wallet,mint,token_program,status,
          entry_slot,entry_transaction_index,entry_instruction_index,entry_inner_instruction_index,
          external_buy_target,counted_external_buy_ids,
          wallet_token_pre_raw,acquired_raw,remaining_raw,buy_signature
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [
          input.positionId,input.sessionId,input.candidateId,input.wallet,input.mint,input.tokenProgram,
          known ? 'OPEN' : 'RECONCILIATION_REQUIRED',input.entryCursor.slot.toString(),
          input.entryCursor.transactionIndex,input.entryCursor.instructionIndex,input.entryCursor.innerInstructionIndex,
          input.externalBuyTarget,'[]',
          decimal(pre), decimal(acquired), decimal(remaining), input.signature,
        ]);
        await client.query(`INSERT INTO live_position_fills (
          signature,order_id,position_id,side,wallet_token_pre_raw,wallet_token_post_raw,delta_raw,applied
        ) VALUES ($1,$2,$3,'BUY',$4,$5,$6,$7)`, [
          input.signature,input.orderId,input.positionId,decimal(pre),
          known ? input.tokenBalance.postAmountRaw.toString() : null,decimal(acquired),known,
        ]);
      } else if (known) {
        await client.query(`UPDATE live_positions SET status='OPEN',wallet_token_pre_raw=$2,
          acquired_raw=$3,remaining_raw=$3,updated_at=clock_timestamp() WHERE position_id=$1
          AND status='RECONCILIATION_REQUIRED'`, [input.positionId,decimal(pre),decimal(acquired)]);
        await client.query(`UPDATE live_position_fills SET wallet_token_pre_raw=$2,
          wallet_token_post_raw=$3,delta_raw=$4,applied=TRUE WHERE signature=$1 AND applied=FALSE`, [
          input.signature,decimal(pre),input.tokenBalance.postAmountRaw.toString(),decimal(acquired),
        ]);
      }
      return requirePosition(await this.read(client, input.positionId));
    });
  }

  public async applySell(input: LivePositionFillInput): Promise<LivePositionRecord> {
    validateIdentity(input);
    return this.transact(async (client) => {
      const duplicate = await client.query('SELECT position_id,applied FROM live_position_fills WHERE signature=$1 FOR UPDATE', [input.signature]);
      if (duplicate.rows.length > 0) {
        const duplicateFill = duplicate.rows[0];
        if (duplicateFill?.position_id !== input.positionId) throw new Error('Signature is already linked to another live position.');
        if (duplicateFill.applied === true) return requirePosition(await this.read(client, input.positionId));
      }
      const position = requirePosition(await this.read(client, input.positionId, true));
      if (position.wallet !== input.wallet || position.mint !== input.mint || position.tokenProgram !== input.tokenProgram) {
        throw new Error('SELL fill identity does not match its position.');
      }
      if (!sameCursor(position.entryCursor,input.entryCursor)) throw new Error('SELL fill entry cursor does not match its position.');
      if (position.externalBuyTarget !== input.externalBuyTarget) throw new Error('SELL fill strategy target does not match its position.');
      const known = input.tokenBalance.status === 'KNOWN'
        && input.tokenBalance.owner === input.wallet && input.tokenBalance.mint === input.mint;
      const resolvingSameSell = position.status === 'RECONCILIATION_REQUIRED' && position.sellSignature === input.signature;
      if (!known || (position.status !== 'OPEN' && !resolvingSameSell) || position.remainingRaw === null
        || input.tokenBalance.deltaRaw >= 0n || -input.tokenBalance.deltaRaw > position.remainingRaw) {
        await this.recordUnresolvedSell(client, input, known ? input.tokenBalance : null);
        await client.query(`UPDATE live_positions SET status='RECONCILIATION_REQUIRED',sell_signature=$2,
          updated_at=clock_timestamp() WHERE position_id=$1 AND status<>'CLOSED'`, [input.positionId,input.signature]);
        return requirePosition(await this.read(client, input.positionId));
      }
      const sold = -input.tokenBalance.deltaRaw;
      const remaining = position.remainingRaw - sold;
      await this.recordUnresolvedSell(client, input, input.tokenBalance);
      await client.query(`UPDATE live_position_fills SET wallet_token_pre_raw=$2,
        wallet_token_post_raw=$3,delta_raw=$4,applied=TRUE WHERE signature=$1 AND applied=FALSE`, [
        input.signature,input.tokenBalance.preAmountRaw.toString(),
        input.tokenBalance.postAmountRaw.toString(),input.tokenBalance.deltaRaw.toString(),
      ]);
      await client.query(`UPDATE live_positions SET status=$2,remaining_raw=$3,sell_signature=$4,
        updated_at=clock_timestamp() WHERE position_id=$1
        AND (status='OPEN' OR (status='RECONCILIATION_REQUIRED' AND sell_signature=$4))`, [
        input.positionId,remaining === 0n ? 'CLOSED' : 'OPEN',remaining.toString(),input.signature,
      ]);
      return requirePosition(await this.read(client, input.positionId));
    });
  }

  public async get(positionId: string): Promise<LivePositionRecord | null> {
    return this.transact((client) => this.read(client, positionId));
  }

  public async listActive(wallet: string): Promise<readonly LivePositionRecord[]> {
    return this.transact(async (client) => {
      const result = await client.query(`SELECT * FROM live_positions WHERE wallet=$1
        AND status IN ('OPEN','RECONCILIATION_REQUIRED') ORDER BY updated_at,position_id`, [wallet]);
      return Object.freeze(result.rows.map(parsePosition));
    });
  }

  public async recordMarketRoute(route: LivePositionMarketRoute): Promise<void> {
    if (route.positionId.length === 0 || !Number.isSafeInteger(route.attempts) || route.attempts < 0
      || (route.state === 'PUMPSWAP') !== (route.poolAddress !== null)) {
      throw new TypeError('Live position market route is malformed.');
    }
    const retryGeneration = route.retryGeneration ?? 0;
    const retryBudget = route.retryBudget ?? 5;
    const retryHistory = route.retryHistory ?? [];
    const resolutionSource=route.resolutionSource??null;
    const resolutionSlot=route.resolutionSlot??null;
    const resolutionAtMs=route.resolutionAtMs??null;
    const resolutionEvidence=route.resolutionEvidence??null;
    if (!Number.isSafeInteger(retryGeneration) || retryGeneration < 0
      || !Number.isSafeInteger(retryBudget) || retryBudget < 1 || retryBudget > 20
      ||(resolutionSlot!==null&&resolutionSlot<0n)
      ||(resolutionAtMs!==null&&(!Number.isSafeInteger(resolutionAtMs)||resolutionAtMs<0))) {
      throw new TypeError('Live position route retry budget is malformed.');
    }
    await this.transact(async (client) => {
      const position = await this.read(client, route.positionId, true);
      if (position === null || position.status === 'CLOSED') throw new Error('Market route requires an active position.');
      await client.query(`INSERT INTO live_position_market_routes (position_id,state,pool_address,attempts,last_error,retry_generation,retry_budget,retry_history,
        resolution_source,resolution_slot,resolution_at_ms,resolution_evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb) ON CONFLICT (position_id) DO UPDATE SET state=EXCLUDED.state,
        pool_address=EXCLUDED.pool_address,attempts=EXCLUDED.attempts,last_error=EXCLUDED.last_error,
        retry_generation=EXCLUDED.retry_generation,retry_budget=EXCLUDED.retry_budget,retry_history=EXCLUDED.retry_history,
        resolution_source=EXCLUDED.resolution_source,resolution_slot=EXCLUDED.resolution_slot,
        resolution_at_ms=EXCLUDED.resolution_at_ms,resolution_evidence=EXCLUDED.resolution_evidence,
        updated_at=clock_timestamp()`, [route.positionId,route.state,route.poolAddress,route.attempts,route.lastError,
          retryGeneration,retryBudget,JSON.stringify(retryHistory),resolutionSource,resolutionSlot?.toString()??null,
          resolutionAtMs,resolutionEvidence===null?null:JSON.stringify(resolutionEvidence)]);
    });
  }

  public async getMarketRoute(positionId: string): Promise<LivePositionMarketRoute | null> {
    return this.transact(async (client) => {
      const result = await client.query('SELECT * FROM live_position_market_routes WHERE position_id=$1', [positionId]);
      const row = result.rows[0];
      if (row === undefined) return null;
      const state = row.state;
      if (state !== 'BONDING_CURVE' && state !== 'WAITING_FOR_POOL' && state !== 'PUMPSWAP'
        && state !== 'RETRY_EXHAUSTED' && state !== 'UNKNOWN') throw new TypeError('Stored live market state is malformed.');
      const poolAddress = row.pool_address;
      const lastError = row.last_error;
      if ((poolAddress !== null && typeof poolAddress !== 'string') || (lastError !== null && typeof lastError !== 'string')) {
        throw new TypeError('Stored live market route is malformed.');
      }
      const retryHistory = parseRetryHistory(row.retry_history);
      const resolutionSource=row.resolution_source;
      const resolutionSlot=parseDatabaseBigint(row.resolution_slot,'resolution slot');
      const resolutionAtMs=row.resolution_at_ms===null||row.resolution_at_ms===undefined?null:Number(row.resolution_at_ms);
      const resolutionEvidence=parseResolutionEvidence(row.resolution_evidence);
      if(resolutionSource!==null&&resolutionSource!=='LOCAL_INDEX'&&resolutionSource!=='RPC_CANONICAL_PDA')throw new TypeError('Stored market resolution source is malformed.');
      if(resolutionSlot!==null&&resolutionSlot<0n)throw new TypeError('Stored market resolution slot is malformed.');
      if(resolutionAtMs!==null&&(!Number.isSafeInteger(resolutionAtMs)||resolutionAtMs<0))throw new TypeError('Stored market resolution time is malformed.');
      return Object.freeze({ positionId, state, poolAddress,
        attempts: integerField(row,'attempts'), lastError,
        retryGeneration: integerField(row,'retry_generation'), retryBudget: integerField(row,'retry_budget'), retryHistory,
        resolutionSource,resolutionSlot,resolutionAtMs,resolutionEvidence });
    });
  }

  public async recordExternalBuyEvents(positionId:string,tradeIds:readonly string[],target:number):Promise<LivePositionRecord>{
    if(!Number.isSafeInteger(target)||target<1||target>1000||tradeIds.some((id)=>id.length===0)
      ||new Set(tradeIds).size!==tradeIds.length)throw new TypeError('Live strategy evidence is invalid.');
    return this.transact(async(client)=>{
      const position=requirePosition(await this.read(client,positionId,true));
      if(position.status!=='OPEN'||position.externalBuyTarget!==target)throw new Error('Live position cannot accept strategy evidence.');
      const ids=new Set(position.countedExternalBuyIds);
      for(const id of tradeIds)ids.add(id);
      await client.query(`UPDATE live_positions SET counted_external_buy_ids=$2::jsonb,updated_at=clock_timestamp()
        WHERE position_id=$1 AND status='OPEN'`,[positionId,JSON.stringify([...ids])]);
      return requirePosition(await this.read(client,positionId));
    });
  }

  private async recordUnresolvedSell(client: QueryClient, input: LivePositionFillInput, balance: Extract<LiveTokenBalanceReconciliation,{status:'KNOWN'}> | null): Promise<void> {
    await client.query(`INSERT INTO live_position_fills (
      signature,order_id,position_id,side,wallet_token_pre_raw,wallet_token_post_raw,delta_raw,applied
    ) VALUES ($1,$2,$3,'SELL',$4,$5,$6,$7)
      ON CONFLICT (signature) DO UPDATE SET wallet_token_pre_raw=EXCLUDED.wallet_token_pre_raw,
        wallet_token_post_raw=EXCLUDED.wallet_token_post_raw,delta_raw=EXCLUDED.delta_raw,
        applied=EXCLUDED.applied WHERE live_position_fills.applied=FALSE`, [
      input.signature,input.orderId,input.positionId,
      balance?.preAmountRaw.toString() ?? null,balance?.postAmountRaw.toString() ?? null,
      balance?.deltaRaw.toString() ?? null,balance !== null,
    ]);
  }

  private async read(client: QueryClient, positionId: string, lock = false): Promise<LivePositionRecord | null> {
    const result = await client.query(`SELECT * FROM live_positions WHERE position_id=$1${lock ? ' FOR UPDATE' : ''}`, [positionId]);
    const row=result.rows[0];
    return row === undefined ? null : parsePosition(row);
  }

  private async transact<T>(operation: (client: QueryClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

function validateIdentity(input: LivePositionFillInput): void {
  for (const field of [input.orderId,input.positionId,input.sessionId,input.candidateId,input.wallet,input.mint,input.tokenProgram,input.signature]) {
    if (field.length === 0 || field !== field.trim()) throw new TypeError('Live fill identity is incomplete.');
  }
}
function decimal(value: bigint | null): string | null { return value?.toString() ?? null; }
function requirePosition(position: LivePositionRecord | null): LivePositionRecord {
  if (position === null) throw new Error('Live position was not persisted.');
  return position;
}
function parsePosition(row: Record<string, unknown>): LivePositionRecord {
  const status = row.status;
  if (status !== 'OPEN' && status !== 'RECONCILIATION_REQUIRED' && status !== 'CLOSED') throw new TypeError('Stored live position status is malformed.');
  const string = (field: string): string => {
    const value = row[field]; if (typeof value !== 'string') throw new TypeError('Stored live position identity is malformed.'); return value;
  };
  const bigint = (field: string): bigint | null => {
    const value = row[field]; if (value === null || value === undefined) return null;
    const text=typeof value==='string'?value:typeof value==='bigint'?value.toString():null;
    if(text===null)throw new TypeError('Stored live quantity is malformed.');
    const parsed = BigInt(text); if (parsed < 0n) throw new TypeError('Stored live quantity is negative.'); return parsed;
  };
  return Object.freeze({
    positionId:string('position_id'),sessionId:string('session_id'),candidateId:string('candidate_id'),
    wallet:string('wallet'),mint:string('mint'),tokenProgram:string('token_program'),status,
    entryCursor:Object.freeze({
      slot:BigInt(String(row.entry_slot)),transactionIndex:integerField(row,'entry_transaction_index'),
      instructionIndex:integerField(row,'entry_instruction_index'),
      innerInstructionIndex:row.entry_inner_instruction_index===null?null:integerField(row,'entry_inner_instruction_index'),
    }),
    externalBuyTarget:integerField(row,'external_buy_target'),
    countedExternalBuyIds:parseStringList(row.counted_external_buy_ids),
    walletTokenPreRaw:bigint('wallet_token_pre_raw'),acquiredRaw:bigint('acquired_raw'),
    remainingRaw:bigint('remaining_raw'),buySignature:string('buy_signature'),
    sellSignature:typeof row.sell_signature === 'string' ? row.sell_signature : null,
  });
}
function integerField(row:Record<string,unknown>,field:string):number{
  const value=Number(row[field]);if(!Number.isSafeInteger(value)||value<0)throw new TypeError('Stored live cursor is malformed.');return value;
}
function sameCursor(left:ChainCursor,right:ChainCursor):boolean{
  return left.slot===right.slot&&left.transactionIndex===right.transactionIndex
    &&left.instructionIndex===right.instructionIndex&&left.innerInstructionIndex===right.innerInstructionIndex;
}
function parseStringList(value:unknown):readonly string[]{
  const parsed=typeof value==='string'?JSON.parse(value) as unknown:value;
  if(!Array.isArray(parsed)||parsed.some((item)=>typeof item!=='string'))throw new TypeError('Stored live strategy evidence is malformed.');
  const items: string[]=[];
  for(const item of parsed as readonly unknown[]){if(typeof item!=='string')throw new TypeError('Stored live strategy evidence is malformed.');items.push(item);}
  return Object.freeze(items);
}
function parseRetryHistory(value: unknown): NonNullable<LivePositionMarketRoute['retryHistory']> {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.some((entry) => entry === null || typeof entry !== 'object')) {
    throw new TypeError('Stored live market retry history is malformed.');
  }
  const entries: readonly unknown[] = parsed;
  return Object.freeze(entries.map((entry) => {
    if(typeof entry!=='object'||entry===null)throw new TypeError('Stored live market retry event is malformed.');
    const record = entry as Record<string, unknown>;
    const state = record.state;
    const error = record.error;
    const at = record.at;
    if (state !== 'BONDING_CURVE' && state !== 'WAITING_FOR_POOL' && state !== 'PUMPSWAP'
      && state !== 'RETRY_EXHAUSTED' && state !== 'UNKNOWN') throw new TypeError('Stored live market retry state is malformed.');
    if (typeof record.attempts !== 'number' || !Number.isSafeInteger(record.attempts) || record.attempts < 0
      || (error !== null && typeof error !== 'string') || typeof at !== 'string') {
      throw new TypeError('Stored live market retry event is malformed.');
    }
    return Object.freeze({ state, attempts: record.attempts, error, at });
  }));
}
function parseResolutionEvidence(value:unknown):Readonly<Record<string,unknown>>|null{
  const parsed=typeof value==='string'?JSON.parse(value) as unknown:value;
  if(parsed===null||parsed===undefined)return null;
  if(typeof parsed!=='object'||Array.isArray(parsed))throw new TypeError('Stored market resolution evidence is malformed.');
  return Object.freeze(parsed as Record<string,unknown>);
}
function parseDatabaseBigint(value:unknown,label:string):bigint|null{
  if(value===null||value===undefined)return null;
  if(typeof value==='string'&&/^(0|[1-9]\d*)$/u.test(value))return BigInt(value);
  if(typeof value==='bigint'&&value>=0n)return value;
  throw new TypeError(`Stored ${label} is malformed.`);
}
