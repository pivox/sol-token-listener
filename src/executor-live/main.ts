import type { ExecutionTransactionSigner } from '../ports/execution-transaction-signer.js';
import {
  runLiveExecutorRuntime,
  type LiveExecutorLanes,
  type LiveExecutorRuntimeDependencies,
  type LiveExecutorRuntimeOptions,
} from './runtime.js';
import {
  parseLiveExecutorConfig,
  type LiveExecutorConfig,
} from './config.js';
import { loadLiveTransactionSigner } from './keypair-loader.js';

export interface LiveExecutorDatabase {
  readonly validateSchema: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly evict: () => void | Promise<void>;
}

export interface LiveExecutorBootstrapDependencies {
  readonly parseConfig: (environment: unknown) => LiveExecutorConfig;
  readonly openDatabase: (config: LiveExecutorConfig) => Promise<LiveExecutorDatabase>;
  readonly loadSigner: (config: LiveExecutorConfig) => Promise<ExecutionTransactionSigner>;
  readonly createLanes: (input: Readonly<{
    readonly config: LiveExecutorConfig;
    readonly database: LiveExecutorDatabase;
    readonly signer: ExecutionTransactionSigner;
  }>) => LiveExecutorLanes;
  readonly runtime: (
    dependencies: LiveExecutorRuntimeDependencies,
    options: LiveExecutorRuntimeOptions,
  ) => Promise<void>;
  readonly forceExit: (code: 1) => void;
}

export async function startLiveExecutor(
  environment: unknown,
  dependencies: LiveExecutorBootstrapDependencies,
): Promise<void> {
  const config = dependencies.parseConfig(environment);
  const database = await dependencies.openDatabase(config);
  let signer: ExecutionTransactionSigner | null = null;
  let runtimeOwnsResources = false;
  try {
    await database.validateSchema();
    signer = await dependencies.loadSigner(config);
    const lanes = dependencies.createLanes(Object.freeze({ config, database, signer }));
    runtimeOwnsResources = true;
    await dependencies.runtime(Object.freeze({
      lanes,
      closeSigner: () => signer?.close() ?? Promise.resolve(),
      closeDatabase: database.close,
      evictDatabase: database.evict,
      forceExit: dependencies.forceExit,
    }), Object.freeze({
      pollMs: config.pollMs,
      shutdownGraceMs: config.shutdownGraceMs,
    }));
  } finally {
    if (!runtimeOwnsResources) {
      try { await signer?.close(); } finally { await database.close(); }
    }
  }
}

// Kept here so architecture tests can assert that config and secret handling
// stay in the isolated live graph. Production lane composition is intentionally
// absent until every required claim, read-model and RPC port is available.
export const liveExecutorFoundations = Object.freeze({
  parseConfig: parseLiveExecutorConfig,
  loadSigner: loadLiveTransactionSigner,
  runtime: runLiveExecutorRuntime,
});
