import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { PublicKey } from '@solana/web3.js';

const { values } = parseArgs({ options: {
  session: { type: 'string' }, wallet: { type: 'string' }, out: { type: 'string' },
} });

export async function exportLiveSessionEvidence(input: {
  readonly sessionId: string;
  readonly wallet: string;
  readonly outputDirectory: string;
  readonly databaseUrl: string;
  readonly queryable?: Pick<pg.Pool, 'connect'>;
}): Promise<{ readonly orders: number; readonly signatures: number; readonly output: string }> {
  if (input.sessionId.length === 0 || input.sessionId !== input.sessionId.trim()) throw new Error('SESSION_ID_REQUIRED');
  if (new PublicKey(input.wallet).toBase58() !== input.wallet) throw new Error('WALLET_MUST_BE_CANONICAL');
  const outputDirectory = path.resolve(input.outputDirectory);
  const sessionFile = path.join(outputDirectory, 'session.jsonl');
  try { await access(outputDirectory); throw new Error('OUTPUT_DIRECTORY_ALREADY_EXISTS'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }

  const pool: Pick<pg.Pool, 'connect'> & Partial<Pick<pg.Pool, 'end'>> = input.queryable
    ?? new pg.Pool({ connectionString: input.databaseUrl, max: 1, statement_timeout: 5_000 });
  const ownsPool = input.queryable === undefined;
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(`SELECT o.order_id,o.wallet,o.position_id,o.side,o.status,o.signature,
        o.intent,o.validity,o.created_at,o.updated_at,
        COALESCE(p.session_id,o.intent->>'sessionId') AS session_id,
        COALESCE(p.candidate_id,o.intent->>'candidateId') AS candidate_id,
        COALESCE(p.mint,o.intent->>'mint') AS mint,
        p.token_program,p.status AS position_status,p.acquired_raw::text AS position_acquired_raw,
        p.remaining_raw::text AS position_remaining_raw,p.buy_signature,p.sell_signature,
        f.wallet_token_pre_raw::text AS fill_pre_raw,f.wallet_token_post_raw::text AS fill_post_raw,
        f.delta_raw::text AS fill_delta_raw,f.applied AS fill_applied
      FROM live_orders o
      LEFT JOIN live_positions p ON p.position_id=o.position_id AND p.wallet=o.wallet
      LEFT JOIN live_position_fills f ON f.order_id=o.order_id
      WHERE o.wallet=$1 AND COALESCE(p.session_id,o.intent->>'sessionId')=$2
      ORDER BY o.created_at,o.order_id`, [input.wallet, input.sessionId]);
    const rows = result.rows.map((row) => ({
      schema: 'live_session_evidence.v1',
      event: `${String(row.side).toLowerCase()}_order`,
      sessionId: row.session_id,
      wallet: row.wallet,
      positionId: row.position_id,
      orderId: row.order_id,
      side: row.side,
      orderStatus: row.status,
      signature: row.signature,
      mint: row.mint,
      tokenProgram: row.token_program,
      candidateId: row.candidate_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      intent: row.intent,
      validity: row.validity,
      positionSnapshot: row.position_status === null ? null : {
        status: row.position_status,
        acquiredRaw: row.position_acquired_raw,
        remainingRaw: row.position_remaining_raw,
        buySignature: row.buy_signature,
        sellSignature: row.sell_signature,
      },
      fillSnapshot: row.fill_applied === null || row.fill_applied === undefined ? null : {
        preRaw: row.fill_pre_raw,
        postRaw: row.fill_post_raw,
        deltaRaw: row.fill_delta_raw,
        applied: row.fill_applied,
      },
    }));
    await client.query('COMMIT');
    await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
    const text = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length === 0 ? '' : '\n');
    await writeFile(sessionFile, text, { mode: 0o600, flag: 'wx' });
    return Object.freeze({ orders: rows.length, signatures: rows.filter((row) => typeof row.signature === 'string').length, output: sessionFile });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve primary read failure */ }
    throw error;
  } finally {
    client.release();
    if (ownsPool && pool.end !== undefined) await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const sessionId = values.session;
  const wallet = values.wallet;
  const outputDirectory = values.out;
  const databaseUrl = process.env.LIVE_OPERATOR_DATABASE_URL;
  if (!sessionId || !wallet || !outputDirectory || !databaseUrl) {
    process.stderr.write('Usage: LIVE_OPERATOR_DATABASE_URL=<read-only DSN> npm run live:evidence:export -- --session ID --wallet PUBKEY --out NEW_DIR\n');
    process.exitCode = 2;
  } else {
    void exportLiveSessionEvidence({ sessionId, wallet, outputDirectory, databaseUrl }).then((result) => {
      process.stdout.write(`${JSON.stringify({ event: 'live_session_evidence_exported', ...result })}\n`);
    }).catch((error: unknown) => {
      process.stderr.write(`LIVE_EVIDENCE_EXPORT_FAILED: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      process.exitCode = 1;
    });
  }
}
