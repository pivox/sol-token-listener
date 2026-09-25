export type MainnetObserveCanaryVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export const MAINNET_OBSERVE_CANARY_GATE_NAMES = [
  'runtime',
  'http429',
  'backlog',
  'terminalFailures',
  'idempotence',
  'retention',
  'decoderQuarantine',
  'firstProcessing',
  'blockHydration',
  'catchUpAdmission',
  'providerAffinity',
  'rss',
  'pumpswap',
  'finality',
  'versionsAndFreshReplay',
  'shutdown',
  'cleanup',
] as const;

export type MainnetObserveCanaryGateName =
  (typeof MAINNET_OBSERVE_CANARY_GATE_NAMES)[number];

export interface MainnetObserveCanaryGateResultV1 {
  readonly verdict: MainnetObserveCanaryVerdict;
  readonly reasonCode: string;
}

export interface MainnetObserveCanaryResultV1 {
  readonly schemaVersion: 'mainnet-observe-canary-result.v1';
  readonly commit: string | null;
  readonly overallVerdict: MainnetObserveCanaryVerdict;
  readonly gates: Readonly<Record<MainnetObserveCanaryGateName,
  MainnetObserveCanaryGateResultV1>>;
}

export function evaluateMainnetObserveCanary(
  _input: unknown,
): MainnetObserveCanaryResultV1 {
  throw new TypeError('Mainnet observe canary evidence is invalid.');
}
