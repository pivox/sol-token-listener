import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseConfig } from '../src/config/env.js';
import {
  collectPaperDryRunSnapshot,
  parsePaperDryRunArguments,
  runPaperDryRun,
  type PaperDryRunQueryable,
} from '../src/cli/paper-dry-run.js';

void test('parses only bounded canonical dry-run arguments', () => {
  assert.deepEqual(parsePaperDryRunArguments([
    '--duration-seconds=5',
    '--max-sessions=1',
    '--report-file=reports/paper.json',
  ]), {
    durationMs: 5_000,
    maximumSessions: 1,
    reportFile: 'reports/paper.json',
  });
  assert.deepEqual(parsePaperDryRunArguments([
    '--duration-seconds=3600',
    '--max-sessions=1000',
    '--report-file=/tmp/paper.json',
  ]), {
    durationMs: 3_600_000,
    maximumSessions: 1000,
    reportFile: '/tmp/paper.json',
  });
});

void test('rejects unknown, duplicate, missing and non-canonical dry-run arguments', () => {
  for (const arguments_ of [
    [],
    ['--duration-seconds=5', '--max-sessions=1'],
    ['--duration-seconds=4', '--max-sessions=1', '--report-file=a.json'],
    ['--duration-seconds=3601', '--max-sessions=1', '--report-file=a.json'],
    ['--duration-seconds=05', '--max-sessions=1', '--report-file=a.json'],
    ['--duration-seconds=5', '--max-sessions=0', '--report-file=a.json'],
    ['--duration-seconds=5', '--max-sessions=1001', '--report-file=a.json'],
    ['--duration-seconds=5', '--max-sessions=1.5', '--report-file=a.json'],
    ['--duration-seconds=5', '--max-sessions=1', '--report-file=a.txt'],
    ['--duration-seconds=5', '--max-sessions=1', '--report-file= a.json'],
    ['--duration-seconds=5', '--max-sessions=1', '--report-file=a\nb.json'],
    ['--duration-seconds=5', '--max-sessions=1', '--report-file=a.json', '--live=true'],
    ['--duration-seconds=5', '--duration-seconds=6', '--max-sessions=1', '--report-file=a.json'],
  ]) assert.throws(() => parsePaperDryRunArguments(arguments_), TypeError);
});

void test('runs the real bounded lifecycle and writes one sanitized report', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-dry-run-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const reportFile = join(directory, 'report.json');
  const calls: string[] = [];
  const config = paperConfig();
  const report = await runPaperDryRun({
    durationMs: 5_000,
    maximumSessions: 10,
    reportFile,
  }, {
    config,
    now: sequenceClock(1_800_000_000_000, 1_800_000_006_000),
    wait: async (durationMs) => { calls.push(`wait:${durationMs}`); },
    runBootstrap: async (waitForStop) => {
      calls.push('bootstrap:start');
      assert.equal(await waitForStop(), 'SIGTERM');
      calls.push('bootstrap:closed');
    },
    readSnapshot: async (maximumSessions, startedAtMs) => {
      calls.push(`snapshot:${maximumSessions}:${startedAtMs}`);
      return {
        sessionCount: 2,
        stateCounts: {
          BUY_PENDING: 0, PAPER_HOLDING: 0, WAITING_EXTERNAL_BUYS: 1,
          EXIT_PENDING_QUOTE: 0, SELL_PENDING: 0, PAPER_CLOSED: 1,
          PAPER_RETRACTED: 0, MANUAL_REVIEW: 0,
        },
        quoteUnavailableCount: 1,
        openedPositionCount: 2,
        closedPositionCount: 1,
        pnlByQuote: [{ quoteMint: config.wsolMint, grossQuoteRaw: '25', netQuoteRaw: '20' }],
      };
    },
    writeReport: async (path, contents) => {
      calls.push('report:write');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
    },
  });

  assert.deepEqual(calls, [
    'bootstrap:start', 'wait:5000', 'snapshot:10:1800000000000',
    'bootstrap:closed', 'report:write',
  ]);
  assert.deepEqual(report, {
    schemaVersion: 'paper-dry-run.v1',
    startedAt: '2027-01-15T08:00:00.000Z',
    completedAt: '2027-01-15T08:00:06.000Z',
    configuredDurationMs: 5_000,
    maximumSessions: 10,
    technicalStatus: 'COMPLETED',
    coverage: 'CLOSED_POSITION_OBSERVED',
    sessionCount: 2,
    stateCounts: {
      BUY_PENDING: 0, PAPER_HOLDING: 0, WAITING_EXTERNAL_BUYS: 1,
      EXIT_PENDING_QUOTE: 0, SELL_PENDING: 0, PAPER_CLOSED: 1,
      PAPER_RETRACTED: 0, MANUAL_REVIEW: 0,
    },
    quoteUnavailableCount: 1,
    openedPositionCount: 2,
    closedPositionCount: 1,
    pnlByQuote: [{ quoteMint: config.wsolMint, grossQuoteRaw: '25', netQuoteRaw: '20' }],
  });
  const serialized = await readFile(reportFile, 'utf8');
  assert.equal(serialized, `${JSON.stringify(report, null, 2)}\n`);
  assert.doesNotMatch(serialized, /rpc|private|secret|transaction|social|signature/iu);
});

void test('treats no closed position as coverage rather than a technical failure', async () => {
  const writes: string[] = [];
  const report = await runPaperDryRun({
    durationMs: 5_000, maximumSessions: 1, reportFile: 'paper.json',
  }, {
    config: paperConfig(), now: sequenceClock(1_800_000_000_000, 1_800_000_005_000),
    wait: async () => undefined,
    runBootstrap: async (waitForStop) => { await waitForStop(); },
    readSnapshot: async () => ({
      sessionCount: 0,
      stateCounts: {
        BUY_PENDING: 0, PAPER_HOLDING: 0, WAITING_EXTERNAL_BUYS: 0,
        EXIT_PENDING_QUOTE: 0, SELL_PENDING: 0, PAPER_CLOSED: 0,
        PAPER_RETRACTED: 0, MANUAL_REVIEW: 0,
      },
      quoteUnavailableCount: 0, openedPositionCount: 0, closedPositionCount: 0,
      pnlByQuote: [],
    }),
    writeReport: async (_path, contents) => { writes.push(contents); },
  });
  assert.equal(report.technicalStatus, 'COMPLETED');
  assert.equal(report.coverage, 'NO_CLOSED_POSITION');
  assert.equal(writes.length, 1);
});

void test('keeps the maximum bounded bigint aggregate as a decimal string', async () => {
  const aggregate = `1${'0'.repeat(80)}`;
  const report = await runPaperDryRun({
    durationMs: 5_000, maximumSessions: 1_000, reportFile: 'paper.json',
  }, {
    config: paperConfig(), now: sequenceClock(1_800_000_000_000, 1_800_000_005_000),
    wait: async () => undefined,
    runBootstrap: async (waitForStop) => { await waitForStop(); },
    readSnapshot: async () => ({
      sessionCount: 1_000,
      stateCounts: {
        BUY_PENDING: 0, PAPER_HOLDING: 0, WAITING_EXTERNAL_BUYS: 0,
        EXIT_PENDING_QUOTE: 0, SELL_PENDING: 0, PAPER_CLOSED: 1_000,
        PAPER_RETRACTED: 0, MANUAL_REVIEW: 0,
      },
      quoteUnavailableCount: 0, openedPositionCount: 1_000, closedPositionCount: 1_000,
      pnlByQuote: [{ quoteMint: 'quote', grossQuoteRaw: aggregate, netQuoteRaw: `-${aggregate}` }],
    }),
    writeReport: async () => undefined,
  });
  assert.equal(report.pnlByQuote[0]?.grossQuoteRaw, aggregate);
  assert.equal(report.pnlByQuote[0]?.netQuoteRaw, `-${aggregate}`);
});

void test('refuses observe mode, disabled strategy, disabled listener and private keys', async () => {
  const valid = paperConfig();
  const execute = async (config: typeof valid): Promise<void> => runPaperDryRun({
    durationMs: 5_000, maximumSessions: 1, reportFile: 'paper.json',
  }, {
    config, now: () => new Date(1_800_000_000_000), wait: async () => undefined,
    runBootstrap: async () => { throw new Error('must not start'); },
    readSnapshot: async () => { throw new Error('must not read'); },
    writeReport: async () => { throw new Error('must not write'); },
  }).then(() => undefined);
  await assert.rejects(execute({ ...valid, executionMode: 'observe' }), TypeError);
  await assert.rejects(execute({ ...valid, paperStrategyEnabled: false }), TypeError);
  await assert.rejects(execute({ ...valid, listenerEnabled: false }), TypeError);
  assert.throws(() => parseConfig({
    SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid',
    SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid',
    SOLANA_PRIVATE_KEY_BASE58: 'must-never-be-accepted',
  }));
});

void test('collects at most the selected sessions and aggregates signed PnL by quote mint', async () => {
  const database: PaperDryRunQueryable = {
    async query(text, values) {
      assert.match(text, /LIMIT \$1/u);
      assert.match(text, /session\.updated_at >= \$2/u);
      assert.deepEqual(values, [10, new Date(1_800_000_000_000)]);
      return { rows: [
        row({ session_id: 'session-a', state: 'PAPER_CLOSED', reason_code: 'EXTERNAL_BUY_TARGET_REACHED',
          position_id: 'position-a', position_status: 'PAPER_CLOSED', quote_mint: 'quote-a',
          gross_pnl_quote_raw: '15', net_pnl_quote_raw: '10' }),
        row({ session_id: 'session-b', state: 'MANUAL_REVIEW', reason_code: 'RECONCILIATION_REQUIRED',
          error_code: 'QUOTE_UNAVAILABLE', position_id: 'position-b', position_status: 'PAPER_RETRACTED',
          quote_mint: 'quote-a', gross_pnl_quote_raw: '-5', net_pnl_quote_raw: '-7' }),
        row({ session_id: 'session-c', state: 'WAITING_EXTERNAL_BUYS', reason_code: 'QUALIFIED_ENTRY',
          position_id: 'position-c', position_status: 'PAPER_HOLDING', quote_mint: 'quote-b' }),
      ] };
    },
  };
  const snapshot = await collectPaperDryRunSnapshot(database, 10, 1_800_000_000_000);
  assert.equal(snapshot.sessionCount, 3);
  assert.equal(snapshot.stateCounts.PAPER_CLOSED, 1);
  assert.equal(snapshot.stateCounts.MANUAL_REVIEW, 1);
  assert.equal(snapshot.quoteUnavailableCount, 1);
  assert.equal(snapshot.openedPositionCount, 3);
  assert.equal(snapshot.closedPositionCount, 1);
  assert.deepEqual(snapshot.pnlByQuote, [
    { quoteMint: 'quote-a', grossQuoteRaw: '15', netQuoteRaw: '10' },
  ]);
});

void test('publishes the dry run as an explicit package command', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    readonly scripts?: Readonly<Record<string, unknown>>;
  };
  assert.equal(manifest.scripts?.['paper:dry-run'], 'tsx src/cli/paper-dry-run.ts');
});

function paperConfig() {
  return parseConfig({
    SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid',
    SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid',
    EXECUTION_MODE: 'paper', PAPER_STRATEGY_ENABLED: 'true',
    PAPER_ENTRY_QUOTE_AMOUNT_RAW: '1000000', PAPER_SLIPPAGE_BPS: '100',
    QUALIFICATION_PROFILE_PATH: 'config/qualification/pumpfun-v1-unvalidated.json',
    RISK_MAX_ROUNDTRIP_LOSS_BPS: '3000',
  });
}

function sequenceClock(...milliseconds: number[]): () => Date {
  let index = 0;
  return () => new Date(milliseconds[Math.min(index++, milliseconds.length - 1)] ?? 0);
}

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: 'session', state: 'BUY_PENDING', reason_code: 'QUALIFIED_ENTRY',
    error_code: null, position_id: null, position_status: null, quote_mint: null,
    gross_pnl_quote_raw: null, net_pnl_quote_raw: null,
    ...overrides,
  };
}
