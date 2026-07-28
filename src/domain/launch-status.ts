export const LAUNCH_STATUSES = [
  'DETECTED',
  'METADATA_PENDING',
  'METADATA_RESOLVED',
  'OBSERVING',
  'SOCIAL_CHECKING',
  'ONCHAIN_CHECKING',
  'QUALIFIED',
  'WATCHLISTED',
  'SUSPECT',
  'REJECTED',
  'PAPER_BUY_PENDING',
  'PAPER_HOLDING',
  'PAPER_SELL_PENDING',
  'PAPER_CLOSED',
  'BONDING_CURVE_COMPLETE',
  'MIGRATION_PENDING',
  'PUMPSWAP_ACTIVE',
  'EXPIRED',
  'MANUAL_REVIEW',
] as const;

export type LaunchStatus = (typeof LAUNCH_STATUSES)[number];

const TERMINAL_LAUNCH_STATUSES = new Set<LaunchStatus>([
  'REJECTED',
  'EXPIRED',
]);

export function isTerminalLaunchStatus(status: LaunchStatus): boolean {
  return TERMINAL_LAUNCH_STATUSES.has(status);
}
