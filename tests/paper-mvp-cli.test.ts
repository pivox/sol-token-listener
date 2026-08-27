import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseConfig, type AppConfig } from '../src/config/env.js';
import { createPaperMvpPositionSample } from '../src/domain/paper-mvp.js';
import type {
  PaperMvpRepository,
  PaperMvpRun,
  PaperMvpRunConfiguration,
  PaperMvpRunSnapshot,
  PaperMvpTerminalization,
} from '../src/ports/paper-mvp-repository.js';
import {
  createProviderUsageSnapshot,
  type ProviderUsageProbe,
} from '../src/ports/provider-usage-probe.js';
import {
  PaperMvpCliError,
  parsePaperMvpArguments,
  runPaperMvp,
  type PaperMvpRunnerDependencies,
} from '../src/cli/paper-mvp.js';
import { acquirePostgresRunner } from '../src/cli/paper-mvp-runtime.js';
import { executionBoundaryViolations } from './helpers/execution-boundary.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const OWNER = 'paper-mvp-owner-test';

void test('parses the exact bounded canonical paper MVP arguments', () => {
  assert.deepEqual(parsePaperMvpArguments([
    '--target-closed=50',
    '--max-duration-seconds=14400',
    '--poll-seconds=5',
    '--initial-capital-raw=1000000000',
    '--network-fee-raw-per-transaction=5000',
    '--report-file=paper-mvp.json',
  ]), {
    targetClosedPositions: 50,
    maxDurationMs: 14_400_000,
    pollMs: 5_000,
    initialCapitalRaw: 1_000_000_000n,
    networkFeeRawPerTransaction: 5_000n,
    reportFile: 'paper-mvp.json',
  });
});

void test('rejects missing, unknown, duplicate, noncanonical and out-of-bound arguments', () => {
  const valid = validArguments();
  const invalid: readonly (readonly string[])[] = [
    [], valid.slice(0, 5), [...valid, '--live=true'],
    [...valid, '--target-closed=51'],
    replace(valid, '--target-closed', '0'), replace(valid, '--target-closed', '1001'),
    replace(valid, '--target-closed', '050'), replace(valid, '--target-closed', '+50'),
    replace(valid, '--max-duration-seconds', '59'),
    replace(valid, '--max-duration-seconds', '14401'),
    replace(valid, '--poll-seconds', '0'), replace(valid, '--poll-seconds', '61'),
    replace(valid, '--initial-capital-raw', '0'), replace(valid, '--initial-capital-raw', '01'),
    replace(valid, '--initial-capital-raw', '1'.repeat(79)),
    replace(valid, '--network-fee-raw-per-transaction', '-1'),
    replace(valid, '--network-fee-raw-per-transaction', '1'.repeat(79)),
    replace(valid, '--report-file', ''), replace(valid, '--report-file', ' report.json'),
    replace(valid, '--report-file', 'report.txt'), replace(valid, '--report-file', 'a\nb.json'),
    replace(valid, '--report-file', `${'é'.repeat(2_047)}x.json`),
  ];
  for (const arguments_ of invalid) {
    assert.throws(() => parsePaperMvpArguments(arguments_), {
      name: 'TypeError', message: 'Paper MVP command options are invalid.',
    });
  }
});

void test('fails every safety gate before bootstrap, database, collector, or file access', async () => {
  const valid = paperConfig();
  const invalid: readonly AppConfig[] = [
    { ...valid, cluster: 'devnet' }, { ...valid, executionMode: 'observe' },
    { ...valid, listenerEnabled: false }, { ...valid, creationStrategyEnabled: false },
    { ...valid, paperStrategyEnabled: false },
    { ...valid, paperStrategyId: 'validated-external-buys' },
    { ...valid, paperQuoteMintAllowlist: [valid.wsolMint, 'other'] },
    { ...valid, paperQuoteMintAllowlist: ['other'] },
  ];
  for (const config of invalid) {
    let bootstrapCalls = 0;
    await assert.rejects(runPaperMvp(options(), {
      ...dependencies(new MemoryRepository(), config),
      runBootstrap: async () => { bootstrapCalls += 1; },
    }), isCliError('SAFETY_GATE_FAILED'));
    assert.equal(bootstrapCalls, 0);
  }
});

void test('runs the real bootstrap lifetime, reaches target, verifies durable state, and exports wx 0600', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-mvp-cli-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const reportFile = join(directory, 'report.json');
  const repository = new MemoryRepository();
  const calls: string[] = [];
  const result = await runPaperMvp({ ...options(), targetClosedPositions: 1, reportFile }, {
    ...dependencies(repository),
    now: sequenceClock(1_000, 2_000, 2_001, 3_000),
    runBootstrap: async (prepare, inside, cleanup) => {
      calls.push('bootstrap:start');
      const pool = Object.freeze({});
      await prepare(pool);
      try { assert.equal(await inside(pool), 'SIGTERM'); } finally { await cleanup(); }
      calls.push('bootstrap:closed');
    },
    createCollector: () => ({
      collect: async () => {
        calls.push('collect');
        repository.addSample(sample());
        repository.setProviderUsage(availableProbeSnapshot());
        return emptyCollection();
      },
    }),
    createStopController: () => stopController('POLL'),
    writeReport: async (path, contents) => writeFile(path, contents, { flag: 'wx', mode: 0o600 }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report?.verdict, 'PASS');
  assert.equal(repository.snapshot?.run.state, 'COMPLETED');
  assert.deepEqual(calls, ['bootstrap:start', 'collect', 'bootstrap:closed']);
  const serialized = await readFile(reportFile, 'utf8');
  assert.deepEqual(JSON.parse(serialized), result.report);
  assert.equal((await stat(reportFile)).mode & 0o777, 0o600);
  const exportFailureRepository = new MemoryRepository();
  await assert.rejects(runPaperMvp({ ...options(), targetClosedPositions: 1, reportFile }, {
    ...dependencies(exportFailureRepository),
    now: sequenceClock(4_000, 5_000, 5_001, 6_000),
    createCollector: (_repository) => ({
      collect: async () => {
        const memory = _repository as MemoryRepository;
        memory.addSample(sample());
        memory.setProviderUsage(availableProbeSnapshot());
        return emptyCollection();
      },
    }),
    createStopController: () => stopController('POLL'),
    writeReport: async (path, contents) => writeFile(path, contents, { flag: 'wx', mode: 0o600 }),
  }), isCliError('REPORT_EXPORT_FAILED'));
  assert.equal(exportFailureRepository.snapshot?.run.state, 'COMPLETED');
  assert.equal(exportFailureRepository.snapshot?.run.verdict, 'PASS');
});

void test('resumes compatible state, rejects incompatible state, and keeps provider-unavailable honest', async () => {
  const repository = new MemoryRepository();
  await repository.startOrResume(configuration(), OWNER, 1_000);
  const writes: string[] = [];
  const resumed = await runPaperMvp(options(), {
    ...dependencies(repository), now: sequenceClock(2_000, 2_001, 3_000),
    createCollector: () => ({
      collect: async () => { repository.addSample(sample()); return emptyCollection(); },
    }),
    createStopController: () => stopController('POLL'),
    writeReport: async (_path, contents) => { writes.push(contents); },
  });
  assert.equal(repository.starts, 2);
  assert.equal(resumed.exitCode, 2);
  assert.equal(resumed.report?.technicalStatus, 'DEGRADED');
  assert.deepEqual(resumed.report?.failedGateCodes, ['PROVIDER_USAGE_UNAVAILABLE']);
  assert.equal(writes.length, 1);

  const incompatible = new MemoryRepository();
  await incompatible.startOrResume(
    { ...configuration(), targetClosedPositions: 2 }, OWNER, 1_000,
  );
  await assert.rejects(runPaperMvp(options(), dependencies(incompatible)),
    isCliError('ACTIVE_RUN_INCOMPATIBLE'));
});

void test('bounds every collection to the number of target positions still missing', async () => {
  const repository = new MemoryRepository();
  const limits: number[] = [];
  const result = await runPaperMvp({ ...options(), targetClosedPositions: 3 }, {
    ...dependencies(repository),
    createCollector: () => ({
      collect: async ({ limit }) => {
        limits.push(limit);
        for (let index = 0; index < Math.min(limit, 2); index += 1) {
          repository.addSample(sample(`position-${limits.length}-${index}`));
        }
        repository.setProviderUsage(availableProbeSnapshot());
        return emptyCollection();
      },
    }),
    createStopController: () => stopController('POLL'),
  });
  assert.deepEqual(limits, [3, 1]);
  assert.equal(result.report?.closedPositions, 3);
  assert.equal(result.exitCode, 0);
});

void test('a signal latched during collection wins over a newly reached target', async () => {
  const repository = new MemoryRepository();
  const result = await runPaperMvp(options(), {
    ...dependencies(repository),
    createCollector: () => ({
      collect: async () => {
        repository.addSample(sample());
        repository.setProviderUsage(availableProbeSnapshot());
        return emptyCollection();
      },
    }),
    createStopController: () => sequenceStopController(['POLL', 'SIGINT']),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.report?.completionReason, 'SIGINT');
  assert.equal(result.report?.technicalStatus, 'DEGRADED');
  assert.deepEqual(result.report?.failedGateCodes, ['RUN_INTERRUPTED']);
  assert.equal(repository.snapshot?.run.state, 'COMPLETED');
});

void test('timeout and signal each perform a final collect and cannot turn a late target into PASS', async () => {
  for (const stop of ['TIMEOUT', 'SIGINT', 'SIGTERM'] as const) {
    const repository = new MemoryRepository();
    let collects = 0;
    const writes: string[] = [];
    const result = await runPaperMvp(options(), {
      ...dependencies(repository),
      now: stop === 'TIMEOUT'
        ? sequenceClock(1_000, 1_001, 61_000, 61_001, 61_002)
        : sequenceClock(1_000, 1_001, 2_000, 2_001, 2_002),
      createCollector: () => ({
        collect: async () => {
          collects += 1;
          if (collects === 2) {
            repository.addSample(sample());
            repository.setProviderUsage(availableProbeSnapshot());
          }
          return emptyCollection();
        },
      }),
      createStopController: () => stop === 'TIMEOUT'
        ? stopController('POLL') : sequenceStopController(['POLL', 'POLL', stop]),
      writeReport: async (_path, contents) => { writes.push(contents); },
    });
    assert.equal(collects, 2, stop);
    assert.equal(result.exitCode, 2, stop);
    assert.equal(result.report?.completionReason, stop, stop);
    assert.equal(result.report?.technicalStatus, 'DEGRADED', stop);
    assert.equal(result.report?.verdict, 'FAIL', stop);
    assert.deepEqual(result.report?.failedGateCodes,
      [stop === 'TIMEOUT' ? 'RUN_TIMED_OUT' : 'RUN_INTERRUPTED']);
    assert.equal(repository.snapshot?.run.state, 'COMPLETED', stop);
    assert.equal(repository.snapshot?.run.completionReason, stop, stop);
    assert.equal(repository.snapshot?.run.verdict, 'FAIL', stop);
    assert.equal(writes.length, 1, stop);
    assert.deepEqual(JSON.parse(writes[0] ?? 'null'), result.report, stop);
  }
});

void test('a timeout below target exports the durable failing report with exit code 2', async () => {
  const repository = new MemoryRepository();
  const writes: string[] = [];
  const result = await runPaperMvp(options(), {
    ...dependencies(repository), now: sequenceClock(1_000, 1_001, 61_000, 61_001, 61_002),
    createCollector: () => ({ collect: async () => emptyCollection() }),
    createStopController: () => stopController('POLL'),
    writeReport: async (_path, contents) => { writes.push(contents); },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.report?.verdict, 'FAIL');
  assert.ok(result.report?.failedGateCodes.includes('CLOSED_POSITIONS_BELOW_TARGET'));
  assert.ok(result.report?.failedGateCodes.includes('RUN_TIMED_OUT'));
  assert.equal(repository.snapshot?.run.state, 'COMPLETED');
  assert.equal(writes.length, 1);
});

void test('bounds a never-settling final timeout collection and suppresses its late rejection', async () => {
  const repository = new MemoryRepository();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  let aborts = 0;
  try {
    const result = await runPaperMvp(options(), {
      ...dependencies(repository),
      now: sequenceClock(1_000,61_000,61_001,61_002),
      finalCollectionGraceMs: 10,
      createCollector: () => ({
        collect: ({ signal }) => new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborts += 1;
            queueMicrotask(() => { reject(new Error('late-provider-secret')); });
          }, { once:true });
        }),
      }),
      createStopController: () => stopController('POLL'),
    });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(result.report?.completionReason,'TIMEOUT');
    assert.equal(result.exitCode,2);
    assert.equal(aborts,1);
    assert.deepEqual(unhandled,[]);
  } finally {
    process.off('unhandledRejection',onUnhandled);
  }
});

void test('first signal aborts the current collection and a second signal forces the final attempt', async () => {
  const repository = new MemoryRepository();
  let resolveFirst: ((signal: 'SIGINT') => void) | undefined;
  const firstSignal = new Promise<'SIGINT'>((resolve) => { resolveFirst = resolve; });
  let resolveForced: (() => void) | undefined;
  const forced = new Promise<void>((resolve) => { resolveForced = resolve; });
  let collects = 0;
  let aborts = 0;
  const result = await runPaperMvp(options(), {
    ...dependencies(repository),
    createCollector: () => ({
      collect: ({ signal }) => {
        collects += 1;
        if (collects === 1) resolveFirst?.('SIGINT');
        else resolveForced?.();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborts += 1;
            reject(new Error('aborted'));
          }, { once:true });
        });
      },
    }),
    createStopController: () => Object.freeze({
      firstSignal,forced,wait:async () => 'POLL' as const,close:() => undefined,
    }),
  });
  assert.equal(result.report?.completionReason,'SIGINT');
  assert.equal(result.exitCode,2);
  assert.equal(collects,2);
  assert.equal(aborts,2);
});

void test('rebuilds an interrupted report when an already-started late progress wins the row lock', async () => {
  class InterleavedRepository extends MemoryRepository {
    public completedAttempts = 0;
    public override async terminalize(value: PaperMvpTerminalization): Promise<PaperMvpRun> {
      if (value.state === 'COMPLETED' && this.completedAttempts++ === 0) {
        this.addSample(sample());
        const error = new Error('late progress') as Error & { code: string };
        error.code = 'TERMINALIZATION_CONTRADICTION';
        throw error;
      }
      return super.terminalize(value);
    }
  }
  const repository = new InterleavedRepository();
  const result = await runPaperMvp(options(), {
    ...dependencies(repository),
    createCollector: () => ({ collect: async () => emptyCollection() }),
    createStopController: () => stopController('SIGINT'),
  });
  assert.equal(repository.completedAttempts,2);
  assert.equal(result.report?.completionReason,'SIGINT');
  assert.equal(result.report?.closedPositions,1);
  assert.equal(result.report?.verdict,'FAIL');
  assert.equal(result.exitCode,2);
});

void test('lease loss aborts a never-settling collection without terminalization or report', async () => {
  const repository = new MemoryRepository();
  const controlled = controlledRunnerLease();
  let aborted = false;
  await assert.rejects(runPaperMvp(options(), {
    ...dependencies(repository),
    acquireRunner: async () => controlled.lease,
    createCollector: () => ({
      collect: ({ signal }) => {
        controlled.lose();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          }, { once:true });
        });
      },
    }),
    createStopController: () => stopController('POLL'),
  }), isCliError('RUNNER_LOCK_LOST'));
  assert.equal(aborted,true);
  assert.equal(repository.terminalizations,0);
  assert.equal(repository.snapshot?.run.state,'RUNNING');
});

void test('redacts runtime failures, closes signal and ownership resources, and leaves no report', async () => {
  const repository = new MemoryRepository();
  const calls: string[] = [];
  await assert.rejects(runPaperMvp(options(), {
    ...dependencies(repository),
    createCollector: () => ({ collect: async () => { throw new Error('rpc-secret-url'); } }),
    acquireRunner: async () => runnerLease(async () => { calls.push('runner:release'); }),
    createStopController: () => ({
      wait: async () => 'POLL', close: () => { calls.push('signals:close'); },
    }),
    writeReport: async () => { calls.push('report:write'); },
  }), (error: unknown) => {
    assert.ok(error instanceof PaperMvpCliError);
    assert.equal(error.code, 'RUN_FAILED');
    assert.doesNotMatch(error.message, /rpc|secret|url/iu);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
  assert.deepEqual(calls, ['signals:close', 'runner:release']);
  assert.equal(repository.snapshot?.run.failureCode, 'RUNNER_OPERATION_FAILED');
});

void test('redacts bootstrap and cleanup failures outside the runner callback', async () => {
  const repository = new MemoryRepository();
  await assert.rejects(runPaperMvp(options(), {
    ...dependencies(repository),
    runBootstrap: async () => { throw new Error('database-url-secret'); },
  }), (error: unknown) => {
    assert.ok(error instanceof PaperMvpCliError);
    assert.equal(error.code, 'RUN_FAILED');
    assert.doesNotMatch(error.message, /database|url|secret/iu);
    return true;
  });
});

void test('claims after migrations before listener startup and terminalizes a later startup failure', async () => {
  const repository = new MemoryRepository();
  const calls: string[] = [];
  await assert.rejects(runPaperMvp(options(), {
    ...dependencies(repository),
    runBootstrap: async (prepare,_inside,cleanup) => {
      const pool = Object.freeze({});
      calls.push('migrations.complete');
      await prepare(pool);
      calls.push('run.claimed');
      try {
        calls.push('listener.start');
        throw new Error('listener-startup-secret');
      } finally {
        await cleanup();
      }
    },
  }), isCliError('RUN_FAILED'));
  assert.deepEqual(calls,['migrations.complete','run.claimed','listener.start']);
  assert.equal(repository.starts,1);
  assert.equal(repository.snapshot?.run.state,'FAILED');
  assert.equal(repository.snapshot?.run.failureCode,'RUNNER_OPERATION_FAILED');
});

void test('releases PostgreSQL runner clients on acquisition failure and verifies unlock', async () => {
  const acquisitionReleases: (boolean | Error | undefined)[] = [];
  await assert.rejects(acquirePostgresRunner({
    connect: async () => Object.assign(new EventEmitter(), {
      query: async () => { throw new Error('database-secret'); },
      release: (destroy?: boolean | Error) => { acquisitionReleases.push(destroy); },
    }),
  }), isCliError('RUN_FAILED'));
  assert.deepEqual(acquisitionReleases, [true]);

  const conflictReleases: (boolean | Error | undefined)[] = [];
  await assert.rejects(acquirePostgresRunner({
    connect: async () => Object.assign(new EventEmitter(), {
      query: async () => ({ rows: [{ acquired: false }] }),
      release: (destroy?: boolean | Error) => { conflictReleases.push(destroy); },
    }),
  }), isCliError('RUNNER_ALREADY_ACTIVE'));
  assert.deepEqual(conflictReleases, [undefined]);

  const releaseArguments: (boolean | Error | undefined)[] = [];
  let queries = 0;
  const client = Object.assign(new EventEmitter(), {
      query: async () => {
        queries += 1;
        return { rows: queries === 1 ? [{ acquired: true }] : [{ unlocked: true }] };
      },
      release: (destroy?: boolean | Error) => { releaseArguments.push(destroy); },
  });
  const lease = await acquirePostgresRunner({ connect: async () => client });
  client.emit('error', new Error('connection-secret'));
  await lease.lost;
  assert.equal(lease.isLost(), true);
  await lease.release();
  await lease.release();
  assert.equal(queries, 1);
  assert.deepEqual(releaseArguments, [true]);

  const normalReleases: (boolean | Error | undefined)[] = [];
  let normalQueries = 0;
  const normalClient = Object.assign(new EventEmitter(), {
    query: async () => {
      normalQueries += 1;
      return { rows: normalQueries === 1 ? [{ acquired: true }] : [{ unlocked: true }] };
    },
    release: (destroy?: boolean | Error) => { normalReleases.push(destroy); },
  });
  const normalLease = await acquirePostgresRunner({ connect: async () => normalClient });
  assert.match(normalLease.ownerId, /^paper_mvp_owner_[0-9a-f-]{36}$/u);
  assert.notEqual(normalLease.ownerId, lease.ownerId);
  await normalLease.release();
  await normalLease.release();
  assert.equal(normalQueries, 2);
  assert.deepEqual(normalReleases, [undefined]);
});

void test('does not mutate durable state when PostgreSQL runner ownership is lost', async () => {
  const repository = new MemoryRepository();
  const calls: string[] = [];
  const ownership = controlledRunnerLease(async () => { calls.push('runner.release'); });
  ownership.lose();
  await assert.rejects(runPaperMvp(options(), {
    ...dependencies(repository),
    acquireRunner: async () => ownership.lease,
    createStopController: () => ({ wait: async () => new Promise(() => undefined), close: () => undefined }),
  }), isCliError('RUNNER_LOCK_LOST'));
  assert.equal(repository.snapshot, null);
  assert.equal(repository.starts, 0);
  assert.deepEqual(calls, ['runner.release']);
});

void test('loss during the final collection leaves the resumable run unterminated', async () => {
  const repository = new MemoryRepository();
  const calls: string[] = [];
  const ownership = controlledRunnerLease(async () => { calls.push('runner.release'); });
  let writes = 0;
  await assert.rejects(runPaperMvp(options(), {
    ...dependencies(repository),
    acquireRunner: async () => ownership.lease,
    createCollector: () => ({
      collect: async () => {
        ownership.lose();
        return emptyCollection();
      },
    }),
    createStopController: () => Object.freeze({
      wait: async () => 'POLL' as const,
      close: () => { calls.push('signals.close'); },
    }),
    writeReport: async () => { writes += 1; },
  }), isCliError('RUNNER_LOCK_LOST'));
  assert.equal(repository.snapshot?.run.state, 'RUNNING');
  assert.equal(repository.snapshot?.run.closedPositions, 0);
  assert.equal(repository.terminalizations, 0);
  assert.equal(writes, 0);
  assert.deepEqual(calls, ['signals.close', 'runner.release']);
});

void test('loss immediately before terminalization prevents terminal state and export', async () => {
  const repository = new MemoryRepository();
  const ownership = controlledRunnerLease();
  let writes = 0;
  repository.seed(configuration(), OWNER, 1_000, sample(), availableProbeSnapshot());
  await assert.rejects(runPaperMvp(options(), {
    ...dependencies(repository),
    acquireRunner: async () => ownership.lease,
    now: sequenceClock(2_000, 2_001),
    createStopController: () => Object.freeze({
      wait: async () => {
        queueMicrotask(ownership.lose);
        return 'POLL' as const;
      },
      close: () => undefined,
    }),
    writeReport: async () => { writes += 1; },
  }), isCliError('RUNNER_LOCK_LOST'));
  assert.equal(repository.snapshot?.run.state, 'RUNNING');
  assert.equal(repository.terminalizations, 0);
  assert.equal(writes, 0);
});

void test('loss immediately before export suppresses the artifact and returns operational failure', async () => {
  const repository = new MemoryRepository();
  const ownership = controlledRunnerLease();
  let writes = 0;
  repository.seed(configuration(), OWNER, 1_000, sample(), availableProbeSnapshot());
  repository.onLoad = (snapshot) => {
    if (snapshot?.run.state === 'COMPLETED') ownership.lose();
  };
  await assert.rejects(runPaperMvp(options(), {
    ...dependencies(repository),
    acquireRunner: async () => ownership.lease,
    createStopController: () => stopController('SIGINT'),
    writeReport: async () => { writes += 1; },
  }), isCliError('RUNNER_LOCK_LOST'));
  assert.equal(repository.snapshot?.run.state, 'COMPLETED');
  assert.equal(repository.snapshot?.run.completionReason, 'SIGINT');
  assert.equal(repository.snapshot?.run.verdict, 'FAIL');
  assert.equal(writes, 0);
});

void test('publishes an executable ESM command with no signing or submission import graph', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    readonly scripts?: Readonly<Record<string, unknown>>;
  };
  assert.equal(manifest.scripts?.['paper:mvp'], 'tsx src/cli/paper-mvp.ts');
  const entrypoint = fileURLToPath(new URL('../src/cli/paper-mvp.ts', import.meta.url));
  const graph = await readLocalImportGraph(entrypoint);
  const violations: string[] = [];
  for (const [path, source] of graph) {
    violations.push(...executionBoundaryViolations(source, path, repositoryRoot));
    if (/\b(?:Keypair|sendTransaction|signTransaction|WalletSigner)\b/u.test(source)) {
      violations.push(`Forbidden execution symbol in ${path}`);
    }
  }
  assert.deepEqual(violations, []);
  assert.match(graph.get(entrypoint) ?? '', /import\.meta\.url === pathToFileURL\(entrypoint\)\.href/u);
});

function validArguments(): readonly string[] {
  return [
    '--target-closed=50', '--max-duration-seconds=14400', '--poll-seconds=5',
    '--initial-capital-raw=1000000000', '--network-fee-raw-per-transaction=5000',
    '--report-file=paper-mvp.json',
  ];
}

function replace(values: readonly string[], key: string, value: string): readonly string[] {
  return values.map((entry) => entry.startsWith(`${key}=`) ? `${key}=${value}` : entry);
}

function options() {
  return parsePaperMvpArguments([
    '--target-closed=1', '--max-duration-seconds=60', '--poll-seconds=1',
    '--initial-capital-raw=1000000', '--network-fee-raw-per-transaction=5',
    '--report-file=paper-mvp.json',
  ]);
}

function paperConfig(): AppConfig {
  return parseConfig({
    SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid',
    SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid', EXECUTION_MODE: 'paper',
    CREATION_STRATEGY_ENABLED: 'true', PAPER_ENTRY_QUOTE_AMOUNT_RAW: '1000',
    PAPER_SLIPPAGE_BPS: '100', EXTERNAL_MIN_BUY_AMOUNT_RAW: '1',
    QUALIFICATION_PROFILE_PATH: 'config/qualification/pumpfun-v1-unvalidated.json',
    RISK_MAX_ROUNDTRIP_LOSS_BPS: '3000',
  });
}

function configuration(): PaperMvpRunConfiguration {
  const config = paperConfig();
  return Object.freeze({
    strategyId: 'creation-entry-v1', strategyVersion: 1, quoteMint: config.wsolMint,
    targetClosedPositions: 1, initialCapitalRaw: 1_000_000n,
    networkFeeRawPerTransaction: 5n, maxDurationMs: 60_000,
    providerIdentity: 'provider-usage:unavailable:v1',
  });
}

function dependencies(
  repository: MemoryRepository,
  config = paperConfig(),
): PaperMvpRunnerDependencies {
  return {
    config, now: sequenceClock(1_000, 1_001, 2_000, 2_001, 3_000),
    providerUsageProbe: unavailableProbe(),
    finalCollectionGraceMs: 20,
    runBootstrap: async (prepare, inside, cleanup) => {
      const pool = Object.freeze({});
      await prepare(pool);
      try { await inside(pool); } finally { await cleanup(); }
    },
    createRepository: () => repository,
    createCollector: () => ({ collect: async () => emptyCollection() }),
    acquireRunner: async () => runnerLease(async () => undefined),
    createStopController: () => stopController('SIGTERM'),
    writeReport: async () => undefined,
  };
}

function stopController(value: 'POLL' | 'SIGINT' | 'SIGTERM') {
  return Object.freeze({ wait: async () => value, close: () => undefined });
}

function sequenceStopController(values: readonly ('POLL' | 'SIGINT' | 'SIGTERM')[]) {
  let index = 0;
  return Object.freeze({
    wait: async () => values[Math.min(index++, values.length - 1)] ?? 'POLL',
    close: () => undefined,
  });
}

function runnerLease(release: () => Promise<void>, lost = new Promise<void>(() => undefined)) {
  let lockLost = false;
  void lost.then(() => { lockLost = true; });
  return Object.freeze({ ownerId: OWNER, release, lost, isLost: () => lockLost });
}

function controlledRunnerLease(release: () => Promise<void> = async () => undefined) {
  let lockLost = false;
  let resolveLoss: (() => void) | undefined;
  const lost = new Promise<void>((resolve) => { resolveLoss = resolve; });
  const lose = (): void => {
    if (lockLost) return;
    lockLost = true;
    resolveLoss?.();
  };
  return Object.freeze({
    lose,
    lease: Object.freeze({
      ownerId: OWNER, lost, isLost: () => lockLost, release,
    }),
  });
}

function unavailableProbe(): ProviderUsageProbe {
  return Object.freeze({
    identity: 'provider-usage:unavailable:v1',
    snapshot: async () => createProviderUsageSnapshot({
      status: 'UNAVAILABLE', creditsUsedStart: null, creditsUsedEnd: null, rateLimitedCount: 0,
    }),
  });
}

function availableProbeSnapshot(status: 'AVAILABLE' | 'UNAVAILABLE' = 'AVAILABLE') {
  return status === 'AVAILABLE'
    ? Object.freeze({ status, creditsUsedStart: 100n, creditsUsedEnd: 101n, rateLimitedCount: 0 })
    : Object.freeze({ status, creditsUsedStart: null, creditsUsedEnd: null, rateLimitedCount: 0 });
}

function sample(positionId = 'position-1') {
  const config = paperConfig();
  return createPaperMvpPositionSample({
    positionId, mint: 'mint', quoteMint: config.wsolMint,
    exitReason: 'TAKE_PROFIT_2X_EXECUTABLE', creationDetectedAtMs: 1_100,
    entryDecisionAtMs: 1_200, entryQuoteAtMs: 1_300, paperBuyAtMs: 1_400,
    exitTriggerAtMs: 1_500, exitQuoteAtMs: 1_600, paperSellAtMs: 1_700,
    buyAmountInRaw: 100n, buyAmountOutRaw: 100n, buyMinimumAmountOutRaw: 100n,
    buyFeesRaw: 1n, buySlippageBps: 1n, buyPriceImpactBps: 1n,
    sellAmountInRaw: 100n, sellAmountOutRaw: 201n, sellMinimumAmountOutRaw: 200n,
    sellFeesRaw: 1n, sellSlippageBps: 1n, sellPriceImpactBps: 1n,
    networkFeeRawPerTransaction: 5n,
  });
}

function emptyCollection() {
  return Object.freeze({
    scanned: 0, inserted: 0, valid: 0, unknown: 0,
    duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
  });
}

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

function isCliError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof PaperMvpCliError && error.code === code;
}

class MemoryRepository implements PaperMvpRepository {
  public snapshot: PaperMvpRunSnapshot | null = null;
  public starts = 0;
  public terminalizations = 0;
  public onLoad: ((snapshot: PaperMvpRunSnapshot | null) => void) | null = null;

  public async startOrResume(
    config: PaperMvpRunConfiguration,
    runnerOwnerId: string,
    nowMs: number,
  ): Promise<PaperMvpRun> {
    this.starts += 1;
    if (this.snapshot !== null) {
      if (JSON.stringify(config, bigintJson) !== JSON.stringify(this.snapshot.run.configuration, bigintJson)) {
        const error = new Error('conflict') as Error & { code: string };
        error.code = 'ACTIVE_RUN_INCOMPATIBLE';
        throw error;
      }
      const run = Object.freeze({ ...this.snapshot.run, runnerOwnerId });
      this.snapshot = Object.freeze({ ...this.snapshot, run });
      return run;
    }
    const run: PaperMvpRun = Object.freeze({
      runId: 'run-1', runnerOwnerId, completionReason: null,
      configuration: Object.freeze({ ...config }), state: 'RUNNING',
      counters: Object.freeze({ creationsObserved: 1, entriesRejected: 0,
        unknownTerminalPositions: 0, duplicateLogicalBuys: 0, duplicateLogicalSells: 0 }),
      providerUsage: availableProbeSnapshot('UNAVAILABLE'), closedPositions: 0,
      startedAtMs: nowMs, deadlineAtMs: nowMs + config.maxDurationMs, updatedAtMs: nowMs,
      terminalAtMs: null, purgeAfterMs: null, verdict: null, failureCode: null,
    });
    this.snapshot = Object.freeze({ run, samples: Object.freeze([]), unknownPositions: Object.freeze([]) });
    return run;
  }

  public async recordProgress(): Promise<PaperMvpRun> {
    if (this.snapshot === null) throw new Error('missing');
    return this.snapshot.run;
  }

  public async load(): Promise<PaperMvpRunSnapshot | null> {
    this.onLoad?.(this.snapshot);
    return this.snapshot;
  }

  public async terminalize(value: PaperMvpTerminalization): Promise<PaperMvpRun> {
    if (this.snapshot === null) throw new Error('missing');
    this.terminalizations += 1;
    const run = Object.freeze({
      ...this.snapshot.run, state: value.state, terminalAtMs: value.terminalAtMs,
      updatedAtMs: value.terminalAtMs, verdict: value.report?.verdict ?? null,
      failureCode: value.failureCode, runnerOwnerId: null,
      completionReason: value.completionReason,
    });
    this.snapshot = Object.freeze({ ...this.snapshot, run });
    return run;
  }

  public addSample(value: ReturnType<typeof sample>): void {
    if (this.snapshot === null || this.snapshot.samples.some((item) => item.positionId === value.positionId)) return;
    const samples = Object.freeze([...this.snapshot.samples, value]);
    const run = Object.freeze({ ...this.snapshot.run, closedPositions: samples.length,
      updatedAtMs: this.snapshot.run.updatedAtMs + 1 });
    this.snapshot = Object.freeze({ ...this.snapshot, run, samples });
  }

  public setProviderUsage(value: ReturnType<typeof availableProbeSnapshot>): void {
    if (this.snapshot === null) throw new Error('missing');
    const run = Object.freeze({ ...this.snapshot.run, providerUsage: value,
      updatedAtMs: this.snapshot.run.updatedAtMs + 1 });
    this.snapshot = Object.freeze({ ...this.snapshot, run });
  }

  public seed(
    config: PaperMvpRunConfiguration,
    runnerOwnerId: string,
    nowMs: number,
    value: ReturnType<typeof sample>,
    usage: ReturnType<typeof availableProbeSnapshot>,
  ): void {
    const run: PaperMvpRun = Object.freeze({
      runId: 'run-1', runnerOwnerId, completionReason: null,
      configuration: Object.freeze({ ...config }), state: 'RUNNING',
      counters: Object.freeze({ creationsObserved: 1, entriesRejected: 0,
        unknownTerminalPositions: 0, duplicateLogicalBuys: 0, duplicateLogicalSells: 0 }),
      providerUsage: usage, closedPositions: 1, startedAtMs: nowMs,
      deadlineAtMs: nowMs + config.maxDurationMs, updatedAtMs: nowMs + 1,
      terminalAtMs: null, purgeAfterMs: null, verdict: null, failureCode: null,
    });
    this.snapshot = Object.freeze({
      run, samples: Object.freeze([value]), unknownPositions: Object.freeze([]),
    });
  }
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function readLocalImportGraph(entrypoint: string): Promise<ReadonlyMap<string, string>> {
  const graph = new Map<string, string>();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || graph.has(path)) continue;
    const source = await readFile(path, 'utf8');
    graph.set(path, source);
    for (const match of source.matchAll(
      /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/gu,
    )) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const resolved = resolve(dirname(path), specifier.replace(/\.js$/u, '.ts'));
      if (!graph.has(resolved)) pending.push(resolved);
    }
  }
  return graph;
}
