import { isProxy } from 'node:util/types';
import {
  snapshotScannerPhaseDiagnostics,
  type ScannerPhaseDiagnosticsV1,
} from '../../src/domain/scanner-phase-diagnostics.js';

export const MAINNET_SCANNER_ATTRIBUTION_SAMPLE_NAMES = Object.freeze([
  'T0', 'T_PLUS_5', 'T_PLUS_15', 'FINAL_PRESTOP', 'STOPPED',
] as const);

export type MainnetScannerAttributionSampleName =
  (typeof MAINNET_SCANNER_ATTRIBUTION_SAMPLE_NAMES)[number];
export type MainnetScannerAttributionEvidenceStatus =
  'VALID' | 'MISSING' | 'MALFORMED' | 'OVERFLOW';

export interface MainnetScannerAttributionSampleV1 {
  readonly name: MainnetScannerAttributionSampleName;
  readonly status: MainnetScannerAttributionEvidenceStatus;
  readonly diagnostics: ScannerPhaseDiagnosticsV1 | null;
}

export interface MainnetScannerAttributionV1 {
  readonly schemaVersion: 'mainnet-scanner-attribution.v1';
  readonly samples: readonly MainnetScannerAttributionSampleV1[];
}

export function buildMainnetScannerAttribution(input: unknown): MainnetScannerAttributionV1 {
  const safeInput = isRecord(input) ? input : null;
  const samples = MAINNET_SCANNER_ATTRIBUTION_SAMPLE_NAMES.map((name) => {
    let value: unknown;
    try {
      if (safeInput === null) return sample(name, 'MALFORMED', null);
      const descriptor = Object.getOwnPropertyDescriptor(safeInput, name);
      if (descriptor === undefined) return sample(name, 'MISSING', null);
      if (!('value' in descriptor)) return sample(name, 'MALFORMED', null);
      value = descriptor.value;
      if (value === undefined || value === null) return sample(name, 'MISSING', null);
      const diagnostics = snapshotScannerPhaseDiagnostics(value);
      if (diagnostics.unavailable) return sample(name, 'MISSING', null);
      return sample(name, diagnostics.overflow ? 'OVERFLOW' : 'VALID', diagnostics);
    } catch {
      return sample(name, 'MALFORMED', null);
    }
  });
  return Object.freeze({
    schemaVersion: 'mainnet-scanner-attribution.v1',
    samples: Object.freeze(samples),
  });
}

function sample(
  name: MainnetScannerAttributionSampleName,
  status: MainnetScannerAttributionEvidenceStatus,
  diagnostics: ScannerPhaseDiagnosticsV1 | null,
): MainnetScannerAttributionSampleV1 {
  return Object.freeze({ name, status, diagnostics });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isProxy(value);
}
