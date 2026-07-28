import type { TokenSessionStatus } from './types.js';

const TERMINAL_STATUSES = new Set<TokenSessionStatus>([
  'CLOSED',
  'REJECTED',
  'EXPIRED',
  'ORPHANED',
]);

const OPEN_POSITION_STATUSES = new Set<TokenSessionStatus>([
  'BUY_PENDING',
  'HOLDING',
  'SELL_PENDING',
  'MANUAL_REVIEW',
]);

export function isTerminalStatus(status: TokenSessionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function hasOpenPosition(status: TokenSessionStatus): boolean {
  return OPEN_POSITION_STATUSES.has(status);
}
