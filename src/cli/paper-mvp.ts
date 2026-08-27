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
  readonly firstSignal?: Promise<Exclude<PaperMvpStopReason, 'POLL'>>;
  readonly forced?: Promise<void>;
  close(): void;
}

export interface PaperMvpRunnerLease {
  readonly ownerId: string;
  readonly lost: Promise<void>;
  isLost(): boolean;
  release(): Promise<void>;
}

export interface PaperMvpCollectorPort {
  collect(input: Readonly<{
    runId: string;
    runnerOwnerId: string;
    limit: number;
    signal?: AbortSignal;
  }>): Promise<PaperMvpCollectorResult>;
}

export interface PaperMvpRunnerDependencies {
  readonly config: AppConfig;
  readonly now: () => number;
  readonly providerUsageProbe: ProviderUsageProbe;
  readonly finalCollectionGraceMs: number;
  readonly runBootstrap: (
    prepareAfterMigrations: (pool: unknown) => Promise<void>,
    runInsideBootstrap: (pool: unknown) => Promise<NodeJS.Signals>,
    cleanupBeforeLeaseRelease: () => Promise<void>,
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
  let prepared: PreparedPaperMvpRun | null = null;
  try {
    await dependencies.runBootstrap(
      async (pool) => { prepared = await preparePaperMvpRun(options, dependencies, pool); },
      async (pool) => {
        if (prepared === null || prepared.pool !== pool) throw new PaperMvpCliError('RUN_FAILED');
        results.push(await runInsideBootstrap(options, dependencies, prepared));
        return INTERNAL_SHUTDOWN_SIGNAL;
      },
      async () => {
        if (prepared !== null) await cleanupPreparedRun(prepared, dependencies);
      },
    );
  } catch (error: unknown) {
    if (error instanceof PaperMvpCliError) throw error;
    throw new PaperMvpCliError('RUN_FAILED');
  }
  if (results.length !== 1 || results[0] === undefined) {
    throw new PaperMvpCliError('RUN_FAILED');
  }
  return results[0];
}

interface PreparedPaperMvpRun {
  readonly pool: unknown;
  readonly runnerLease: PaperMvpRunnerLease;
  readonly stopController: PaperMvpStopController;
  readonly repository: PaperMvpRepository;
  readonly collector: PaperMvpCollectorPort;
  readonly run: PaperMvpRun;
  terminal: boolean;
  cleaned: boolean;
}

async function preparePaperMvpRun(
  options: PaperMvpCliOptions,
  dependencies: PaperMvpRunnerDependencies,
  pool: unknown,
): Promise<PreparedPaperMvpRun> {
  let runnerLease: PaperMvpRunnerLease | null = null;
  let stopController: PaperMvpStopController | null = null;
  try {
    runnerLease = await dependencies.acquireRunner(pool);
    assertRunnerOwnership(runnerLease);
    stopController = dependencies.createStopController();
    const repository = dependencies.createRepository(pool);
    const collector = dependencies.createCollector(repository, pool, dependencies.providerUsageProbe);
    const configuration = Object.freeze({
      strategyId: 'creation-entry-v1', strategyVersion: 1,
      quoteMint: dependencies.config.wsolMint,
      targetClosedPositions: options.targetClosedPositions,
      initialCapitalRaw: options.initialCapitalRaw,
      networkFeeRawPerTransaction: options.networkFeeRawPerTransaction,
      maxDurationMs: options.maxDurationMs,
      externalUniqueBuyersTarget: dependencies.config.paperExternalBuyTarget,
      takeProfitMultiplierBps: dependencies.config.creationTakeProfitMultiplierBps,
      providerIdentity: dependencies.providerUsageProbe.identity,
    });
    const run = await repository.startOrResume(
      configuration, runnerLease.ownerId, validNow(dependencies.now()),
    );
    assertRunnerOwnership(runnerLease);
    return { pool,runnerLease,stopController,repository,collector,run,terminal:false,cleaned:false };
  } catch (error: unknown) {
    stopController?.close();
    try { await runnerLease?.release(); } catch { /* retain the primary preparation failure */ }
    if (hasCode(error, 'ACTIVE_RUN_INCOMPATIBLE')) {
      throw new PaperMvpCliError('ACTIVE_RUN_INCOMPATIBLE');
    }
    if (error instanceof PaperMvpCliError) throw error;
    throw new PaperMvpCliError('RUN_FAILED');
  }
}

async function runInsideBootstrap(
  options: PaperMvpCliOptions,
  dependencies: PaperMvpRunnerDependencies,
  prepared: PreparedPaperMvpRun,
): Promise<PaperMvpRunResult> {
  const { runnerLease,stopController,repository,collector,run } = prepared;
  let result: PaperMvpRunResult | null = null;
  let failureCode: PaperMvpCliErrorCode = 'RUN_FAILED';
  const durableFailureCode = 'RUNNER_OPERATION_FAILED';
  try {
    while (result === null) {
      const before = await requiredRunningSnapshot(repository, run.runId);
      const beforeNow = validNow(dependencies.now());
      const beforeStop = await waitForStop(stopController, runnerLease, 0);
      if (beforeStop === 'RUNNER_LOCK_LOST') throw new PaperMvpCliError(beforeStop);
      if (beforeStop !== 'POLL') {
        await collectFinal(collector,before,options.targetClosedPositions,runnerLease,stopController,
          dependencies.finalCollectionGraceMs);
        ({ result } = await finishBoundedStop(
          beforeStop, repository, run.runId, dependencies, options, runnerLease,
        ));
        continue;
      }
      if (before.run.closedPositions >= options.targetClosedPositions
        && beforeNow < before.run.deadlineAtMs) {
        result = await completeAndExport(
          before, beforeNow, 'TARGET_REACHED', repository, options, dependencies, runnerLease,
        );
        prepared.terminal = true;
        continue;
      }
      if (beforeNow >= before.run.deadlineAtMs) {
        await collectFinal(collector,before,options.targetClosedPositions,runnerLease,stopController,
          dependencies.finalCollectionGraceMs);
        ({ result } = await finishBoundedStop(
          'TIMEOUT', repository, run.runId, dependencies, options, runnerLease,
        ));
        continue;
      }

      const collectionStop = await collectRemaining(
        collector,before,options.targetClosedPositions,runnerLease,stopController,
        before.run.deadlineAtMs - beforeNow,true,
      );
      if (collectionStop !== null) {
        if (collectionStop === 'RUNNER_LOCK_LOST') throw new PaperMvpCliError(collectionStop);
        await collectFinal(collector,before,options.targetClosedPositions,runnerLease,stopController,
          dependencies.finalCollectionGraceMs);
        ({ result } = await finishBoundedStop(
          collectionStop, repository, run.runId, dependencies, options, runnerLease,
        ));
        continue;
      }
      const after = await requiredRunningSnapshot(repository, run.runId);
      const afterNow = validNow(dependencies.now());
      const afterStop = await waitForStop(stopController, runnerLease, 0);
      if (afterStop === 'RUNNER_LOCK_LOST') throw new PaperMvpCliError(afterStop);
      if (afterStop !== 'POLL') {
        await collectFinal(collector,after,options.targetClosedPositions,runnerLease,stopController,
          dependencies.finalCollectionGraceMs);
        ({ result } = await finishBoundedStop(
          afterStop, repository, run.runId, dependencies, options, runnerLease,
        ));
        continue;
      }
      if (afterNow >= after.run.deadlineAtMs) {
        await collectFinal(collector,after,options.targetClosedPositions,runnerLease,stopController,
          dependencies.finalCollectionGraceMs);
        ({ result } = await finishBoundedStop(
          'TIMEOUT', repository, run.runId, dependencies, options, runnerLease,
        ));
        continue;
      }
      if (after.run.closedPositions >= options.targetClosedPositions) {
        result = await completeAndExport(
          after, afterNow, 'TARGET_REACHED', repository, options, dependencies, runnerLease,
        );
        prepared.terminal = true;
        continue;
      }
      const waitMs = Math.min(options.pollMs, after.run.deadlineAtMs - afterNow);
      const stop = await waitForStop(stopController, runnerLease, waitMs);
      if (stop === 'RUNNER_LOCK_LOST') throw new PaperMvpCliError(stop);
      if (stop === 'POLL') continue;
      const interrupted = await requiredRunningSnapshot(repository, run.runId);
      await collectFinal(collector,interrupted,options.targetClosedPositions,runnerLease,stopController,
        dependencies.finalCollectionGraceMs);
      ({ result } = await finishBoundedStop(
        stop, repository, run.runId, dependencies, options, runnerLease,
      ));
    }
  } catch (error: unknown) {
    const ownershipLost = (error instanceof PaperMvpCliError && error.code === 'RUNNER_LOCK_LOST')
      || hasCode(error, 'RUN_OWNERSHIP_LOST') || runnerLease.isLost();
    if (ownershipLost) {
      failureCode = 'RUNNER_LOCK_LOST';
    }
    if (!ownershipLost && !prepared.terminal) {
      try {
        assertRunnerOwnership(runnerLease);
        const snapshot = await repository.load(run.runId);
        if (snapshot?.run.state === 'RUNNING') {
          await repository.terminalize({
            runId: run.runId, runnerOwnerId: runnerLease.ownerId,
            terminalAtMs: Math.max(validNow(dependencies.now()), snapshot.run.updatedAtMs),
            state: 'FAILED', completionReason: null, report: null,
            failureCode: durableFailureCode,
          });
          prepared.terminal = true;
        }
      } catch { /* retain the stable outer failure */ }
    }
    if (ownershipLost) throw new PaperMvpCliError('RUNNER_LOCK_LOST');
    if (error instanceof PaperMvpCliError) throw error;
    throw new PaperMvpCliError(failureCode);
  }
  prepared.terminal = true;
  return result;
}

async function cleanupPreparedRun(
  prepared: PreparedPaperMvpRun,
  dependencies: PaperMvpRunnerDependencies,
): Promise<void> {
  if (prepared.cleaned) return;
  prepared.cleaned = true;
  prepared.stopController.close();
  if (!prepared.terminal && !prepared.runnerLease.isLost()) {
    try {
      const snapshot = await prepared.repository.load(prepared.run.runId);
      if (snapshot?.run.state === 'RUNNING'
        && snapshot.run.runnerOwnerId === prepared.runnerLease.ownerId) {
        await prepared.repository.terminalize({
          runId: prepared.run.runId, runnerOwnerId: prepared.runnerLease.ownerId,
          terminalAtMs: Math.max(validNow(dependencies.now()), snapshot.run.updatedAtMs),
          state: 'FAILED', completionReason: null, report: null,
          failureCode: 'RUNNER_OPERATION_FAILED',
        });
      }
    } catch { /* preserve the startup/shutdown failure and durable audit */ }
  }
  await prepared.runnerLease.release();
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
  lease: PaperMvpRunnerLease,
  controller: PaperMvpStopController,
  timeoutMs: number,
  observeFirstSignal: boolean,
): Promise<'TIMEOUT' | 'SIGINT' | 'SIGTERM' | 'RUNNER_LOCK_LOST' | null> {
  const remaining = targetClosedPositions - snapshot.run.closedPositions;
  if (remaining <= 0) return null;
  assertRunnerOwnership(lease);
  const abortController = new AbortController();
  const operation = collector.collect({
    runId: snapshot.run.runId, runnerOwnerId: lease.ownerId, limit: remaining,
    signal: abortController.signal,
  });
  void operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => { resolve('TIMEOUT'); }, Math.max(0,timeoutMs));
    timer.unref();
  });
  const races: Promise<PaperMvpStopReason | 'TIMEOUT' | 'RUNNER_LOCK_LOST' | 'FORCED' | null>[] = [
    operation.then(() => null), deadline,
    lease.lost.then(() => 'RUNNER_LOCK_LOST' as const),
  ];
  if (observeFirstSignal && controller.firstSignal !== undefined) races.push(controller.firstSignal);
  if (controller.forced !== undefined) races.push(controller.forced.then(() => 'FORCED' as const));
  let outcome: PaperMvpStopReason | 'TIMEOUT' | 'RUNNER_LOCK_LOST' | 'FORCED' | null;
  try {
    outcome = await Promise.race(races);
  } catch (error: unknown) {
    abortController.abort();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (outcome === null) {
    assertRunnerOwnership(lease);
    return null;
  }
  abortController.abort();
  if (outcome === 'FORCED') return null;
  return outcome === 'POLL' ? 'TIMEOUT' : outcome;
}

async function collectFinal(
  collector: PaperMvpCollectorPort,
  snapshot: PaperMvpRunSnapshot,
  targetClosedPositions: number,
  lease: PaperMvpRunnerLease,
  controller: PaperMvpStopController,
  graceMs: number,
): Promise<void> {
  const stop = await collectRemaining(
    collector,snapshot,targetClosedPositions,lease,controller,graceMs,false,
  );
  if (stop === 'RUNNER_LOCK_LOST') throw new PaperMvpCliError(stop);
  assertRunnerOwnership(lease);
}

async function finishBoundedStop(
  reason: 'TIMEOUT' | 'SIGINT' | 'SIGTERM',
  repository: PaperMvpRepository,
  runId: string,
  dependencies: PaperMvpRunnerDependencies,
  options: PaperMvpCliOptions,
  lease: PaperMvpRunnerLease,
): Promise<Readonly<{ result: PaperMvpRunResult; terminal: true }>> {
  const snapshot = await requiredRunningSnapshot(repository, runId);
  const terminalAtMs = Math.max(validNow(dependencies.now()), snapshot.run.updatedAtMs);
  const result = await completeAndExport(
    snapshot, terminalAtMs, reason, repository, options, dependencies, lease,
  );
  return Object.freeze({ result, terminal: true });
}

async function completeAndExport(
  snapshot: PaperMvpRunSnapshot,
  terminalAtMs: number,
  completionReason: 'TARGET_REACHED' | 'TIMEOUT' | 'SIGINT' | 'SIGTERM',
  repository: PaperMvpRepository,
  options: PaperMvpCliOptions,
  dependencies: PaperMvpRunnerDependencies,
  lease: PaperMvpRunnerLease,
): Promise<PaperMvpRunResult> {
  let current = snapshot;
  let canonicalTerminalAtMs = Math.max(terminalAtMs, current.run.updatedAtMs);
  let candidate = reportFromSnapshot(current, canonicalTerminalAtMs, completionReason);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertRunnerOwnership(lease);
    try {
      await repository.terminalize({
        runId: current.run.runId, runnerOwnerId: lease.ownerId,
        terminalAtMs: canonicalTerminalAtMs, state: 'COMPLETED', completionReason,
        report: candidate, failureCode: null,
      });
      break;
    } catch (error: unknown) {
      if (!hasCode(error, 'TERMINALIZATION_CONTRADICTION') || attempt === 2) throw error;
      assertRunnerOwnership(lease);
      current = await requiredRunningSnapshot(repository, current.run.runId);
      canonicalTerminalAtMs = Math.max(canonicalTerminalAtMs,current.run.updatedAtMs);
      candidate = reportFromSnapshot(current,canonicalTerminalAtMs,completionReason);
    }
  }
  assertRunnerOwnership(lease);
  const durable = await repository.load(current.run.runId);
  assertRunnerOwnership(lease);
  if (
    durable?.run.state !== 'COMPLETED'
    || durable.run.terminalAtMs === null
    || durable.run.verdict !== candidate.verdict
    || durable.run.completionReason !== completionReason
  ) throw new PaperMvpCliError('DURABLE_REPORT_INVALID');
  const report = reportFromSnapshot(durable, durable.run.terminalAtMs, completionReason);
  if (JSON.stringify(report) !== JSON.stringify(candidate)) {
    throw new PaperMvpCliError('DURABLE_REPORT_INVALID');
  }
  try {
    assertRunnerOwnership(lease);
    await dependencies.writeReport(options.reportFile, `${JSON.stringify(report, null, 2)}\n`);
    assertRunnerOwnership(lease);
  } catch {
    throw new PaperMvpCliError('REPORT_EXPORT_FAILED');
  }
  return Object.freeze({ exitCode: report.verdict === 'PASS' ? 0 : 2, report });
}

function reportFromSnapshot(
  snapshot: PaperMvpRunSnapshot,
  completedAtMs: number,
  completionReason: 'TARGET_REACHED' | 'TIMEOUT' | 'SIGINT' | 'SIGTERM',
): PaperMvpReportV1 {
  return createPaperMvpReport({
    runId: snapshot.run.runId,
    completionReason,
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

function assertRunnerOwnership(lease: PaperMvpRunnerLease): void {
  if (lease.isLost()) throw new PaperMvpCliError('RUNNER_LOCK_LOST');
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
    || config.paperExternalBuyTarget !== 10
    || config.creationTakeProfitMultiplierBps !== 20_000n
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
