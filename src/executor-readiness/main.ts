import 'dotenv/config';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { ExecutionReadinessManifestV1 } from '../domain/execution-readiness.js';
import { parseExecutionReadinessConfig } from './config.js';
import { openExecutionReadinessDatabase } from './database.js';
import { SolanaReadinessRpcGateway } from './rpc-gateway.js';
import {
  createExecutionReadinessService,
  type ExecutionReadinessService,
} from './service.js';

const MAX_EVIDENCE_BYTES = 131_072;

export async function runExecutionReadinessCommand(
  service: ExecutionReadinessService,
  signal: AbortSignal,
): Promise<string> {
  const manifest: ExecutionReadinessManifestV1 = await service.collect(signal);
  return JSON.stringify(manifest);
}

export async function readBoundedEvidenceFile(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) throw new Error();
    const encoded = await handle.readFile('utf8');
    if (Buffer.byteLength(encoded, 'utf8') > MAX_EVIDENCE_BYTES) throw new Error();
    return encoded;
  } finally {
    await handle.close();
  }
}

export async function main(): Promise<void> {
  const config = parseExecutionReadinessConfig(process.env);
  const abort = new AbortController();
  const stop = (): void => { abort.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let database: ReturnType<typeof openExecutionReadinessDatabase> | undefined;
  try {
    database = openExecutionReadinessDatabase({
      databaseUrl: config.databaseUrl,
      statementTimeoutMs: 3_000,
      onIdleError: () => { database?.evict(); },
    });
    const service = createExecutionReadinessService({
      config,
      rpc: new SolanaReadinessRpcGateway({
        providerId: config.providerId,
        httpRpcUrl: config.httpRpcUrl,
        expectedGenesisHash: config.expectedGenesisHash,
        timeoutMs: config.rpcTimeoutMs,
      }),
      repository: database.repository,
      readEvidence: readBoundedEvidenceFile,
      now: Date.now,
    });
    process.stdout.write(`${await runExecutionReadinessCommand(service, abort.signal)}\n`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await database?.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch(() => {
    process.stderr.write('EXECUTION_READINESS_FAILED\n');
    process.exitCode = 1;
  });
}

