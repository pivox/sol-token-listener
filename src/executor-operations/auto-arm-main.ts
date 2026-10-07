import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { SolanaReadinessRpcGateway } from '../executor-readiness/rpc-gateway.js';
import {
  createAutoArmState,
  formatAutoArmTickLog,
  runAutoArmTick,
  type AutoArmTickResult,
} from './auto-arm.js';
import { parseExecutionAutoArmConfig } from './config.js';
import { openExecutionOperationsDatabase } from './database.js';

export interface AutoArmLoopDependencies {
  readonly tick: (signal: AbortSignal) => Promise<AutoArmTickResult>;
  readonly tickTimeoutMs: number;
  readonly pollMs: number;
  readonly log: (line: string) => void;
  /** Called after a tick reports a database or repository error. */
  readonly onError: () => void;
  readonly stop: AbortSignal;
}

/** tick -> sleep(poll) until stopped. A failing tick is logged and the loop continues. */
export async function runAutoArmLoop(dependencies: AutoArmLoopDependencies): Promise<void> {
  while (!dependencies.stop.aborted) {
    let result: AutoArmTickResult;
    try {
      result = await dependencies.tick(AbortSignal.any([
        dependencies.stop, AbortSignal.timeout(dependencies.tickTimeoutMs),
      ]));
    } catch {
      result = Object.freeze({ kind: 'ERROR', reason: 'UNEXPECTED_FAILURE' });
    }
    dependencies.log(formatAutoArmTickLog(result));
    if (result.kind === 'ERROR') dependencies.onError();
    await sleep(dependencies.pollMs, dependencies.stop);
  }
}

export async function main(): Promise<void> {
  const config = parseExecutionAutoArmConfig(process.env);
  const stop = new AbortController();
  const shutdown = (): void => { stop.abort(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const database = openExecutionOperationsDatabase({
    databaseUrl: config.databaseUrl,
    statementTimeoutMs: 3_000,
    onIdleError: () => { database.evict(); },
  });
  try {
    const rpc = new SolanaReadinessRpcGateway({
      providerId: config.providerId,
      httpRpcUrl: config.httpRpcUrl,
      expectedGenesisHash: config.genesisHash,
      timeoutMs: config.rpcTimeoutMs,
    });
    await rpc.verifyGenesis(AbortSignal.any([stop.signal, AbortSignal.timeout(config.rpcTimeoutMs * 2)]));
    const state = createAutoArmState();
    await runAutoArmLoop({
      tick: (signal) => runAutoArmTick({ config, repository: database.repository, rpc, state }, signal),
      tickTimeoutMs: config.rpcTimeoutMs * 2,
      pollMs: config.pollMs,
      log: (line) => { process.stdout.write(`${line}\n`); },
      onError: () => { database.evict(); },
      stop: stop.signal,
    });
  } finally {
    await database.close();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(() => {
    process.exitCode = 1;
    process.stderr.write(`${JSON.stringify({
      service: 'sol-token-executor-auto-arm',
      event: 'executor.auto_arm_failed',
      errorCode: 'EXECUTION_AUTO_ARM_FAILED',
    })}\n`);
  });
}
