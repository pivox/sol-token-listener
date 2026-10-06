import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createBalanceCache } from './balance-cache.js';
import { parseOperatorApiConfig } from './config.js';
import { openOperatorApiDatabase } from './database.js';
import { createLiveOverviewReader } from './repository.js';
import { createRpcBalanceReader } from './rpc-balance.js';
import { createOperatorApiHandler } from './server.js';

const ENVIRONMENT_FILE = '.env.operator';

export async function main(): Promise<void> {
  if (existsSync(ENVIRONMENT_FILE)) process.loadEnvFile(ENVIRONMENT_FILE);
  const config = parseOperatorApiConfig(process.env);
  let stop: () => void = () => undefined;
  const database = openOperatorApiDatabase({
    databaseUrl: config.databaseUrl,
    statementTimeoutMs: 10_000,
    onIdleError: () => { process.stderr.write('OPERATOR_API_DATABASE_ERROR\n'); stop(); },
  });
  // Fail fast on a drifted role instead of at the first browser request.
  (await database.source.connect()).release();
  const server = createServer(createOperatorApiHandler({
    token: config.token,
    allowedHost: `${config.host}:${String(config.port)}`,
    allowedOrigin: config.allowedOrigin,
    now: Date.now,
    overview: createLiveOverviewReader({
      database: database.source,
      balances: createBalanceCache({
        fetchLamports: createRpcBalanceReader({ rpcUrl: config.solanaHttpRpcUrl }),
        now: Date.now,
      }),
      now: Date.now,
    }),
    logError: (name) => { process.stderr.write(`OPERATOR_API_REQUEST_FAILED ${name}\n`); },
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  process.stdout.write(`OPERATOR_API_LISTENING ${config.host}:${String(config.port)}\n`);
  const closed = new Promise<void>((resolve) => {
    stop = (): void => {
      server.close(() => { resolve(); });
      server.closeAllConnections();
    };
  });
  process.once('SIGINT', () => { stop(); });
  process.once('SIGTERM', () => { stop(); });
  await closed;
  await database.close();
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void main().catch(() => {
    process.stderr.write('OPERATOR_API_FAILED\n');
    process.exitCode = 1;
  });
}
