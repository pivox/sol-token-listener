import { existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Connection } from '@solana/web3.js';
import { loadLiveTransactionSigner } from '../executor-live/keypair-loader.js';
import type { ExecutionTransactionSigner } from '../ports/execution-transaction-signer.js';
import { createBoundedFetch } from './bounded-fetch.js';
import { runJitoCli } from './cli.js';
import { FileJournal, readJournal } from './journal.js';
import { JupiterClient } from './jupiter.js';
import { observeMarket } from './market.js';
import { SolanaJitoGateway } from './rpc-gateway.js';
import { readJupiterApiKey, readRuntimeConfig, type JitoRuntimeConfig } from './runtime-config.js';

const controller = new AbortController();
const stop = (): void => { controller.abort(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function providers(config: JitoRuntimeConfig): Promise<{ connection: Connection; jupiter: JupiterClient }> {
  const apiKey = await readJupiterApiKey(config.runtime.jupiterApiKeyFile);
  const connection = new Connection(config.runtime.rpcUrl, {
    commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: createBoundedFetch({ timeoutMs: config.runtime.rpcTimeoutMs }),
  });
  const jupiter = new JupiterClient({ ...(apiKey ? { apiKey } : {}), timeoutMs: config.runtime.rpcTimeoutMs });
  return { connection, jupiter };
}

async function gateway(config: JitoRuntimeConfig, signer?: ExecutionTransactionSigner): Promise<SolanaJitoGateway> {
  return new SolanaJitoGateway({
    ...await providers(config), walletAddress: config.strategy.walletAddress,
    ...(signer ? { signer } : {}), liveEnabled: config.strategy.enabled && signer !== undefined,
    computeUnitLimit: config.runtime.computeUnitLimit,
    computeUnitPriceMicroLamports: BigInt(config.runtime.computeUnitPriceMicroLamports),
    maxTransactionFeeLamports: BigInt(config.runtime.maxTransactionFeeLamports),
  });
}

try {
  process.exitCode = await runJitoCli(process.argv.slice(2), {
    loadConfig: readRuntimeConfig, readState: readJournal,
    openStore: (directory) => FileJournal.open(directory),
    loadSigner: (config) => loadLiveTransactionSigner({ executorPublicKey: config.strategy.walletAddress, keypairPath: config.runtime.keypairPath }),
    makeGateway: gateway,
    observeMarket: async (config) => observeMarket({ ...await providers(config), config: config.strategy }),
    emit: (event) => { process.stdout.write(`${JSON.stringify(event)}\n`); },
    now: Date.now, signal: controller.signal,
    stopRequested: (config) => existsSync(config.strategy.stopFile),
    delay: async (ms, signal) => {
      if (signal.aborted) return;
      try { await setTimeout(ms, undefined, { signal }); }
      catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) throw error; }
    },
  });
} catch (error) {
  const safe = error instanceof Error && /^JITO_[A-Z_]+$/.test(error.message) ? error.message : 'JITO_COMMAND_FAILED';
  process.stderr.write(`${JSON.stringify({ status: 'error', code: safe, recovery: 'Inspect configuration and the private journal; never delete state to retry a transaction.' })}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
