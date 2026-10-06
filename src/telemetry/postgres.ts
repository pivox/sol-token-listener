import { identity } from './journal.js';
import type { Observation, TradeEvidence } from './position.js';
interface Client {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}
export interface ReadPool { connect(): Promise<Client> }
const s = (v: unknown): string => { if (typeof v !== 'string') throw new Error('INVALID_DB_FIELD'); return v; };
const status = (v: unknown): TradeEvidence['confirmation'] => {
  if (v === 'processed' || v === 'confirmed' || v === 'finalized' || v === 'orphaned') return v;
  throw new Error('INVALID_DB_CONFIRMATION');
};
const numeric = (v: unknown): string => { const value=s(v); if (!/^\d+$/.test(value)) throw new Error('INVALID_DB_RAW'); return value; };
const bounded = (rows: Record<string,unknown>[]): Record<string,unknown>[] => {
  if (rows.length > 10000) throw new Error('TELEMETRY_DB_ROW_LIMIT'); return rows;
};

/** Captures current mutable projections atomically. Availability is query completion time, never backdated. */
export async function captureMarket(pool: ReadPool, mint: string, entrySlot: string, clock: () => number = Date.now): Promise<Observation> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '750ms'");
    await client.query("SET LOCAL lock_timeout = '50ms'");
    const launch = await client.query(`SELECT launch.creator FROM token_launches launch
      JOIN domain_events e ON e.mint=launch.mint AND e.type='TokenLaunchDetected'
      AND e.signature=launch.created_signature AND e.confirmation_status <> 'orphaned'
      WHERE launch.mint=$1 LIMIT 1`,[mint]);
    const found = launch.rows[0];
    const tradeRows = await client.query(`SELECT e.event_id AS id, e.signature, t.trader AS wallet,
      t.trade_kind AS side, t.quote_amount_raw::text, t.quote_mint, t.slot::text,
      e.observed_at, CASE WHEN e.confirmation_status='orphaned' THEN 'orphaned' ELSE t.confirmation_status END AS confirmation
      FROM launch_trades t JOIN domain_events e ON e.mint=t.mint
        AND e.type='BondingCurveTradeObserved' AND e.slot=t.slot
        AND e.transaction_index=t.transaction_index AND e.instruction_index=t.instruction_index
        AND e.inner_instruction_index IS NOT DISTINCT FROM t.inner_instruction_index
      WHERE t.mint=$1 AND t.slot >= $2::numeric
      UNION ALL
      SELECT trade_id AS id, signature, trader AS wallet, trade_kind AS side,
        quote_amount_raw::text, quote_mint, slot::text, observed_at, confirmation_status AS confirmation
      FROM market_trades WHERE mint=$1 AND slot >= $2::numeric
      ORDER BY id LIMIT 10001`,[mint,entrySlot]);
    const trades: TradeEvidence[] = bounded(tradeRows.rows).map(r => ({ id:s(r.id),signature:s(r.signature),wallet:r.wallet === null ? null:s(r.wallet),
      side:r.side === 'BUY' ? 'BUY' : r.side === 'SELL' ? 'SELL' : ((): never => {throw new Error('INVALID_SIDE');})(),
      quoteAmountRaw:numeric(r.quote_amount_raw),quoteMint:s(r.quote_mint),slot:numeric(r.slot),
      observedAtMs:r.observed_at instanceof Date ? r.observed_at.getTime():Date.parse(s(r.observed_at)),confirmation:status(r.confirmation) }));
    const graph = (await client.query('SELECT coverage, confirmation_status, input_fingerprint FROM wallet_graph_profiles WHERE mint=$1',[mint])).rows[0];
    const graphAvailable = graph?.confirmation_status === 'finalized';
    const clusters: Observation['clusters'] = []; const relationships: Observation['relationships'] = [];
    if (graphAvailable) {
      const groups = await client.query(`SELECT c.cluster_id AS id, c.shared_funder_count > 0 AS shared_funder,
        array_agg(m.wallet ORDER BY m.wallet) AS wallets FROM wallet_clusters c
        JOIN wallet_cluster_members m ON m.mint=c.mint AND m.cluster_id=c.cluster_id AND m.input_fingerprint=c.input_fingerprint
        WHERE c.mint=$1 AND c.input_fingerprint=$2 AND m.member_role='PARTICIPANT'
        GROUP BY c.cluster_id, c.shared_funder_count ORDER BY c.cluster_id LIMIT 10001`,[mint,s(graph.input_fingerprint)]);
      for (const r of bounded(groups.rows)) {
        if (!Array.isArray(r.wallets) || !r.wallets.every((w: unknown) => typeof w === 'string')) throw new Error('INVALID_MEMBERS');
        clusters.push({id:s(r.id),wallets:r.wallets,sharedFunder:r.shared_funder === true});
      }
      const edges = await client.query(`SELECT left_wallet, right_wallet, confidence FROM wallet_relationships
        WHERE mint=$1 AND input_fingerprint=$2 ORDER BY relationship_id LIMIT 10001`,[mint,s(graph.input_fingerprint)]);
      for (const r of bounded(edges.rows)) relationships.push({left:s(r.left_wallet),right:s(r.right_wallet),confidence:s(r.confidence)});
    }
    await client.query('COMMIT');
    const atMs=clock();
    const body = {atMs,kind:'market' as const,creator:found ? s(found.creator):null,
      coverage:found ? 'OBSERVED' as const:'UNAVAILABLE' as const,trades,clusters,relationships,graphAvailable,
      graphCoverage:graph && typeof graph.coverage === 'object' && graph.coverage !== null ? graph.coverage as Record<string,unknown>:null,quote:null};
    return {id:identity([mint,body]),...body};
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
