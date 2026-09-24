import type { FinalityReconcilerDiagnosticV1 } from '../domain/finality-reconciler-diagnostic.js';

export interface FinalityDiagnosticLogger {
  readonly warn: (record: object, message: string) => void;
  readonly info: (record: object, message: string) => void;
}

export function createFinalityReconcilerDiagnosticSink(
  logger: FinalityDiagnosticLogger,
): (diagnostic: FinalityReconcilerDiagnosticV1) => void {
  return (diagnostic): void => {
    const record = Object.freeze({
      event: diagnostic.phase === 'DEGRADED'
        ? 'listener.finality_reconciler_degraded'
        : 'listener.finality_reconciler_recovered',
      version: diagnostic.version,
      phase: diagnostic.phase,
      reasonCode: diagnostic.reasonCode,
      degradedAtMs: diagnostic.degradedAtMs,
      observedAtMs: diagnostic.observedAtMs,
      durationMs: diagnostic.durationMs,
      consecutiveFailures: diagnostic.consecutiveFailures,
      suppressedFailures: diagnostic.suppressedFailures,
    });
    if (diagnostic.phase === 'DEGRADED') {
      logger.warn(record, 'Réconciliateur de finalité dégradé.');
      return;
    }
    logger.info(record, 'Réconciliateur de finalité rétabli.');
  };
}
