import { pathToFileURL } from 'node:url';
import { parseLivePolicy } from '../live/live-policy.js';

export function liveConfigSummary(environment: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | number>> {
  const policy = parseLivePolicy(environment);
  return Object.freeze({
    result: 'CONFIGURATION_VALID_ONLY',
    cluster: policy.cluster,
    expectedGenesisHash: policy.expectedGenesisHash,
    expectedWallet: policy.expectedWallet,
    buyAmountLamports: policy.buyAmountLamports.toString(),
    maxExposureLamports: policy.maxExposureLamports.toString(),
    maxLossLamports: policy.maxLossLamports.toString(),
    exitReserveLamports: policy.exitReserveLamports.toString(),
    maxPriorityFeeLamports: policy.maxPriorityFeeLamports.toString(),
    maxSlippageBps: policy.maxSlippageBps,
    maxBuys: policy.maxBuys,
    maxConcurrentPositions: policy.maxConcurrentPositions,
    maxSessionSeconds: policy.maxSessionSeconds,
  });
}

export function runLiveConfigCheck(environment: Readonly<Record<string, string | undefined>>): void {
  const summary = liveConfigSummary(environment);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runLiveConfigCheck(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid live configuration.';
    process.stderr.write(`Live configuration refused: ${message}\n`);
    process.exitCode = 2;
  }
}
