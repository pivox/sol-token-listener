import type { ExecutionTransactionSigner } from '../ports/execution-transaction-signer.js';
import { amount, evaluateObservation } from './config.js';
import { JitoBotEngine } from './engine.js';
import type { JitoRuntimeConfig } from './runtime-config.js';
import type { JitoGateway, JournalState, JournalStore } from './types.js';

export interface JitoCliDependencies {
  loadConfig(path: string): Promise<JitoRuntimeConfig>;
  readState(directory: string): Promise<JournalState | null>;
  openStore(directory: string): Promise<JournalStore & { close(): Promise<void> }>;
  loadSigner(config: JitoRuntimeConfig): Promise<ExecutionTransactionSigner>;
  makeGateway(config: JitoRuntimeConfig, signer?: ExecutionTransactionSigner): Promise<JitoGateway>;
  observeMarket(config: JitoRuntimeConfig): Promise<Record<string, unknown>>;
  emit(event: Record<string, unknown>): void;
  now(): number;
  delay(ms: number, signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
  stopRequested(config: JitoRuntimeConfig): boolean;
}

function argumentsFor(argv: string[]): { command: string; configFile: string; live: boolean } {
  const [command = 'status', ...flags] = argv;
  if (!['status', 'observe', 'preflight', 'run'].includes(command)) throw new Error('JITO_ARGUMENTS_INVALID');
  let configFile = 'config/jitosol.example.json'; let live = false; let configured = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const next = flags[i + 1];
    if (flag === '--live' && !live && command === 'run') live = true;
    else if (flag === '--config' && !configured && next && !next.startsWith('--')) {
      configFile = next; i++; configured = true;
    } else throw new Error('JITO_ARGUMENTS_INVALID');
  }
  return { command, configFile, live };
}

/** An explicit allowlist prevents signed transactions and provider error strings leaking to stdout. */
export function journalSummary(state: JournalState | null): Record<string, unknown> {
  if (!state) return { journalStatus: 'absent' };
  return {
    journalStatus: state.status, sequence: state.sequence, completedCycles: state.completedCycles,
    totalFeesLamports: state.totalFeesLamports, realizedProfitLamports: state.realizedProfitLamports,
    realizedLossLamports: state.realizedLossLamports,
    ...(state.status === 'halted' ? { recoveryRequired: true } : {}),
    ...(state.position ? {
      stage: state.position.stage,
      stakeAddress: state.position.stakeAddress ?? null,
      lockedStakeRentLamports: state.position.stakeRentLamports,
      lockedTokenAccountRentLamports: state.position.tokenAccountRentLamports,
    } : {}),
    ...(state.pending ? { pending: { kind: state.pending.kind, signature: state.pending.signature, lastValidBlockHeight: state.pending.lastValidBlockHeight } } : {}),
  };
}

export async function runJitoCli(argv: string[], deps: JitoCliDependencies): Promise<number> {
  // Read through a function: AbortSignal can change during every await.
  const aborted = (): boolean => deps.signal.aborted;
  const args = argumentsFor(argv);
  const config = await deps.loadConfig(args.configFile);
  if (args.command === 'status') {
    deps.emit({ status: 'status', enabled: config.strategy.enabled, liveFlagRequired: true, ...journalSummary(await deps.readState(config.runtime.stateDirectory)) });
    return 0;
  }
  if (args.command === 'observe') { deps.emit(await deps.observeMarket(config)); return 0; }
  if (args.command === 'preflight') {
    if (!config.strategy.walletAddress) throw new Error('JITO_PUBLIC_WALLET_REQUIRED');
    const gateway = await deps.makeGateway(config);
    const observation = await gateway.observe(config.strategy);
    const decision = evaluateObservation(observation, config.strategy, deps.now());
    deps.emit({ status: 'preflight', ...decision, walletAddress: observation.wallet.address, liquidSolLamports: observation.wallet.solLamports, withdrawalAvailable: observation.withdrawal.available, signed: false, broadcast: false });
    return decision.eligible ? 0 : 2;
  }
  // Keep this gate before journals, credentials, signer construction and all network ports.
  if (!config.strategy.enabled || !args.live) {
    deps.emit({ status: 'disabled', reason: 'Enable the configuration and pass --live to execute.' }); return 0;
  }
  if (!config.runtime.keypairPath || amount(config.strategy.maxTotalFeesLamports) < amount(config.strategy.networkBudgetLamports)) throw new Error('JITO_LIVE_CONFIGURATION_INCOMPLETE');
  if (aborted() || deps.stopRequested(config)) { deps.emit({ status: 'paused', reason: 'Stop requested before execution.' }); return 0; }
  const store = await deps.openStore(config.runtime.stateDirectory);
  let signer: ExecutionTransactionSigner | undefined;
  try {
    signer = await deps.loadSigner(config);
    const gateway = await deps.makeGateway(config, signer);
    const engine = new JitoBotEngine({ config: config.strategy, store, gateway, now: (): number => deps.now(), stopRequested: (): boolean => aborted() || deps.stopRequested(config) });
    const deadline = deps.now() + config.runtime.maxRuntimeSeconds * 1000;
    while (!aborted() && deps.now() < deadline) {
      const result = await engine.tick();
      // Reasons originate in adapters but may contain an RPC failure. Keep raw diagnostics in the private journal.
      deps.emit({ status: result.status, ...journalSummary(result.state ?? null) });
      if (result.status === 'complete' || result.status === 'paused' || result.status === 'disabled') return 0;
      if (result.status === 'halted') return 2;
      if (aborted()) break;
      const interval = result.state?.position?.stage === 'deactivated' && !result.state.pending ? config.runtime.claimPollIntervalMs : config.runtime.pollIntervalMs;
      await deps.delay(Math.min(interval, Math.max(0, deadline - deps.now())), deps.signal);
    }
    deps.emit({ status: 'paused', reason: aborted() ? 'Process stop requested; resume with the same journal.' : 'Runtime limit reached; resume with the same journal.' });
    return 0;
  } finally {
    try { await signer?.close(); } finally { await store.close(); }
  }
}
