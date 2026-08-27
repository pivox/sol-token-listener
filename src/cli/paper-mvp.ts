import { pathToFileURL } from 'node:url';
import type { PaperMvpCollectorResult } from '../application/paper-mvp-collector.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import { createPaperMvpReport, type PaperMvpReportV1 } from '../domain/paper-mvp.js';
import type { PaperMvpRepository, PaperMvpRun, PaperMvpRunSnapshot } from '../ports/paper-mvp-repository.js';
import type { ProviderUsageProbe } from '../ports/provider-usage-probe.js';
import { logger } from '../utils/logger.js';
import { productionRunnerDependencies } from './paper-mvp-runtime.js';

const MAXIMUM_PATH_BYTES = 4_096;
const MAXIMUM_DECIMAL_DIGITS = 78;
const INTERNAL_SHUTDOWN_SIGNAL: NodeJS.Signals = 'SIGTERM';

export interface PaperMvpCliOptions {
  readonly targetClosedPositions: number;
  readonly maxDurationMs: number;
  readonly pollMs: number;
  readonly initialCapitalRaw: bigint;
  readonly networkFeeRawPerTransaction: bigint;
  readonly reportFile: string;
}

export type PaperMvpStopReason = 'POLL' | 'SIGINT' | 'SIGTERM';

export interface PaperMvpStopController {
  wait(durationMs: number): Promise<PaperMvpStopReason>;
  close(): void;
}

export interface PaperMvpRunnerLease {
  readonly lost: Promise<void>;
  isLost(): boolean;
  release(): Promise<void>;
}

export interface PaperMvpCollectorPort {
  collect(input: Readonly<{ runId: string; limit: number }>): Promise<PaperMvpCollectorResult>;
}

export interface PaperMvpRunnerDependencies {
  readonly config: AppConfig;
  readonly now: () => number;
  readonly providerUsageProbe: ProviderUsageProbe;
  readonly runBootstrap: (
    runInsideBootstrap: (pool: unknown) => Promise<NodeJS.Signals>,
  ) => Promise<void>;
  readonly createRepository: (pool: unknown) => PaperMvpRepository;
  readonly createCollector: (
    repository: PaperMvpRepository,
    pool: unknown,
    providerUsageProbe: ProviderUsageProbe,
  ) => PaperMvpCollectorPort;
  readonly acquireRunner: (pool: unknown) => Promise<PaperMvpRunnerLease>;
  readonly createStopController: () => PaperMvpStopController;
  readonly writeReport: (path: string, contents: string) => Promise<void>;
}

export interface PaperMvpRunResult {
  readonly exitCode: 0 | 2;
  readonly report: PaperMvpReportV1 | null;
}

export type PaperMvpCliErrorCode =
  | 'SAFETY_GATE_FAILED' | 'ACTIVE_RUN_INCOMPATIBLE' | 'RUNNER_ALREADY_ACTIVE'
  | 'RUNNER_LOCK_LOST' | 'RUN_FAILED' | 'REPORT_EXPORT_FAILED' | 'DURABLE_REPORT_INVALID';

export class PaperMvpCliError extends Error {
  public constructor(public readonly code: PaperMvpCliErrorCode) {
    super('Paper MVP command failed.');
    this.name = 'PaperMvpCliError';
  }
}

export function parsePaperMvpArguments(arguments_: readonly string[]): PaperMvpCliOptions {
  const values = new Map<string, string>();
  for (const argument of arguments_) {
    const match = /^--(target-closed|max-duration-seconds|poll-seconds|initial-capital-raw|network-fee-raw-per-transaction|report-file)=(.*)$/u.exec(argument);
    if (match === null || values.has(match[1] ?? '')) throw invalidOptions();
    values.set(match[1] ?? '', match[2] ?? '');
  }
  if (values.size !== 6) throw invalidOptions();
  const targetClosedPositions = canonicalInteger(values.get('target-closed'), 1, 1_000);
  const maxDurationSeconds = canonicalInteger(values.get('max-duration-seconds'), 60, 14_400);
  const pollSeconds = canonicalInteger(values.get('poll-seconds'), 1, 60);
  const initialCapitalRaw = canonicalBigint(values.get('initial-capital-raw'), false);
  const networkFeeRawPerTransaction = canonicalBigint(
    values.get('network-fee-raw-per-transaction'), true,
  );
  const reportFile = values.get('report-file');
  if (
    reportFile === undefined || reportFile.length === 0 || reportFile !== reportFile.trim()
    || !reportFile.endsWith('.json') || /[\0\r\n]/u.test(reportFile)
    || Buffer.byteLength(reportFile, 'utf8') > MAXIMUM_PATH_BYTES
  ) throw invalidOptions();
  return Object.freeze({
    targetClosedPositions,
    maxDurationMs: maxDurationSeconds * 1_000,
    pollMs: pollSeconds * 1_000,
    initialCapitalRaw,
    networkFeeRawPerTransaction,
    reportFile,
  });
}

export async function runPaperMvp(
  options: PaperMvpCliOptions,
  dependencies: PaperMvpRunnerDependencies,
): Promise<PaperMvpRunResult> {
  assertOptions(options);
  assertPaperMvpSafety(dependencies.config);
  const results: PaperMvpRunResult[] = [];
  try {
    await dependencies.runBootstrap(async (pool) => {
      results.push(await runInsideBootstrap(options, dependencies, pool));
      return INTERNAL_SHUTDOWN_SIGNAL;
    });
  } catch (error: unknown) {
    if (error instanceof PaperMvpCliError) throw error;
    throw new PaperMvpCliError('RUN_FAILED');
  }
  if (results.length !== 1 || results[0] === undefined) {
    throw new PaperMvpCliError('RUN_FAILED');
  }
  return results[0];
}

async function runInsideBootstrap(
  options: PaperMvpCliOptions,
  dependencies: PaperMvpRunnerDependencies,
  pool: unknown,
): Promise<PaperMvpRunResult> {
  let runnerLease: PaperMvpRunnerLease | null = null;
  let stopController: PaperMvpStopController | null = null;
  let repository: PaperMvpRepository | null = null;
  let run: PaperMvpRun | null = null;
  let terminal = false;
  let result: PaperMvpRunResult | null = null;
  let cleanupFailed = false;
  let failureCode: PaperMvpCliErrorCode = 'RUN_FAILED';
  let durableFailureCode = 'RUNNER_OPERATION_FAILED';
  try {
    runnerLease = await dependencies.acquireRunner(pool);
    stopController = dependencies.createStopController();
    repository = dependencies.createRepository(pool);
    const collector = dependencies.createCollector(
      repository, pool, dependencies.providerUsageProbe,
    );
    const configuration = Object.freeze({
      strategyId: 'creation-entry-v1',
      strategyVersion: 1,
      quoteMint: dependencies.config.wsolMint,
      targetClosedPositions: options.targetClosedPositions,
      initialCapitalRaw: options.initialCapitalRaw,
      networkFeeRawPerTransaction: options.networkFeeRawPerTransaction,
      maxDurationMs: options.maxDurationMs,
      providerIdentity: dependencies.providerUsageProbe.identity,
    });
    try {
      run = await repository.startOrResume(configuration, validNow(dependencies.now()));
    } catch (error: unknown) {
      if (hasCode(error, 'ACTIVE_RUN_INCOMPATIBLE')) {
        failureCode = 'ACTIVE_RUN_INCOMPATIBLE';
      }
      throw error;
    }

    while (result === null) {
      const before = await requiredRunningSnapshot(repository, run.runId);
      const beforeNow = validNow(dependencies.now());
      const beforeStop = await waitForStop(stopController, runnerLease, 0);
      if (beforeStop === 'RUNNER_LOCK_LOST') throw new PaperMvpCliError(beforeStop);
      if (beforeStop !== 'POLL') {
        await collectRemaining(collector, before, options.targetClosedPositions);
        ({ result, terminal } = await finishBoundedStop(
          beforeStop, repository, run.runId, dependencies, options,
        ));
        continue;
      }
      if (before.run.closedPositions >= options.targetClosedPositions
        && beforeNow < before.run.deadlineAtMs) {
        result = await completeAndExport(before, beforeNow, repository, options, dependencies);
        terminal = true;
        continue;
      }
      if (beforeNow >= before.run.deadlineAtMs) {
        await collectRemaining(collector, before, options.targetClosedPositions);
        ({ result, terminal } = await finishBoundedStop(
          'TIMEOUT', repository, run.runId, dependencies, options,
        ));
        continue;
      }

      await collectRemaining(collector, before, options.targetClosedPositions);
      const after = await requiredRunningSnapshot(repository, run.runId);
      const afterNow = validNow(dependencies.now());
      const afterStop = await waitForStop(stopController, runnerLease, 0);
      if (afterStop === 'RUNNER_LOCK_LOST') throw new PaperMvpCliError(afterStop);
      if (afterStop !== 'POLL') {
        await collectRemaining(collector, after, options.targetClosedPositions);
        ({ result, terminal } = await finishBoundedStop(
          afterStop, repository, run.runId, dependencies, options,
        ));
        continue;
      }
      if (afterNow >= after.run.deadlineAtMs) {
        await collectRemaining(collector, after, options.targetClosedPositions);
        ({ result, terminal } = await finishBoundedStop(
          'TIMEOUT', repository, run.runId, dependencies, options,
        ));
        continue;
      }
      if (after.run.closedPositions >= options.targetClosedPositions) {
        result = await completeAndExport(after, afterNow, repository, options, dependencies);
        terminal = true;
        continue;
      }
      const waitMs = Math.min(options.pollMs, after.run.deadlineAtMs - afterNow);
      const stop = await waitForStop(stopController, runnerLease, waitMs);
      if (stop === 'RUNNER_LOCK_LOST') throw new PaperMvpCliError(stop);
      if (stop === 'POLL') continue;
      const interrupted = await requiredRunningSnapshot(repository, run.runId);
      await collectRemaining(collector, interrupted, options.targetClosedPositions);
      ({ result, terminal } = await finishBoundedStop(
        stop, repository, run.runId, dependencies, options,
      ));
    }
  } catch (error: unknown) {
    if (error instanceof PaperMvpCliError && error.code === 'RUNNER_LOCK_LOST') {
      failureCode = 'RUNNER_LOCK_LOST';
      durableFailureCode = 'RUNNER_LOCK_LOST';
    }
    if (repository !== null && run !== null && !terminal) {
      try {
        const snapshot = await repository.load(run.runId);
        if (snapshot?.run.state === 'RUNNING') {
          await repository.terminalize({
            runId: run.runId,
            terminalAtMs: Math.max(validNow(dependencies.now()), snapshot.run.updatedAtMs),
            state: 'FAILED', report: null, failureCode: durableFailureCode,
          });
        }
      } catch { /* retain the stable outer failure */ }
    }
    if (error instanceof PaperMvpCliError) throw error;
    throw new PaperMvpCliError(failureCode);
  } finally {
    stopController?.close();
    if (runnerLease !== null) {
      try { await runnerLease.release(); } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed) throw new PaperMvpCliError('RUN_FAILED');
  return result;
}

async function waitForStop(
  controller: PaperMvpStopController,
  lease: PaperMvpRunnerLease,
  durationMs: number,
): Promise<PaperMvpStopReason | 'RUNNER_LOCK_LOST'> {
  if (lease.isLost()) return 'RUNNER_LOCK_LOST';
  return Promise.race([
    controller.wait(durationMs),
    lease.lost.then(() => 'RUNNER_LOCK_LOST' as const),
  ]);
}

async function collectRemaining(
  collector: PaperMvpCollectorPort,
  snapshot: PaperMvpRunSnapshot,
  targetClosedPositions: number,
): Promise<void> {
  const remaining = targetClosedPositions - snapshot.run.closedPositions;
  if (remaining <= 0) return;
  await collector.collect({ runId: snapshot.run.runId, limit: remaining });
}

async function finishBoundedStop(
  reason: 'TIMEOUT' | 'SIGINT' | 'SIGTERM',
  repository: PaperMvpRepository,
  runId: string,
  dependencies: PaperMvpRunnerDependencies,
  options: PaperMvpCliOptions,
): Promise<Readonly<{ result: PaperMvpRunResult; terminal: true }>> {
  const snapshot = await requiredRunningSnapshot(repository, runId);
  const terminalAtMs = Math.max(validNow(dependencies.now()), snapshot.run.updatedAtMs);
  const report = reportFromSnapshot(snapshot, terminalAtMs);
  if (report.verdict === 'PASS') {
    await repository.terminalize({
      runId, terminalAtMs, state: 'FAILED', report: null,
      failureCode: reason === 'TIMEOUT'
        ? 'RUN_TIMEOUT_AFTER_TARGET' : `RUN_INTERRUPTED_${reason}`,
    });
    return Object.freeze({ result: Object.freeze({ exitCode: 2, report: null }), terminal: true });
  }
  const result = await completeAndExport(snapshot, terminalAtMs, repository, options, dependencies);
  return Object.freeze({ result, terminal: true });
}

async function completeAndExport(
  snapshot: PaperMvpRunSnapshot,
  terminalAtMs: number,
  repository: PaperMvpRepository,
  options: PaperMvpCliOptions,
  dependencies: PaperMvpRunnerDependencies,
): Promise<PaperMvpRunResult> {
  const canonicalTerminalAtMs = Math.max(terminalAtMs, snapshot.run.updatedAtMs);
  const candidate = reportFromSnapshot(snapshot, canonicalTerminalAtMs);
  await repository.terminalize({
    runId: snapshot.run.runId, terminalAtMs: canonicalTerminalAtMs,
    state: 'COMPLETED', report: candidate, failureCode: null,
  });
  const durable = await repository.load(snapshot.run.runId);
  if (
    durable?.run.state !== 'COMPLETED'
    || durable.run.terminalAtMs === null
    || durable.run.verdict !== candidate.verdict
  ) throw new PaperMvpCliError('DURABLE_REPORT_INVALID');
  const report = reportFromSnapshot(durable, durable.run.terminalAtMs);
  if (JSON.stringify(report) !== JSON.stringify(candidate)) {
    throw new PaperMvpCliError('DURABLE_REPORT_INVALID');
  }
  try {
    await dependencies.writeReport(options.reportFile, `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    throw new PaperMvpCliError('REPORT_EXPORT_FAILED');
  }
  return Object.freeze({ exitCode: report.verdict === 'PASS' ? 0 : 2, report });
}

function reportFromSnapshot(snapshot: PaperMvpRunSnapshot, completedAtMs: number): PaperMvpReportV1 {
  return createPaperMvpReport({
    runId: snapshot.run.runId,
    startedAtMs: snapshot.run.startedAtMs,
    completedAtMs,
    targetClosedPositions: snapshot.run.configuration.targetClosedPositions,
    initialCapitalRaw: snapshot.run.configuration.initialCapitalRaw,
    quoteMint: snapshot.run.configuration.quoteMint,
    creationsObserved: snapshot.run.counters.creationsObserved,
    entriesRejected: snapshot.run.counters.entriesRejected,
    samples: snapshot.samples,
    unknownTerminalPositions: snapshot.unknownPositions.length,
    duplicateLogicalBuys: snapshot.run.counters.duplicateLogicalBuys,
    duplicateLogicalSells: snapshot.run.counters.duplicateLogicalSells,
    providerUsage: snapshot.run.providerUsage,
  });
}

async function requiredRunningSnapshot(
  repository: PaperMvpRepository,
  runId: string,
): Promise<PaperMvpRunSnapshot> {
  const snapshot = await repository.load(runId);
  if (snapshot?.run.state !== 'RUNNING') throw new PaperMvpCliError('DURABLE_REPORT_INVALID');
  return snapshot;
}

export function assertPaperMvpSafety(config: AppConfig): void {
  if (
    config.cluster !== 'mainnet-beta'
    || config.executionMode !== 'paper'
    || !config.listenerEnabled
    || !config.creationStrategyEnabled
    || !config.paperStrategyEnabled
    || config.paperStrategyId !== 'creation-entry-v1'
    || config.paperQuoteMintAllowlist.length !== 1
    || config.paperQuoteMintAllowlist[0] !== config.wsolMint
  ) throw new PaperMvpCliError('SAFETY_GATE_FAILED');
}

function assertOptions(options: PaperMvpCliOptions): void {
  canonicalInteger(String(options.targetClosedPositions), 1, 1_000);
  canonicalInteger(String(options.maxDurationMs / 1_000), 60, 14_400);
  canonicalInteger(String(options.pollMs / 1_000), 1, 60);
  canonicalBigint(options.initialCapitalRaw.toString(), false);
  canonicalBigint(options.networkFeeRawPerTransaction.toString(), true);
  if (
    options.reportFile.length === 0 || options.reportFile !== options.reportFile.trim()
    || !options.reportFile.endsWith('.json') || /[\0\r\n]/u.test(options.reportFile)
    || Buffer.byteLength(options.reportFile, 'utf8') > MAXIMUM_PATH_BYTES
  ) throw invalidOptions();
}

function validNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new PaperMvpCliError('RUN_FAILED');
  }
  return value;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function canonicalInteger(value: string | undefined, minimum: number, maximum: number): number {
  if (value === undefined || !/^(?:0|[1-9]\d*)$/u.test(value)) throw invalidOptions();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidOptions();
  }
  return parsed;
}

function canonicalBigint(value: string | undefined, allowZero: boolean): bigint {
  if (
    value === undefined || !new RegExp(`^(?:0|[1-9]\\d{0,${MAXIMUM_DECIMAL_DIGITS - 1}})$`, 'u').test(value)
  ) throw invalidOptions();
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) throw invalidOptions();
  return parsed;
}

function invalidOptions(): TypeError {
  return new TypeError('Paper MVP command options are invalid.');
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<0 | 2> {
  const options = parsePaperMvpArguments(arguments_);
  const config = loadConfig();
  const result = await runPaperMvp(options, productionRunnerDependencies(config));
  return result.exitCode;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    process.exitCode = 1;
    logger.fatal({ event: 'paper_mvp.failed', errorCode: safeCliErrorCode(error) },
      'Paper MVP command failed.');
  });
}

function safeCliErrorCode(error: unknown): string {
  return error instanceof PaperMvpCliError ? error.code : 'UNEXPECTED_FAILURE';
}
