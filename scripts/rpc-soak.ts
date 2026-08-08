import { pathToFileURL } from 'node:url';
import { Connection } from '@solana/web3.js';
import { parseConfig } from '../src/config/env.js';
import {
  RPC_SOAK_MAX_DURATION_MS,
  RPC_SOAK_MAX_INTERVAL_MS,
  RPC_SOAK_MAX_SAMPLES,
  RPC_SOAK_MIN_DURATION_MS,
  RPC_SOAK_MIN_INTERVAL_MS,
  runRpcSoak,
  type RpcSoakOptions,
  type RpcSoakReport,
} from '../src/solana/rpc/rpc-soak.js';
import { SolanaRpcSoakTransport } from '../src/solana/rpc/rpc-soak-transport.js';

const DEFAULT_DURATION_SECONDS = 60;
const DEFAULT_INTERVAL_MS = 1_000;

export interface RpcSoakCliDependencies {
  readonly environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly execute: (options: RpcSoakOptions) => Promise<RpcSoakReport>;
  readonly write: (line: string) => void;
}

export function parseRpcSoakOptions(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RpcSoakOptions {
  const durationSeconds = parseCanonicalInteger(
    environment.RPC_SOAK_DURATION_SECONDS,
    DEFAULT_DURATION_SECONDS,
    RPC_SOAK_MIN_DURATION_MS / 1_000,
    RPC_SOAK_MAX_DURATION_MS / 1_000,
  );
  const intervalMs = parseCanonicalInteger(
    environment.RPC_SOAK_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    RPC_SOAK_MIN_INTERVAL_MS,
    RPC_SOAK_MAX_INTERVAL_MS,
  );
  const durationMs = durationSeconds * 1_000;
  const sampleCount = Math.floor(durationMs / intervalMs) + 1;
  if (sampleCount < 2 || sampleCount > RPC_SOAK_MAX_SAMPLES) {
    throw new TypeError('RPC soak sample count is invalid.');
  }
  return Object.freeze({ durationMs, intervalMs });
}

export async function runRpcSoakCli(dependencies: RpcSoakCliDependencies): Promise<number> {
  const options = parseRpcSoakOptions(dependencies.environment);
  const report = await dependencies.execute(options);
  dependencies.write(`${JSON.stringify(report)}\n`);
  return report.verdict === 'PASS' ? 0 : report.verdict === 'DEGRADED' ? 2 : 1;
}

function parseCanonicalInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) throw new TypeError('RPC soak configuration is invalid.');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError('RPC soak configuration is invalid.');
  }
  return value;
}

async function main(): Promise<void> {
  try {
    const config = parseConfig(process.env);
    const connection = new Connection(config.httpRpcUrl, {
      commitment: config.commitment,
      wsEndpoint: config.wsRpcUrl,
    });
    const transport = new SolanaRpcSoakTransport({
      httpRpcUrl: config.httpRpcUrl,
      commitment: config.commitment,
      connection,
    });
    process.exitCode = await runRpcSoakCli({
      environment: process.env,
      execute: async (options) => runRpcSoak(transport, options),
      write: (line) => { process.stdout.write(line); },
    });
  } catch {
    process.stderr.write('{"event":"rpc.soak.failed","errorCode":"RPC_SOAK_COMMAND_FAILED"}\n');
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}
