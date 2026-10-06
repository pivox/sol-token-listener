export type LiveOrderSide = 'BUY' | 'SELL';
export type LiveOrderStatus = 'PREPARED' | 'SIGNED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED' | 'UNKNOWN';

export interface LiveOrderIntent {
  readonly orderId: string;
  readonly wallet: string;
  readonly positionId: string;
  readonly side: LiveOrderSide;
  readonly intent: Readonly<Record<string, unknown>>;
  readonly validity: Readonly<Record<string, unknown>>;
}

export interface UnresolvedLiveOrder {
  readonly orderId: string;
  readonly wallet: string;
  readonly positionId: string;
  readonly side: LiveOrderSide;
  readonly status: Extract<LiveOrderStatus, 'PREPARED' | 'SIGNED' | 'SUBMITTED' | 'UNKNOWN'>;
  readonly signature: string | null;
  readonly signedTransaction: Uint8Array | null;
  readonly intent: Readonly<Record<string, unknown>>;
  readonly validity: Readonly<Record<string, unknown>>;
}

export interface ConfirmedLiveOrderNeedingFill extends Omit<UnresolvedLiveOrder,'status'> {
  readonly status: 'CONFIRMED';
  readonly transactionMetadata: Readonly<Record<string, unknown>>;
}

interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
}

interface QueryClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(error?: boolean | Error): void;
}

interface Connectable {
  connect(): Promise<QueryClient>;
}

export interface LiveWalletLease {
  readonly wallet: string;
  release(): Promise<void>;
}

export class PostgresLiveOrderJournal {
  public constructor(private readonly pool: Connectable) {}

  public async acquireWalletLock(wallet: string): Promise<LiveWalletLease> {
    requireText(wallet, 'wallet');
    const client = await this.pool.connect();
    let lockResult: QueryResult;
    try {
      lockResult = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended('live-wallet-executor:' || $1, 0)) AS locked",
        [wallet],
      );
    } catch (error) {
      client.release(error instanceof Error ? error : true);
      throw error;
    }
    if (lockResult.rows[0]?.locked !== true) {
      client.release();
      throw new Error('Wallet already has an executor.');
    }
    let released = false;
    return Object.freeze({
      wallet,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        let failure: unknown;
        try {
          const result = await client.query(
            "SELECT pg_advisory_unlock(hashtextextended('live-wallet-executor:' || $1, 0)) AS unlocked",
            [wallet],
          );
          if (result.rows[0]?.unlocked !== true) throw new Error('Live wallet lock was not released.');
        } catch (error) {
          failure = error;
        } finally {
          client.release(failure instanceof Error ? failure : failure === undefined ? undefined : true);
        }
        if (failure !== undefined) throw failure;
      },
    });
  }

  /** Single INSERT commits the order intent before a transaction can be built or sent. */
  public async prepare(input: LiveOrderIntent): Promise<void> {
    validateIntent(input);
    await this.withClient(async (client) => {
      await client.query(
        `INSERT INTO live_orders (
           order_id,wallet,position_id,side,status,intent,validity,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,'PREPARED',$5::jsonb,$6::jsonb,clock_timestamp(),clock_timestamp())`,
        [input.orderId, input.wallet, input.positionId, input.side, json(input.intent), json(input.validity)],
      );
    });
  }

  /** Persist the signature and exact signed bytes before broadcasting. Never reconstruct on recovery. */
  public async persistSigned(orderId: string, signature: string, signedTransaction: Uint8Array): Promise<void> {
    requireText(orderId, 'orderId');
    requireText(signature, 'signature');
    if (!(signedTransaction instanceof Uint8Array) || signedTransaction.length === 0 || signedTransaction.length > 1_000_000) {
      throw new TypeError('Signed transaction bytes are missing or exceed the journal bound.');
    }
    await this.withClient(async (client) => {
      const result = await client.query(
        `UPDATE live_orders
         SET status='SIGNED',signature=$2,signed_transaction=$3,updated_at=clock_timestamp()
         WHERE order_id=$1 AND status='PREPARED' AND signature IS NULL
         RETURNING order_id`,
        [orderId, signature, Buffer.from(signedTransaction)],
      );
      requireOneRow(result, 'Order is missing or cannot accept its first signature.');
    });
  }

  /** Call and durably await this transition immediately before the network send attempt. */
  public async markSubmitted(orderId: string): Promise<void> {
    await this.transition(orderId, ['SIGNED'], 'SUBMITTED', null);
  }

  public async markUnknown(orderId: string, diagnostic: Readonly<Record<string, unknown>>): Promise<void> {
    await this.transition(orderId, ['SIGNED', 'SUBMITTED', 'UNKNOWN'], 'UNKNOWN', diagnostic);
  }

  public async resolve(
    orderId: string,
    status: 'CONFIRMED' | 'FAILED' | 'EXPIRED',
    transactionMetadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.transition(orderId, ['SUBMITTED', 'UNKNOWN'], status, transactionMetadata);
  }

  public async listUnresolved(wallet: string): Promise<readonly UnresolvedLiveOrder[]> {
    requireText(wallet, 'wallet');
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT order_id,wallet,position_id,side,status,signature,signed_transaction,intent,validity
         FROM live_orders
         WHERE wallet=$1 AND status IN ('PREPARED','SIGNED','SUBMITTED','UNKNOWN')
         ORDER BY created_at ASC,order_id ASC`,
        [wallet],
      );
      return Object.freeze(result.rows.map(parseUnresolvedOrder));
    });
  }

  /** Confirmed orders whose token delta has not yet been atomically applied to a position. */
  public async listConfirmedNeedingFill(wallet: string): Promise<readonly ConfirmedLiveOrderNeedingFill[]> {
    requireText(wallet,'wallet');
    return this.withClient(async(client)=>{
      const result=await client.query(`SELECT o.order_id,o.wallet,o.position_id,o.side,o.signature,
        o.signed_transaction,o.intent,o.validity,o.transaction_metadata
        FROM live_orders o LEFT JOIN live_position_fills f ON f.signature=o.signature
        WHERE o.wallet=$1 AND o.status='CONFIRMED' AND (f.signature IS NULL OR f.applied=FALSE)
        ORDER BY o.created_at,o.order_id`,[wallet]);
      return Object.freeze(result.rows.map(parseConfirmedOrder));
    });
  }

  public async countBuyOrders(wallet:string):Promise<number>{
    requireText(wallet,'wallet');
    return this.withClient(async(client)=>{
      const result=await client.query("SELECT COUNT(*)::int AS count FROM live_orders WHERE wallet=$1 AND side='BUY'",[wallet]);
      const count=result.rows[0]?.count;
      if(typeof count!=='number'||!Number.isSafeInteger(count)||count<0)throw new TypeError('Live BUY order count is malformed.');
      return count;
    });
  }

  private async transition(
    orderId: string,
    allowedFrom: readonly LiveOrderStatus[],
    status: Extract<LiveOrderStatus, 'SUBMITTED' | 'UNKNOWN' | 'CONFIRMED' | 'FAILED' | 'EXPIRED'>,
    metadata: Readonly<Record<string, unknown>> | null,
  ): Promise<void> {
    requireText(orderId, 'orderId');
    await this.withClient(async (client) => {
      const result = await client.query(
        `UPDATE live_orders
         SET status=$3,transaction_metadata=COALESCE($4::jsonb,transaction_metadata),updated_at=clock_timestamp()
         WHERE order_id=$1 AND status=ANY($2::text[])
         RETURNING order_id`,
        [orderId, [...allowedFrom], status, metadata === null ? null : json(metadata)],
      );
      requireOneRow(result, 'Order is missing or its state does not allow this transition.');
    });
  }

  private async withClient<T>(operation: (client: QueryClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }
}

function validateIntent(input: LiveOrderIntent): void {
  requireText(input.orderId, 'orderId');
  requireText(input.wallet, 'wallet');
  requireText(input.positionId, 'positionId');
  if (input.side !== 'BUY' && input.side !== 'SELL') throw new TypeError('Live order side is invalid.');
  if (Object.keys(input.intent).length === 0 || Object.keys(input.validity).length === 0) {
    throw new TypeError('Live order intent and validity must both be explicit.');
  }
  json(input.intent);
  json(input.validity);
}

function json(value: Readonly<Record<string, unknown>>): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { throw new TypeError('Live order journal payload is not serializable.'); }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 64_000) {
    throw new TypeError('Live order journal payload is empty or exceeds its bound.');
  }
  return serialized;
}

function requireText(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.length > 256) {
    throw new TypeError(`Live order journal ${name} is invalid.`);
  }
}

function requireOneRow(result: QueryResult, message: string): void {
  if (result.rows.length !== 1) throw new Error(message);
}

function parseUnresolvedOrder(row: Record<string, unknown>): UnresolvedLiveOrder {
  const orderId = row.order_id; const wallet = row.wallet; const positionId = row.position_id;
  const side = row.side; const status = row.status; const signature = row.signature;
  const signedTransaction = row.signed_transaction;
  if (typeof orderId !== 'string' || typeof wallet !== 'string' || typeof positionId !== 'string'
    || (side !== 'BUY' && side !== 'SELL')
    || (status !== 'PREPARED' && status !== 'SIGNED' && status !== 'SUBMITTED' && status !== 'UNKNOWN')
    || (signature !== null && typeof signature !== 'string')
    || (signedTransaction !== null && !(signedTransaction instanceof Uint8Array))
    || ((signature === null) !== (signedTransaction === null))) {
    throw new TypeError('Stored unresolved live order is malformed.');
  }
  return Object.freeze({
    orderId, wallet, positionId, side, status, signature,
    signedTransaction: signedTransaction === null ? null : Uint8Array.from(signedTransaction),
    intent: parseJsonObject(row.intent),
    validity: parseJsonObject(row.validity),
  });
}

function parseConfirmedOrder(row:Record<string,unknown>):ConfirmedLiveOrderNeedingFill{
  const parsed=parseUnresolvedOrder({
    ...row,status:'UNKNOWN',signed_transaction:row.signed_transaction,
  });
  if(typeof row.signature!=='string'||!(row.signed_transaction instanceof Uint8Array)){
    throw new TypeError('Stored confirmed live order is missing its signed transaction.');
  }
  return Object.freeze({...parsed,status:'CONFIRMED' as const,transactionMetadata:parseJsonObject(row.transaction_metadata)});
}

function parseJsonObject(value: unknown): Readonly<Record<string, unknown>> {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Stored live order JSON is malformed.');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function safeParse(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return null; }
}
