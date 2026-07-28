import type { ChainConfirmationStatus } from './types.js';

export type ConfirmationReconciliation = 'keep' | 'update';

export class ConfirmationStatusConflictError extends Error {
  public constructor(
    public readonly current: ChainConfirmationStatus,
    public readonly incoming: ChainConfirmationStatus,
  ) {
    super(`Cannot reconcile confirmation status ${incoming} after ${current}`);
    this.name = 'ConfirmationStatusConflictError';
  }
}

export function reconcileConfirmationStatus(
  current: ChainConfirmationStatus,
  incoming: ChainConfirmationStatus,
): ConfirmationReconciliation {
  if (current === incoming) return 'keep';
  if (current === 'orphaned' || (current === 'finalized' && incoming === 'orphaned')) {
    throw new ConfirmationStatusConflictError(current, incoming);
  }
  if (current === 'finalized') return 'keep';
  if (incoming === 'orphaned') return 'update';
  if (current === 'processed' && (incoming === 'confirmed' || incoming === 'finalized')) {
    return 'update';
  }
  if (current === 'confirmed' && incoming === 'finalized') return 'update';
  return 'keep';
}
