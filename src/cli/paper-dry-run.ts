import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runApplication } from '../app.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import {
  PAPER_DECISION_REASON_CODES,
  PAPER_STRATEGY_SESSION_STATES,
  type PaperStrategySessionState,
} from '../domain/paper-strategy.js';
import { getDatabasePool } from '../storage/database.js';

const MINIMUM_DURATION_SECONDS = 5;
const MAXIMUM_DURATION_SECONDS = 3_600;
const MINIMUM_SESSIONS = 1;
const MAXIMUM_SESSIONS = 1_000;
const MAXIMUM_PATH_BYTES = 4_096;
const DATABASE_DECIMAL_DIGITS = 78;
const AGGREGATE_DECIMAL_DIGITS = 81;
const POSITION_STATES = ['PAPER_HOLDING', 'PAPER_CLOSED', 'PAPER_RETRACTED'] as const;

export interface PaperDryRunOptions {
  readonly durationMs: number;
  readonly maximumSessions: number;
  readonly reportFile: string;
}

export interface PaperDryRunPnl {
  readonly quoteMint: string;
  readonly grossQuoteRaw: string;
  readonly netQuoteRaw: string;
}

export interface PaperDryRunSnapshot {
  readonly sessionCount: number;
  readonly stateCounts: Readonly<Record<PaperStrategySessionState, number>>;
  readonly quoteUnavailableCount: number;
  readonly openedPositionCount: number;
  readonly closedPositionCount: number;
  readonly pnlByQuote: readonly PaperDryRunPnl[];
}

export interface PaperDryRunReport extends PaperDryRunSnapshot {
  readonly schemaVersion: 'paper-dry-run.v1';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly configuredDurationMs: number;
  readonly maximumSessions: number;
  readonly technicalStatus: 'COMPLETED';
  readonly coverage: 'CLOSED_POSITION_OBSERVED' | 'NO_CLOSED_POSITION';
}

export interface PaperDryRunQueryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

export interface PaperDryRunDependencies {
  readonly config: AppConfig;
  readonly now: () => Date;
  readonly wait: (durationMs: number) => Promise<void>;
  readonly runBootstrap: (
    waitForStop: () => Promise<NodeJS.Signals>,
  ) => Promise<void>;
  readonly readSnapshot: (
    maximumSessions: number,
    startedAtMs: number,
  ) => Promise<PaperDryRunSnapshot>;
  readonly writeReport: (path: string, contents: string) => Promise<void>;
}

export class PaperDryRunDataError extends Error {
  public constructor(cause?: unknown) {
    super('Stored paper dry-run data is invalid.');
    this.name = 'PaperDryRunDataError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
  }
}

export function parsePaperDryRunArguments(arguments_: readonly string[]): PaperDryRunOptions {
  const values = new Map<string, string>();
  for (const argument of arguments_) {
    const match = /^--(duration-seconds|max-sessions|report-file)=(.*)$/u.exec(argument);
    if (match === null || values.has(match[1] ?? '')) throw invalidOptions();
    values.set(match[1] ?? '', match[2] ?? '');
  }
  if (values.size !== 3) throw invalidOptions();
  const durationSeconds = canonicalInteger(
    values.get('duration-seconds'),
    MINIMUM_DURATION_SECONDS,
    MAXIMUM_DURATION_SECONDS,
  );
  const maximumSessions = canonicalInteger(
    values.get('max-sessions'),
    MINIMUM_SESSIONS,
    MAXIMUM_SESSIONS,
  );
  const reportFile = values.get('report-file');
  if (
    reportFile === undefined
    || reportFile.length === 0
    || reportFile !== reportFile.trim()
    || !reportFile.endsWith('.json')
    || reportFile.includes('\0')
    || Buffer.byteLength(reportFile, 'utf8') > MAXIMUM_PATH_BYTES
  ) throw invalidOptions();
  return Object.freeze({
    durationMs: durationSeconds * 1_000,
    maximumSessions,
    reportFile,
  });
}

export async function runPaperDryRun(
  options: PaperDryRunOptions,
  dependencies: PaperDryRunDependencies,
): Promise<PaperDryRunReport> {
  assertOptions(options);
  assertPaperConfig(dependencies.config);
  const startedAt = validDate(dependencies.now());
  const snapshots: PaperDryRunSnapshot[] = [];
  await dependencies.runBootstrap(async () => {
    await dependencies.wait(options.durationMs);
    snapshots.push(await dependencies.readSnapshot(options.maximumSessions, startedAt.getTime()));
    return 'SIGTERM';
  });
  const snapshot = snapshots[0];
  if (snapshot === undefined || snapshots.length !== 1) throw new PaperDryRunDataError();
  const validatedSnapshot = validateSnapshot(snapshot, options.maximumSessions);
  const completedAt = validDate(dependencies.now());
  if (completedAt.getTime() < startedAt.getTime()) throw new PaperDryRunDataError();
  const report: PaperDryRunReport = Object.freeze({
    schemaVersion: 'paper-dry-run.v1',
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    configuredDurationMs: options.durationMs,
    maximumSessions: options.maximumSessions,
    technicalStatus: 'COMPLETED',
    coverage: validatedSnapshot.closedPositionCount > 0
      ? 'CLOSED_POSITION_OBSERVED'
      : 'NO_CLOSED_POSITION',
    ...validatedSnapshot,
  });
  await dependencies.writeReport(options.reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function collectPaperDryRunSnapshot(
  database: PaperDryRunQueryable,
  maximumSessions: number,
  startedAtMs: number,
): Promise<PaperDryRunSnapshot> {
  if (!Number.isSafeInteger(maximumSessions)
    || maximumSessions < MINIMUM_SESSIONS
    || maximumSessions > MAXIMUM_SESSIONS
    || !Number.isSafeInteger(startedAtMs)
    || startedAtMs < 0) throw new PaperDryRunDataError();
  try {
    const result = await database.query(
      `WITH selected_sessions AS MATERIALIZED (
         SELECT session.session_id,session.state,session.reason_code,
           session.payload #>> '{lastError,code}' AS error_code
         FROM paper_strategy_sessions AS session
         WHERE session.updated_at >= $2
         ORDER BY session.updated_at DESC,session.session_id DESC
         LIMIT $1
       )
       SELECT session.session_id,session.state,session.reason_code,session.error_code,
         position.position_id,position.status AS position_status,
         position.quote_mint,position.gross_pnl_quote_raw::text,
         position.net_pnl_quote_raw::text
       FROM selected_sessions AS session
       LEFT JOIN paper_positions AS position
         ON position.strategy_session_id=session.session_id
       ORDER BY session.session_id ASC`,
      [maximumSessions, new Date(startedAtMs)],
    );
    if (result.rows.length > maximumSessions) throw new TypeError('Too many paper dry-run rows.');
    return snapshotFromRows(result.rows, maximumSessions);
  } catch (error: unknown) {
    throw error instanceof PaperDryRunDataError ? error : new PaperDryRunDataError(error);
  }
}

function snapshotFromRows(
  rows: readonly Record<string, unknown>[],
  maximumSessions: number,
): PaperDryRunSnapshot {
  const stateCounts = emptyStateCounts();
  const sessionIds = new Set<string>();
  const pnl = new Map<string, { gross: bigint; net: bigint }>();
  let quoteUnavailableCount = 0;
  let openedPositionCount = 0;
  let closedPositionCount = 0;
  for (const row of rows) {
    const sessionId = boundedText(row.session_id);
    if (sessionIds.has(sessionId)) throw new TypeError('Duplicate paper dry-run session.');
    sessionIds.add(sessionId);
    const state = enumValue(row.state, PAPER_STRATEGY_SESSION_STATES);
    stateCounts[state] += 1;
    const reason = enumValue(row.reason_code, PAPER_DECISION_REASON_CODES);
    const errorCode = nullableErrorCode(row.error_code);
    if (reason === 'EXIT_QUOTE_UNAVAILABLE' || isQuoteUnavailable(errorCode)) {
      quoteUnavailableCount += 1;
    }
    const positionId = nullableText(row.position_id);
    if (positionId === null) {
      if (row.position_status !== null || row.quote_mint !== null
        || row.gross_pnl_quote_raw !== null || row.net_pnl_quote_raw !== null) {
        throw new TypeError('Incomplete paper dry-run position.');
      }
      continue;
    }
    openedPositionCount += 1;
    const positionStatus = enumValue(row.position_status, POSITION_STATES);
    const quoteMint = boundedText(row.quote_mint);
    const gross = nullableSignedDecimal(row.gross_pnl_quote_raw);
    const net = nullableSignedDecimal(row.net_pnl_quote_raw);
    if ((gross === null) !== (net === null)
      || (positionStatus === 'PAPER_CLOSED' && gross === null)
      || (positionStatus === 'PAPER_HOLDING' && gross !== null)) {
      throw new TypeError('Incoherent paper dry-run PnL.');
    }
    if (positionStatus === 'PAPER_CLOSED') closedPositionCount += 1;
    if (positionStatus === 'PAPER_CLOSED' && gross !== null && net !== null) {
      const aggregate = pnl.get(quoteMint) ?? { gross: 0n, net: 0n };
      aggregate.gross += BigInt(gross);
      aggregate.net += BigInt(net);
      pnl.set(quoteMint, aggregate);
    }
  }
  return validateSnapshot(Object.freeze({
    sessionCount: sessionIds.size,
    stateCounts: Object.freeze(stateCounts),
    quoteUnavailableCount,
    openedPositionCount,
    closedPositionCount,
    pnlByQuote: Object.freeze([...pnl.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([quoteMint, value]) => Object.freeze({
        quoteMint,
        grossQuoteRaw: value.gross.toString(),
        netQuoteRaw: value.net.toString(),
      }))),
  }), maximumSessions);
}

function validateSnapshot(
  value: PaperDryRunSnapshot,
  maximumSessions: number,
): PaperDryRunSnapshot {
  nonNegativeCount(value.sessionCount, maximumSessions);
  let totalStates = 0;
  const states = emptyStateCounts();
  for (const state of PAPER_STRATEGY_SESSION_STATES) {
    const count = value.stateCounts[state];
    nonNegativeCount(count, maximumSessions);
    states[state] = count;
    totalStates += count;
  }
  if (totalStates !== value.sessionCount) throw new PaperDryRunDataError();
  nonNegativeCount(value.quoteUnavailableCount, value.sessionCount);
  nonNegativeCount(value.openedPositionCount, value.sessionCount);
  nonNegativeCount(value.closedPositionCount, value.openedPositionCount);
  const quoteMints = new Set<string>();
  const rawPnl = arrayValue(value.pnlByQuote);
  if (rawPnl.length > value.closedPositionCount) {
    throw new PaperDryRunDataError();
  }
  const pnlByQuote = rawPnl.map((item) => {
    const record = recordValue(item);
    const quoteMint = boundedText(record.quoteMint);
    if (quoteMints.has(quoteMint)) throw new PaperDryRunDataError();
    quoteMints.add(quoteMint);
    return Object.freeze({
      quoteMint,
      grossQuoteRaw: signedDecimal(record.grossQuoteRaw, AGGREGATE_DECIMAL_DIGITS),
      netQuoteRaw: signedDecimal(record.netQuoteRaw, AGGREGATE_DECIMAL_DIGITS),
    });
  });
  pnlByQuote.sort((left, right) => left.quoteMint.localeCompare(right.quoteMint));
  return Object.freeze({
    sessionCount: value.sessionCount,
    stateCounts: Object.freeze(states),
    quoteUnavailableCount: value.quoteUnavailableCount,
    openedPositionCount: value.openedPositionCount,
    closedPositionCount: value.closedPositionCount,
    pnlByQuote: Object.freeze(pnlByQuote),
  });
}

function assertPaperConfig(config: AppConfig): void {
  if (config.executionMode !== 'paper' || !config.paperStrategyEnabled || !config.listenerEnabled) {
    throw new TypeError('Paper dry run requires the enabled paper listener.');
  }
}

function assertOptions(options: PaperDryRunOptions): void {
  if (!Number.isSafeInteger(options.durationMs)
    || options.durationMs < MINIMUM_DURATION_SECONDS * 1_000
    || options.durationMs > MAXIMUM_DURATION_SECONDS * 1_000
    || options.durationMs % 1_000 !== 0
    || !Number.isSafeInteger(options.maximumSessions)
    || options.maximumSessions < MINIMUM_SESSIONS
    || options.maximumSessions > MAXIMUM_SESSIONS
    || options.reportFile.length === 0
    || options.reportFile !== options.reportFile.trim()
    || !options.reportFile.endsWith('.json')
    || options.reportFile.includes('\0')
    || Buffer.byteLength(options.reportFile, 'utf8') > MAXIMUM_PATH_BYTES) throw invalidOptions();
}

function canonicalInteger(raw: string | undefined, minimum: number, maximum: number): number {
  if (raw === undefined || !/^(?:0|[1-9]\d*)$/u.test(raw)) throw invalidOptions();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidOptions();
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new PaperDryRunDataError();
  return new Date(value.getTime());
}

function emptyStateCounts(): Record<PaperStrategySessionState, number> {
  return {
    BUY_PENDING: 0,
    PAPER_HOLDING: 0,
    WAITING_EXTERNAL_BUYS: 0,
    EXIT_PENDING_QUOTE: 0,
    SELL_PENDING: 0,
    PAPER_CLOSED: 0,
    PAPER_RETRACTED: 0,
    MANUAL_REVIEW: 0,
  };
}

function enumValue<const Value extends string>(value: unknown, allowed: readonly Value[]): Value {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    throw new TypeError('Stored paper dry-run enum is invalid.');
  }
  return value as Value;
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > 512) throw new TypeError('Stored paper dry-run text is invalid.');
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : boundedText(value);
}

function nullableErrorCode(value: unknown): string | null {
  if (value === null) return null;
  const code = boundedText(value);
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(code)) throw new TypeError('Stored paper error code is invalid.');
  return code;
}

function isQuoteUnavailable(code: string | null): boolean {
  return code !== null && (code.includes('QUOTE') || code.startsWith('VENUE_'));
}

function nullableSignedDecimal(value: unknown): string | null {
  return value === null ? null : signedDecimal(value, DATABASE_DECIMAL_DIGITS);
}

function signedDecimal(value: unknown, maximumMagnitudeDigits: number): string {
  if (typeof value !== 'string' || !/^(?:0|-?[1-9]\d*)$/u.test(value)
    || value.replace(/^-/, '').length > maximumMagnitudeDigits) {
    throw new TypeError('Stored paper dry-run decimal is invalid.');
  }
  return value;
}

function nonNegativeCount(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new PaperDryRunDataError();
}

function arrayValue(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new PaperDryRunDataError();
  return value.map((item: unknown) => item);
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PaperDryRunDataError();
  }
  return value as Record<string, unknown>;
}

function invalidOptions(): TypeError {
  return new TypeError('Paper dry-run arguments are invalid.');
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function main(): Promise<void> {
  try {
    const options = parsePaperDryRunArguments(process.argv.slice(2));
    const config = loadConfig();
    await runPaperDryRun(options, {
      config,
      now: () => new Date(),
      wait: delay,
      runBootstrap: async (waitForStop) => runApplication({
        loadConfig: () => config,
        waitForShutdownSignal: waitForStop,
      }),
      readSnapshot: async (maximumSessions, startedAtMs) => collectPaperDryRunSnapshot(
        getDatabasePool(config.databaseUrl),
        maximumSessions,
        startedAtMs,
      ),
      writeReport: async (path, contents) => writeFile(path, contents, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }),
    });
  } catch {
    process.stderr.write('{"event":"paper.dry_run.failed","errorCode":"PAPER_DRY_RUN_FAILED"}\n');
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}
