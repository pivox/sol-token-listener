import { reconcileConfirmationStatus } from '../domain/confirmation-status.js';
import {
  CatchUpSourceError,
  type CatchUpSignature,
} from '../solana/rpc/catch-up-source.js';

export type CatchUpProgramKey = 'launchpad' | 'market';

export interface CatchUpDiscoveryProgram {
  readonly key: CatchUpProgramKey;
  readonly id: string;
}

export interface CatchUpDiscoveryScan {
  readonly program: CatchUpDiscoveryProgram;
  readonly rows: readonly CatchUpSignature[];
}

export interface MergedCatchUpDiscovery extends CatchUpSignature {
  readonly programIds: readonly string[];
}

export function mergeCatchUpDiscoveries(
  scans: readonly CatchUpDiscoveryScan[],
): readonly MergedCatchUpDiscovery[] {
  const bySignature = new Map<string, MergedCatchUpDiscovery>();
  for (const scan of scans) {
    for (const row of scan.rows) {
      const previous = bySignature.get(row.signature);
      if (previous === undefined) {
        bySignature.set(row.signature, Object.freeze({
          ...row,
          programIds: Object.freeze([scan.program.id]),
        }));
        continue;
      }
      const reconciled = reconcileDiscovery(previous, row, scan.program.key);
      bySignature.set(row.signature, Object.freeze({
        ...reconciled,
        programIds: Object.freeze([...previous.programIds, scan.program.id].sort(lexicalOrder)),
      }));
    }
  }
  return Object.freeze([...bySignature.values()].sort(discoveryOrder));
}

function reconcileDiscovery(
  current: CatchUpSignature,
  incoming: CatchUpSignature,
  program: CatchUpProgramKey,
): CatchUpSignature {
  if (current.slot !== incoming.slot) throw new CatchUpSourceError('response', program);
  if (current.blockTimeMs !== null
    && incoming.blockTimeMs !== null
    && current.blockTimeMs !== incoming.blockTimeMs) {
    throw new CatchUpSourceError('response', program);
  }
  const confirmationStatus = reconcileConfirmationStatus(
    current.confirmationStatus,
    incoming.confirmationStatus,
  ) === 'update' ? incoming.confirmationStatus : current.confirmationStatus;
  return Object.freeze({
    signature: current.signature,
    slot: current.slot,
    confirmationStatus,
    blockTimeMs: current.blockTimeMs ?? incoming.blockTimeMs,
  });
}

function discoveryOrder(left: MergedCatchUpDiscovery, right: MergedCatchUpDiscovery): number {
  if (left.slot !== right.slot) return left.slot < right.slot ? -1 : 1;
  const signature = lexicalOrder(left.signature, right.signature);
  if (signature !== 0) return signature;
  return lexicalOrder(left.programIds[0] ?? '', right.programIds[0] ?? '');
}

function lexicalOrder(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
