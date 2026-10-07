// Lot 4b: read-only fast-path report (spec «Mesure»): funnel, latencies, result per position and
// RPC 429 counts. Every read runs in one REPEATABLE READ READ ONLY transaction that is rolled
// back. The output never contains a signature, a wallet public key, a URL or a key.
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { exitReasonOfLogicalKey, type ExitReason } from '../domain/fast-exit.js';
import { createRuntimeRpcHttpEvidence } from '../domain/rpc-http-evidence.js';

const HOUR_MS = 3_600_000;
const DEFAULT_WINDOW_MS = 24 * HOUR_MS;
const MAXIMUM_WINDOW_MS = 7 * 24 * HOUR_MS;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const OPTION = /^--(since|until|format)=(.*)$/u;
const RETRY_SUFFIX = /:retry-([1-9][0-9]*)$/u;
const LATENCY_KEYS = Object.freeze([
  'blockToObserved', 'observedToDecided', 'decidedToArmed', 'armedToSubmitted',
  'submittedToConfirmed',
] as const);
const RETENTION_NOTE = 'armaments and signed artifacts are purged 4 h after terminal; '
  + 'run within 4 h of the run';

export type FastPathReportFormat = 'table' | 'json';
type LatencyKey = typeof LATENCY_KEYS[number];

export interface FastPathReportOptions {
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly format: FastPathReportFormat;
}

export interface LatencySummary {
  readonly count: number;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly max: number | null;
}

export interface FastPathPosition {
  readonly mint: string;
  readonly state: string;
  readonly openedAtMs: number;
  readonly closedAtMs: number | null;
  readonly holdingMs: number | null;
  readonly exitReason: ExitReason | 'UNKNOWN';
  readonly reExits: number;
  readonly netLamports: string | null;
  readonly pnlBps: number | null;
  readonly failedSellFeesLamports: string;
}

export interface FastPathListenerRpc429 {
  readonly providerId: string;
  readonly attempts: number;
  readonly http429Responses: number;
  readonly sinceMs: number | null;
}

export interface FastPathReport {
  readonly schemaVersion: 'fast-path-report.v1';
  readonly window: { readonly sinceMs: number; readonly untilMs: number };
  readonly funnel: {
    readonly createsObserved: number;
    readonly decisions: number;
    readonly rejectedByReason: Readonly<Record<string, number>>;
    readonly buyIntents: number;
    readonly armed: number;
    readonly submitted: number;
    readonly confirmed: number;
  };
  readonly latenciesMs: Readonly<Record<LatencyKey, LatencySummary>>;
  readonly positions: readonly FastPathPosition[];
  readonly rpc429: {
    readonly listener: readonly FastPathListenerRpc429[] | null;
    readonly executor: { readonly rateLimitEvents: number; readonly note: 'retention 4 h' };
  };
  readonly retentionNote: string;
}

export interface FastPathReportQueryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

export function parseFastPathReportArguments(
  arguments_: readonly string[],
  nowMs: number,
): FastPathReportOptions {
  const values = new Map<string, string>();
  for (const argument of arguments_) {
    const match = OPTION.exec(argument);
    const name = match?.[1];
    if (match === null || name === undefined || values.has(name)) throw invalidOptions();
    values.set(name, match[2] ?? '');
  }
  const until = values.get('until');
  const since = values.get('since');
  const untilMs = until === undefined ? nowMs : isoTimestamp(until);
  const sinceMs = since === undefined ? untilMs - DEFAULT_WINDOW_MS : isoTimestamp(since);
  if (!Number.isSafeInteger(untilMs) || !Number.isSafeInteger(sinceMs)
    || untilMs <= sinceMs || untilMs - sinceMs > MAXIMUM_WINDOW_MS) throw invalidOptions();
  const format = values.get('format') ?? 'table';
  if (format !== 'table' && format !== 'json') throw invalidOptions();
  return Object.freeze({ sinceMs, untilMs, format });
}

/** Nearest-rank percentiles; null summary values when there is no sample. */
export function latencySummary(values: readonly number[]): LatencySummary {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = (percentile: number): number | null => sorted.length === 0
    ? null
    : sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)] ?? null;
  return Object.freeze({
    count: sorted.length, p50: rank(50), p90: rank(90), max: sorted.at(-1) ?? null,
  });
}

/**
 * net × 10 000 / cost, cost = −entry wallet lamport delta, rounded half away from zero; null
 * when the entry did not spend lamports.
 */
export function pnlBps(netLamports: bigint, entryWalletLamportDelta: bigint): number | null {
  const cost = -entryWalletLamportDelta;
  if (cost <= 0n) return null;
  const numerator = netLamports * 10_000n;
  let quotient = numerator / cost;
  const remainder = numerator % cost;
  const absoluteRemainder = remainder < 0n ? -remainder : remainder;
  if (absoluteRemainder * 2n >= cost) quotient += numerator < 0n ? -1n : 1n;
  return Number(quotient);
}

/** Runs `operation` in one REPEATABLE READ READ ONLY transaction, always rolled back. */
export async function withReadOnlyTransaction<T>(
  database: FastPathReportQueryable,
  operation: (database: FastPathReportQueryable) => Promise<T>,
): Promise<T> {
  await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    return await operation(database);
  } finally {
    await database.query('ROLLBACK');
  }
}

/** Reads the report; the caller runs it inside `withReadOnlyTransaction`. */
export async function collectFastPathReport(
  database: FastPathReportQueryable,
  options: Pick<FastPathReportOptions, 'sinceMs' | 'untilMs'>,
): Promise<FastPathReport> {
  const window = [new Date(options.sinceMs), new Date(options.untilMs)];
  const creates = await database.query(
    `SELECT COUNT(*)::INTEGER AS count FROM domain_events
     WHERE created_at >= $1 AND created_at < $2
       AND type='TokenLaunchDetected' AND confirmation_status <> 'orphaned'`,
    window,
  );
  const decisions = await database.query(
    `WITH decision AS MATERIALIZED (
       SELECT decision,reason_code,intent_id,create_block_time,observed_at,decided_at
       FROM entry_decisions WHERE observed_at >= $1 AND observed_at < $2
     ), buy AS MATERIALIZED (
       SELECT intent_id FROM decision WHERE decision='BUY' AND intent_id IS NOT NULL
     ), armed AS (
       SELECT target_intent_id AS intent_id,MIN(armed_at) AS armed_at
       FROM execution_activation_armaments
       WHERE target_intent_id IN (SELECT intent_id FROM buy) GROUP BY target_intent_id
     ), signed AS (
       SELECT intent_id,MIN(submitted_at) AS submitted_at,MIN(confirmed_at) AS confirmed_at
       FROM execution_signed_transactions
       WHERE side='BUY' AND intent_id IN (SELECT intent_id FROM buy) GROUP BY intent_id
     )
     SELECT decision.decision,decision.reason_code,
       (decision.decision='BUY' AND decision.intent_id IS NOT NULL) AS buy_intent,
       armed.armed_at IS NOT NULL AS armed,
       signed.submitted_at IS NOT NULL AS submitted,
       signed.confirmed_at IS NOT NULL AS confirmed,
       ${milliseconds('decision.create_block_time', 'decision.observed_at')} AS block_to_observed,
       ${milliseconds('decision.observed_at', 'decision.decided_at')} AS observed_to_decided,
       ${milliseconds('decision.decided_at', 'armed.armed_at')} AS decided_to_armed,
       ${milliseconds('armed.armed_at', 'signed.submitted_at')} AS armed_to_submitted,
       ${milliseconds('signed.submitted_at', 'signed.confirmed_at')} AS submitted_to_confirmed
     FROM decision
     LEFT JOIN armed ON armed.intent_id=decision.intent_id
     LEFT JOIN signed ON signed.intent_id=decision.intent_id`,
    window,
  );
  const positions = await database.query(
    `WITH position AS (
       SELECT position_id,mint,'CLOSED' AS state,opened_at,closed_at,
         net_lamports::TEXT AS net_lamports,
         entry_wallet_lamport_delta::TEXT AS entry_wallet_lamport_delta
       FROM execution_live_position_ledger WHERE opened_at >= $1 AND opened_at < $2
       UNION ALL
       SELECT live.position_id,live.mint,live.state,live.opened_at,live.closed_at,NULL,NULL
       FROM execution_live_positions live
       WHERE live.opened_at >= $1 AND live.opened_at < $2
         AND NOT EXISTS (SELECT 1 FROM execution_live_position_ledger ledger
           WHERE ledger.position_id=live.position_id)
     )
     SELECT position.position_id,position.mint,position.state,
       ${epochMilliseconds('position.opened_at')} AS opened_at_ms,
       ${epochMilliseconds('position.closed_at')} AS closed_at_ms,
       position.net_lamports,position.entry_wallet_lamport_delta,
       (SELECT intent.logical_command_id FROM execution_intents intent
        WHERE intent.side='SELL' AND intent.position_id=position.position_id
        ORDER BY intent.requested_at DESC,intent.id DESC LIMIT 1) AS intent_key,
       (SELECT tombstone.logical_order_key FROM execution_intent_tombstones tombstone
        WHERE (tombstone.logical_order_key LIKE 'maximum-holding:%'
            OR tombstone.logical_order_key LIKE 'fast-exit:%')
          AND tombstone.logical_order_key LIKE '%:' || position.position_id || '%'
        ORDER BY tombstone.retired_at DESC,tombstone.logical_order_key DESC
        LIMIT 1) AS tombstone_key,
       (SELECT COALESCE(SUM(evidence.fee_lamports),0)::TEXT
        FROM execution_reconciliation_evidence evidence
        JOIN execution_intents intent ON intent.id=evidence.intent_id
        WHERE intent.side='SELL' AND intent.position_id=position.position_id
          AND evidence.side='SELL' AND evidence.result='NO_EFFECT'
          AND evidence.signature_history='PRESENT') AS failed_sell_fees
     FROM position ORDER BY position.opened_at,position.position_id`,
    window,
  );
  const heartbeat = await database.query(
    `SELECT payload->'rpcHttpEvidence' AS evidence,
       ${epochMilliseconds('started_at')} AS started_at_ms
     FROM listener_heartbeats ORDER BY updated_at DESC,service_key LIMIT 1`,
  );
  const rateLimits = await database.query(
    `SELECT COUNT(*)::INTEGER AS count FROM execution_provider_rate_limit_events
     WHERE observed_at >= $1 AND observed_at < $2`,
    window,
  );
  return Object.freeze({
    schemaVersion: 'fast-path-report.v1',
    window: Object.freeze({ sinceMs: options.sinceMs, untilMs: options.untilMs }),
    ...decisionSections(decisions.rows, count(creates.rows[0]?.count)),
    positions: Object.freeze(positions.rows.map(positionFromRow)),
    rpc429: Object.freeze({
      listener: listenerRpc429(heartbeat.rows[0]),
      executor: Object.freeze({
        rateLimitEvents: count(rateLimits.rows[0]?.count), note: 'retention 4 h' as const,
      }),
    }),
    retentionNote: RETENTION_NOTE,
  });
}

export function formatFastPathReport(report: FastPathReport, format: FastPathReportFormat): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  const { funnel } = report;
  const lines = [
    `fast-path report v1  ${iso(report.window.sinceMs)} -> ${iso(report.window.untilMs)}`,
    '',
    'Funnel',
    row(['  creates observed', funnel.createsObserved], [24]),
    row(['  decisions', funnel.decisions], [24]),
    ...Object.entries(funnel.rejectedByReason)
      .map(([reason, value]) => row([`    rejected ${reason}`, value], [40])),
    row(['  buy intents', funnel.buyIntents], [24]),
    row(['  armed', funnel.armed], [24]),
    row(['  submitted', funnel.submitted], [24]),
    row(['  confirmed', funnel.confirmed], [24]),
    '',
    row(['Latencies (ms)', 'count', 'p50', 'p90', 'max'], [24, 8, 10, 10]),
    ...LATENCY_KEYS.map((key) => {
      const summary = report.latenciesMs[key];
      return row([`  ${key}`, summary.count, dash(summary.p50), dash(summary.p90),
        dash(summary.max)], [24, 8, 10, 10]);
    }),
    '',
    `Positions (${report.positions.length})`,
  ];
  const widths = [48, 14, 26, 10, 18, 9, 14, 8];
  if (report.positions.length > 0) {
    lines.push(row(['  mint', 'state', 'opened', 'holdingMs', 'exitReason', 'reExits',
      'netLamports', 'pnlBps', 'failedSellFees'], widths));
  }
  for (const position of report.positions) {
    lines.push(row([`  ${position.mint}`, position.state, iso(position.openedAtMs),
      dash(position.holdingMs), position.exitReason, position.reExits,
      dash(position.netLamports), dash(position.pnlBps), position.failedSellFeesLamports], widths));
  }
  lines.push('', 'RPC 429');
  if (report.rpc429.listener === null) {
    lines.push('  listener   no heartbeat evidence');
  } else {
    for (const provider of report.rpc429.listener) {
      lines.push(`  listener   ${provider.providerId}  attempts=${provider.attempts}`
        + `  http429=${provider.http429Responses}`
        + `  since=${provider.sinceMs === null ? '-' : iso(provider.sinceMs)}`);
    }
  }
  lines.push(`  executor   rateLimitEvents=${report.rpc429.executor.rateLimitEvents}`
    + `  (${report.rpc429.executor.note})`, '', `Note: ${report.retentionNote}`);
  return `${lines.join('\n')}\n`;
}

function decisionSections(
  rows: readonly Record<string, unknown>[],
  createsObserved: number,
): Pick<FastPathReport, 'funnel' | 'latenciesMs'> {
  const rejectedByReason = new Map<string, number>();
  const samples = new Map<LatencyKey, number[]>(LATENCY_KEYS.map((key) => [key, []]));
  let buyIntents = 0;
  let armed = 0;
  let submitted = 0;
  let confirmed = 0;
  for (const decision of rows) {
    if (decision.decision === 'REJECTED') {
      const reason = text(decision.reason_code);
      rejectedByReason.set(reason, (rejectedByReason.get(reason) ?? 0) + 1);
    }
    if (decision.buy_intent === true) buyIntents += 1;
    if (decision.buy_intent === true && decision.armed === true) armed += 1;
    if (decision.buy_intent === true && decision.submitted === true) submitted += 1;
    if (decision.buy_intent === true && decision.confirmed === true) confirmed += 1;
    const columns: Readonly<Record<LatencyKey, unknown>> = {
      blockToObserved: decision.block_to_observed,
      observedToDecided: decision.observed_to_decided,
      decidedToArmed: decision.decided_to_armed,
      armedToSubmitted: decision.armed_to_submitted,
      submittedToConfirmed: decision.submitted_to_confirmed,
    };
    for (const key of LATENCY_KEYS) {
      const value = nullableInteger(columns[key]);
      if (value !== null) samples.get(key)?.push(value);
    }
  }
  return {
    funnel: Object.freeze({
      createsObserved,
      decisions: rows.length,
      rejectedByReason: Object.freeze(Object.fromEntries([...rejectedByReason.entries()]
        .sort(([left], [right]) => left.localeCompare(right)))),
      buyIntents, armed, submitted, confirmed,
    }),
    latenciesMs: Object.freeze(Object.fromEntries(LATENCY_KEYS.map((key) => [
      key, latencySummary(samples.get(key) ?? []),
    ])) as Record<LatencyKey, LatencySummary>),
  };
}

function positionFromRow(position: Record<string, unknown>): FastPathPosition {
  const positionId = text(position.position_id);
  const openedAtMs = integer(position.opened_at_ms);
  const closedAtMs = nullableInteger(position.closed_at_ms);
  const exit = [position.intent_key, position.tombstone_key]
    .map((key) => exitOfKey(key, positionId))
    .find((value) => value !== null) ?? null;
  const net = position.net_lamports === null ? null : BigInt(text(position.net_lamports));
  const entry = position.entry_wallet_lamport_delta === null
    ? null : BigInt(text(position.entry_wallet_lamport_delta));
  return Object.freeze({
    mint: text(position.mint),
    state: text(position.state),
    openedAtMs,
    closedAtMs,
    holdingMs: closedAtMs === null ? null : closedAtMs - openedAtMs,
    exitReason: exit?.reason ?? 'UNKNOWN',
    reExits: exit?.reExits ?? 0,
    netLamports: net === null ? null : net.toString(),
    pnlBps: net === null || entry === null ? null : pnlBps(net, entry),
    failedSellFeesLamports: BigInt(text(position.failed_sell_fees)).toString(),
  });
}

function exitOfKey(
  key: unknown,
  positionId: string,
): { readonly reason: ExitReason; readonly reExits: number } | null {
  if (typeof key !== 'string') return null;
  const reason = exitReasonOfLogicalKey(key);
  if (reason === null || !key.replace(RETRY_SUFFIX, '').endsWith(`:${positionId}`)) return null;
  return { reason, reExits: Number(RETRY_SUFFIX.exec(key)?.[1] ?? 0) };
}

function listenerRpc429(
  heartbeat: Record<string, unknown> | undefined,
): readonly FastPathListenerRpc429[] | null {
  if (heartbeat === undefined || heartbeat.evidence === null) return null;
  let evidence;
  try {
    evidence = createRuntimeRpcHttpEvidence(heartbeat.evidence);
  } catch {
    return null;
  }
  const sinceMs = nullableInteger(heartbeat.started_at_ms);
  return Object.freeze(evidence.providers
    .filter((provider) => provider.configured)
    .map((provider) => Object.freeze({
      providerId: provider.providerId,
      attempts: provider.attempts,
      http429Responses: provider.http429Responses,
      sinceMs,
    })));
}

function milliseconds(from: string, to: string): string {
  return `ROUND(EXTRACT(EPOCH FROM (${to} - ${from})) * 1000)::BIGINT`;
}

function epochMilliseconds(column: string): string {
  return `ROUND(EXTRACT(EPOCH FROM ${column}) * 1000)::BIGINT`;
}

function isoTimestamp(value: string): number {
  if (!ISO_TIMESTAMP.test(value)) throw invalidOptions();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw invalidOptions();
  return parsed;
}

function count(value: unknown): number {
  const parsed = integer(value);
  if (parsed < 0) throw new TypeError('Invalid fast-path report count.');
  return parsed;
}

function integer(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new TypeError('Invalid fast-path report integer.');
  }
  return parsed;
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value);
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid fast-path report text.');
  return value;
}

function iso(milliseconds_: number): string {
  return new Date(milliseconds_).toISOString();
}

function dash(value: number | string | null): number | string {
  return value ?? '-';
}

function row(cells: readonly (number | string)[], widths: readonly number[]): string {
  return cells.map((cell, index) => {
    const width = widths[index];
    return width === undefined ? String(cell) : String(cell).padEnd(width);
  }).join('').trimEnd();
}

function invalidOptions(): TypeError {
  return new TypeError('Fast-path report arguments are invalid. '
    + 'Usage: fast-path:report [--since=<ISO-8601>] [--until=<ISO-8601>] [--format=table|json]');
}

async function main(): Promise<void> {
  let options: FastPathReportOptions;
  try {
    options = parseFastPathReportArguments(process.argv.slice(2), Date.now());
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments.'}\n`);
    process.exitCode = 2;
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    process.stderr.write('{"event":"fast_path.report.failed","errorCode":"DATABASE_URL_MISSING"}\n');
    process.exitCode = 1;
    return;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const client = await pool.connect();
    let report: FastPathReport;
    try {
      report = await withReadOnlyTransaction(client, async (database) =>
        collectFastPathReport(database, options));
    } finally {
      client.release();
    }
    process.stdout.write(formatFastPathReport(report, options.format));
  } catch {
    process.stderr.write('{"event":"fast_path.report.failed","errorCode":"FAST_PATH_REPORT_FAILED"}\n');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  (await import('dotenv')).config({ quiet: true });
  await main();
}
