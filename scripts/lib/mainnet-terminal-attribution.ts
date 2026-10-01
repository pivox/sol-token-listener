import { Buffer } from 'node:buffer';
import bs58 from 'bs58';
import {
  PUMP_WIRE_IDL_NAMES,
  TERMINAL_ATTRIBUTION_CAUSE_KINDS,
  TERMINAL_DIAGNOSTIC_CODES,
  type PumpWireAttributionV1,
  type TerminalAttributionCauseKind,
  type TerminalDiagnosticCode,
} from '../../src/domain/terminal-attribution.js';
import {
  OBSERVED_PIPELINE_ORIGIN_CODES,
  OBSERVED_PIPELINE_STAGES,
  type ObservedPipelineOriginCode,
  type ObservedPipelineStage,
} from '../../src/domain/observed-pipeline-taxonomy.js';

export const MAINNET_TERMINAL_ATTRIBUTION_MAX_GROUPS = 128;
export const MAINNET_TERMINAL_ATTRIBUTION_MAX_BYTES = 1_048_576;

const CATCH_UP_REASON_CODES = Object.freeze([
  'PUMP_ACTION_SUPPORTED', 'PUMP_TRADE_UNTRACKED', 'SOLANA_TRANSACTION_FAILED',
  'NO_SUPPORTED_PUMP_ACTION', 'PUMP_SCHEMA_UNSUPPORTED', 'PROVIDER_SIGNATURE_MISSING',
] as const);
const CONFIRMATION_STATUSES = Object.freeze([
  'processed', 'confirmed', 'finalized', 'orphaned',
] as const);
const CURRENT_ERROR_NAMES = Object.freeze([
  'LEGACY_RPC_ERROR', 'LEGACY_LEASE_EXPIRED', 'LEGACY_OTHER', 'UNAVAILABLE',
] as const);
const observedStages = new Set<string>(OBSERVED_PIPELINE_STAGES);
const observedOrigins = new Set<string>(OBSERVED_PIPELINE_ORIGIN_CODES);
const diagnosticCodes = new Set<string>(TERMINAL_DIAGNOSTIC_CODES);
const causeKinds = new Set<string>(TERMINAL_ATTRIBUTION_CAUSE_KINDS);
const pumpIdlNames = new Set<string>(PUMP_WIRE_IDL_NAMES);
const catchUpReasonCodes = new Set<string>(CATCH_UP_REASON_CODES);
const confirmationStatuses = new Set<string>(CONFIRMATION_STATUSES);

type CurrentStatus = 'FAILED' | 'QUARANTINED';
type FailureState = 'TERMINAL' | 'RETRY_PENDING';
type NormalizedErrorName = string;

export interface MainnetTerminalCurrentPopulationGroupV1 {
  readonly processingStatus: CurrentStatus;
  readonly normalizedErrorName: NormalizedErrorName;
  readonly retryable: boolean | null;
  readonly failureState: FailureState;
  readonly attempts: number;
  readonly attemptsInCycle: number;
  readonly catchUpReasonCode: string | null;
  readonly count: number;
}

export interface MainnetTerminalRepresentativeV1 {
  readonly signature: string;
  readonly slot: number;
  readonly transactionIndex: number | null;
  readonly confirmationStatus: (typeof CONFIRMATION_STATUSES)[number];
  readonly instructionIndex: number | null;
  readonly innerInstructionIndex: number | null;
}

export interface MainnetTerminalDiagnosticGroupV1 {
  readonly source: 'WORKER' | 'CATCH_UP';
  readonly processingOutcome: CurrentStatus;
  readonly workerCycleAttempt: number | null;
  readonly workerRecoveryCount: number | null;
  readonly retryable: boolean | null;
  readonly retryExhausted: boolean | null;
  readonly stage: ObservedPipelineStage | 'unclassified' | null;
  readonly originCode: ObservedPipelineOriginCode | null;
  readonly diagnosticCode: TerminalDiagnosticCode;
  readonly catchUpCauseKind: TerminalAttributionCauseKind | null;
  readonly catchUpReasonCode: string | null;
  readonly completeness: 'COMPLETE' | 'UNAVAILABLE';
  readonly pumpWire: PumpWireAttributionV1 | null;
  readonly count: number;
  readonly representative: MainnetTerminalRepresentativeV1 | null;
}

export interface MainnetTerminalAttributionV1 {
  readonly schemaVersion: 'mainnet-terminal-attribution.v1';
  readonly currentPopulation: Readonly<{
    totalRows: number;
    retainedRows: number;
    unavailableRows: number;
    overflow: Readonly<{ groupCount: number; rowCount: number }>;
    groups: readonly MainnetTerminalCurrentPopulationGroupV1[];
  }>;
  readonly diagnosticOccurrences: Readonly<{
    totalOccurrences: number;
    retainedOccurrences: number;
    unavailableOccurrences: number;
    overflow: Readonly<{ groupCount: number; occurrenceCount: number }>;
    groups: readonly MainnetTerminalDiagnosticGroupV1[];
  }>;
  readonly incompleteAttribution: Readonly<{
    parentRows: number;
    missingOccurrences: number;
  }>;
}

export interface MainnetTerminalAttributionBuildInput {
  readonly currentPopulationRows: readonly unknown[];
  readonly diagnosticOccurrenceRows: readonly unknown[];
  readonly incompleteAttributionRows: readonly unknown[];
}

export function buildMainnetTerminalAttribution(
  input: MainnetTerminalAttributionBuildInput,
): MainnetTerminalAttributionV1 {
  const currentGroups = coalesceCurrentGroups(input.currentPopulationRows.map(parseCurrentRow));
  const diagnosticGroups = coalesceDiagnosticGroups(
    input.diagnosticOccurrenceRows.map(parseDiagnosticRow),
  );
  const incomplete = parseIncompleteRows(input.incompleteAttributionRows);
  const retainedCurrent = currentGroups.slice(0, MAINNET_TERMINAL_ATTRIBUTION_MAX_GROUPS);
  const overflowCurrent = currentGroups.slice(MAINNET_TERMINAL_ATTRIBUTION_MAX_GROUPS);
  const retainedDiagnostics = diagnosticGroups.slice(0, MAINNET_TERMINAL_ATTRIBUTION_MAX_GROUPS);
  const overflowDiagnostics = diagnosticGroups.slice(MAINNET_TERMINAL_ATTRIBUTION_MAX_GROUPS);
  const totalRows = sumCounts(currentGroups);
  const retainedRows = sumCounts(retainedCurrent);
  const totalOccurrences = sumCounts(diagnosticGroups);
  const retainedOccurrences = sumCounts(retainedDiagnostics);

  const artifact: MainnetTerminalAttributionV1 = Object.freeze({
    schemaVersion: 'mainnet-terminal-attribution.v1',
    currentPopulation: Object.freeze({
      totalRows,
      retainedRows,
      unavailableRows: sumCounts(currentGroups.filter(isCurrentUnavailable)),
      overflow: Object.freeze({
        groupCount: overflowCurrent.length,
        rowCount: sumCounts(overflowCurrent),
      }),
      groups: Object.freeze(retainedCurrent),
    }),
    diagnosticOccurrences: Object.freeze({
      totalOccurrences,
      retainedOccurrences,
      unavailableOccurrences: sumCounts(
        diagnosticGroups.filter((group) => group.completeness === 'UNAVAILABLE'
          || group.diagnosticCode === 'UNAVAILABLE'),
      ),
      overflow: Object.freeze({
        groupCount: overflowDiagnostics.length,
        occurrenceCount: sumCounts(overflowDiagnostics),
      }),
      groups: Object.freeze(retainedDiagnostics),
    }),
    incompleteAttribution: incomplete,
  });
  assertArtifactSize(artifact);
  return artifact;
}

export function serializeMainnetTerminalAttribution(
  artifact: MainnetTerminalAttributionV1,
): string {
  const parsed = parseMainnetTerminalAttribution(artifact);
  const serialized = `${JSON.stringify(parsed)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAINNET_TERMINAL_ATTRIBUTION_MAX_BYTES) {
    invalidEvidence();
  }
  return serialized;
}

export function parseMainnetTerminalCurrentPopulation(
  input: unknown,
): MainnetTerminalAttributionV1['currentPopulation'] {
  const root = parseArtifactRoot(input);
  const current = exactRecord(root.currentPopulation, [
    'totalRows', 'retainedRows', 'unavailableRows', 'overflow', 'groups',
  ]);
  const currentOverflow = exactRecord(current.overflow, ['groupCount', 'rowCount']);
  const currentGroups = parseArtifactArray(
    current.groups,
    parseCurrentArtifactGroup,
  );
  const totalRows = safeInteger(current.totalRows);
  const retainedRows = safeInteger(current.retainedRows);
  const unavailableRows = safeInteger(current.unavailableRows);
  const currentOverflowGroupCount = safeInteger(currentOverflow.groupCount);
  const currentOverflowRowCount = safeInteger(currentOverflow.rowCount);
  if (retainedRows !== sumCounts(currentGroups)
    || totalRows !== checkedAdd(retainedRows, currentOverflowRowCount)
    || unavailableRows > totalRows
    || unavailableRows < sumCounts(currentGroups.filter(isCurrentUnavailable))
    || currentOverflowGroupCount > 0 !== (currentOverflowRowCount > 0)) invalidEvidence();

  assertCanonicalOrder(currentGroups, currentSortKey);
  return Object.freeze({
    totalRows,
    retainedRows,
    unavailableRows,
    overflow: Object.freeze({
      groupCount: currentOverflowGroupCount,
      rowCount: currentOverflowRowCount,
    }),
    groups: Object.freeze(currentGroups),
  });
}

export function parseMainnetTerminalDiagnosticOccurrences(
  input: unknown,
): MainnetTerminalAttributionV1['diagnosticOccurrences'] {
  const root = parseArtifactRoot(input);
  const diagnostics = exactRecord(root.diagnosticOccurrences, [
    'totalOccurrences', 'retainedOccurrences', 'unavailableOccurrences', 'overflow', 'groups',
  ]);
  const diagnosticsOverflow = exactRecord(
    diagnostics.overflow,
    ['groupCount', 'occurrenceCount'],
  );
  const diagnosticGroups = parseArtifactArray(
    diagnostics.groups,
    parseDiagnosticArtifactGroup,
  );
  const totalOccurrences = safeInteger(diagnostics.totalOccurrences);
  const retainedOccurrences = safeInteger(diagnostics.retainedOccurrences);
  const unavailableOccurrences = safeInteger(diagnostics.unavailableOccurrences);
  const diagnosticOverflowGroupCount = safeInteger(diagnosticsOverflow.groupCount);
  const diagnosticOverflowOccurrenceCount = safeInteger(diagnosticsOverflow.occurrenceCount);
  if (retainedOccurrences !== sumCounts(diagnosticGroups)
    || totalOccurrences !== checkedAdd(retainedOccurrences, diagnosticOverflowOccurrenceCount)
    || unavailableOccurrences > totalOccurrences
    || unavailableOccurrences < sumCounts(diagnosticGroups.filter(
      (group) => group.completeness === 'UNAVAILABLE'
        || group.diagnosticCode === 'UNAVAILABLE',
    ))
    || diagnosticOverflowGroupCount > 0 !== (diagnosticOverflowOccurrenceCount > 0)) {
    invalidEvidence();
  }
  assertCanonicalOrder(diagnosticGroups, diagnosticSortKey);
  return Object.freeze({
    totalOccurrences,
    retainedOccurrences,
    unavailableOccurrences,
    overflow: Object.freeze({
      groupCount: diagnosticOverflowGroupCount,
      occurrenceCount: diagnosticOverflowOccurrenceCount,
    }),
    groups: Object.freeze(diagnosticGroups),
  });
}

export function parseMainnetTerminalIncompleteAttribution(
  input: unknown,
): MainnetTerminalAttributionV1['incompleteAttribution'] {
  const root = parseArtifactRoot(input);
  const incomplete = exactRecord(root.incompleteAttribution, ['parentRows', 'missingOccurrences']);
  const parentRows = safeInteger(incomplete.parentRows);
  const missingOccurrences = safeInteger(incomplete.missingOccurrences);
  if ((parentRows === 0) !== (missingOccurrences === 0)
    || missingOccurrences < parentRows) invalidEvidence();
  return Object.freeze({ parentRows, missingOccurrences });
}

export function parseMainnetTerminalAttribution(input: unknown): MainnetTerminalAttributionV1 {
  const artifact: MainnetTerminalAttributionV1 = Object.freeze({
    schemaVersion: 'mainnet-terminal-attribution.v1',
    currentPopulation: parseMainnetTerminalCurrentPopulation(input),
    diagnosticOccurrences: parseMainnetTerminalDiagnosticOccurrences(input),
    incompleteAttribution: parseMainnetTerminalIncompleteAttribution(input),
  });
  assertArtifactSize(artifact);
  return artifact;
}

function parseArtifactRoot(input: unknown): Readonly<Record<string, unknown>> {
  const root = exactRecord(input, [
    'schemaVersion', 'currentPopulation', 'diagnosticOccurrences', 'incompleteAttribution',
  ]);
  if (root.schemaVersion !== 'mainnet-terminal-attribution.v1') invalidEvidence();
  return root;
}

function parseCurrentRow(input: unknown): MainnetTerminalCurrentPopulationGroupV1 {
  const row = looseRecord(input);
  return createCurrentGroup({
    processingStatus: row.processing_status,
    normalizedErrorName: normalizeCurrentErrorName(row.error_name),
    retryable: row.error_retryable,
    failureState: row.failure_state,
    attempts: row.attempts,
    attemptsInCycle: row.attempts_in_cycle,
    catchUpReasonCode: normalizeCatchUpReason(row.catch_up_reason_code),
    count: row.row_count,
  });
}

function parseCurrentArtifactGroup(input: unknown): MainnetTerminalCurrentPopulationGroupV1 {
  const row = exactRecord(input, [
    'processingStatus', 'normalizedErrorName', 'retryable', 'failureState', 'attempts',
    'attemptsInCycle', 'catchUpReasonCode', 'count',
  ]);
  return createCurrentGroup(row);
}

function createCurrentGroup(
  row: Readonly<Record<string, unknown>>,
): MainnetTerminalCurrentPopulationGroupV1 {
  const processingStatus = row.processingStatus;
  const retryable = row.retryable;
  const failureState = row.failureState;
  const attempts = safeInteger(row.attempts);
  const attemptsInCycle = safeInteger(row.attemptsInCycle);
  const count = positiveSafeInteger(row.count);
  const normalizedErrorName = parseNormalizedCurrentErrorName(row.normalizedErrorName);
  const catchUpReasonCode = parseNormalizedCatchUpReason(row.catchUpReasonCode);
  if ((processingStatus !== 'FAILED' && processingStatus !== 'QUARANTINED')
    || attemptsInCycle > attempts
    || (failureState !== 'TERMINAL' && failureState !== 'RETRY_PENDING')) invalidEvidence();
  if (processingStatus === 'FAILED') {
    // Classification provenance survives worker claims and failures; it is not
    // restricted to quarantined rows. The bounded reason parser still applies.
    if (typeof retryable !== 'boolean'
      || (failureState === 'RETRY_PENDING' && !retryable)
      || normalizedErrorName === 'UNAVAILABLE'
      || (validObservedErrorName(normalizedErrorName)
        && retryable !== normalizedErrorName.endsWith('.UNKNOWN'))) invalidEvidence();
  } else if (retryable !== null || failureState !== 'TERMINAL'
    || normalizedErrorName !== 'UNAVAILABLE' || catchUpReasonCode === null
    || attempts !== 0 || attemptsInCycle !== 0) invalidEvidence();
  const group = Object.freeze({
    processingStatus,
    normalizedErrorName,
    retryable,
    failureState,
    attempts,
    attemptsInCycle,
    catchUpReasonCode,
    count,
  }) as MainnetTerminalCurrentPopulationGroupV1;
  return group;
}

function parseDiagnosticRow(input: unknown): MainnetTerminalDiagnosticGroupV1 {
  const row = looseRecord(input);
  return createDiagnosticGroup({
    source: row.source,
    processingOutcome: row.processing_outcome,
    workerCycleAttempt: row.worker_cycle_attempt,
    workerRecoveryCount: row.worker_recovery_count,
    retryable: row.retryable,
    retryExhausted: row.retry_exhausted,
    stage: row.stage,
    originCode: row.origin,
    diagnosticCode: row.diagnostic_code,
    catchUpCauseKind: row.catch_up_cause_kind,
    catchUpReasonCode: normalizeCatchUpReason(row.catch_up_reason_code),
    completeness: row.completeness,
    pumpWire: nullablePumpWireFromRow(row),
    count: row.occurrence_count,
    representative: nullableRepresentativeFromRow(row),
  });
}

function parseDiagnosticArtifactGroup(input: unknown): MainnetTerminalDiagnosticGroupV1 {
  const row = exactRecord(input, [
    'source', 'processingOutcome', 'workerCycleAttempt', 'workerRecoveryCount', 'retryable',
    'retryExhausted', 'stage', 'originCode', 'diagnosticCode', 'catchUpCauseKind',
    'catchUpReasonCode', 'completeness', 'pumpWire', 'count', 'representative',
  ]);
  return createDiagnosticGroup(row);
}

function createDiagnosticGroup(
  row: Readonly<Record<string, unknown>>,
): MainnetTerminalDiagnosticGroupV1 {
  const source = row.source;
  const processingOutcome = row.processingOutcome;
  const workerCycleAttempt = nullableSafeInteger(row.workerCycleAttempt);
  const workerRecoveryCount = nullableSafeInteger(row.workerRecoveryCount);
  const retryable = row.retryable;
  const retryExhausted = row.retryExhausted;
  const stage = nullableDiagnosticStage(row.stage);
  const originCode = nullableClosedString(row.originCode, observedOrigins);
  const diagnosticCode = closedString(row.diagnosticCode, diagnosticCodes) as TerminalDiagnosticCode;
  const catchUpCauseKind = nullableClosedString(row.catchUpCauseKind, causeKinds) as
    TerminalAttributionCauseKind | null;
  const catchUpReasonCode = parseNormalizedCatchUpReason(row.catchUpReasonCode);
  const completeness = row.completeness;
  const pumpWire = parseNullablePumpWire(row.pumpWire);
  const representative = parseNullableRepresentative(row.representative);
  const count = positiveSafeInteger(row.count);
  if ((source !== 'WORKER' && source !== 'CATCH_UP')
    || (processingOutcome !== 'FAILED' && processingOutcome !== 'QUARANTINED')
    || (completeness !== 'COMPLETE' && completeness !== 'UNAVAILABLE')) invalidEvidence();
  if (source === 'WORKER') {
    if (processingOutcome !== 'FAILED' || workerCycleAttempt === null
      || workerRecoveryCount === null || typeof retryable !== 'boolean'
      || typeof retryExhausted !== 'boolean'
      || catchUpCauseKind !== null || catchUpReasonCode !== null) {
      invalidEvidence();
    }
  } else if (processingOutcome !== 'QUARANTINED'
    || workerCycleAttempt !== null || workerRecoveryCount !== null || retryable !== null
    || retryExhausted !== null || catchUpReasonCode === null) {
    invalidEvidence();
  }
  if (source === 'CATCH_UP' && catchUpCauseKind === null
    && (completeness !== 'UNAVAILABLE' || diagnosticCode !== 'UNAVAILABLE'
      || stage !== null || originCode !== null || pumpWire !== null || representative !== null)) {
    invalidEvidence();
  }
  if (source === 'CATCH_UP' && completeness === 'COMPLETE' && catchUpCauseKind === null) {
    invalidEvidence();
  }
  if (diagnosticCode.startsWith('QUALIFICATION_')
    && (source !== 'WORKER' || processingOutcome !== 'FAILED' || stage !== 'qualification'
      || catchUpCauseKind !== null || catchUpReasonCode !== null
      || pumpWire !== null || representative !== null)) invalidEvidence();
  if (diagnosticCode === 'PUMP_BORSH_INVALID') {
    if ((source === 'CATCH_UP' && catchUpCauseKind !== 'PUMP_DECODER')
      || (originCode !== null && originCode !== 'PUMP_BORSH_INVALID')
      || completeness !== 'COMPLETE' || pumpWire === null || representative === null) {
      invalidEvidence();
    }
    if (representative.transactionIndex === null || representative.instructionIndex === null
      || (pumpWire.location === 'OUTER' && representative.innerInstructionIndex !== null)
      || (pumpWire.location === 'INNER' && representative.innerInstructionIndex === null)) {
      invalidEvidence();
    }
  } else if (pumpWire !== null || representative !== null) invalidEvidence();
  return Object.freeze({
    source,
    processingOutcome,
    workerCycleAttempt,
    workerRecoveryCount,
    retryable,
    retryExhausted,
    stage,
    originCode: originCode as ObservedPipelineOriginCode | null,
    diagnosticCode,
    catchUpCauseKind,
    catchUpReasonCode,
    completeness,
    pumpWire,
    count,
    representative,
  });
}

function nullablePumpWireFromRow(row: Readonly<Record<string, unknown>>): unknown {
  const values = [
    row.wire_surface, row.wire_location, row.wire_discriminator, row.wire_idl_name,
    row.wire_total_bytes, row.wire_payload_bytes, row.wire_suffix_bytes,
  ];
  if (values.every((value) => value === null)) return null;
  return {
    surface: row.wire_surface,
    location: row.wire_location,
    discriminatorHex: row.wire_discriminator,
    idlName: row.wire_idl_name,
    totalBytes: row.wire_total_bytes,
    payloadBytes: row.wire_payload_bytes,
    suffixBytes: row.wire_suffix_bytes,
  };
}

function parseNullablePumpWire(input: unknown): PumpWireAttributionV1 | null {
  if (input === null) return null;
  const wire = exactRecord(input, [
    'surface', 'location', 'discriminatorHex', 'idlName', 'totalBytes', 'payloadBytes',
    'suffixBytes',
  ]);
  const totalBytes = safeInteger(wire.totalBytes);
  const payloadBytes = safeInteger(wire.payloadBytes);
  const suffixBytes = nullableSafeInteger(wire.suffixBytes);
  if ((wire.surface !== 'INSTRUCTION' && wire.surface !== 'CPI_EVENT')
    || (wire.location !== 'OUTER' && wire.location !== 'INNER')
    || typeof wire.discriminatorHex !== 'string'
    || !/^[0-9a-f]{16}$/u.test(wire.discriminatorHex)
    || typeof wire.idlName !== 'string' || !pumpIdlNames.has(wire.idlName)
    || totalBytes > 1_232 || payloadBytes > 1_232 || (suffixBytes !== null && suffixBytes > 1_232)
    || payloadBytes !== totalBytes - (wire.surface === 'INSTRUCTION' ? 8 : 16)
    || (suffixBytes !== null && suffixBytes > payloadBytes)) invalidEvidence();
  return Object.freeze({
    surface: wire.surface,
    location: wire.location,
    discriminatorHex: wire.discriminatorHex,
    idlName: wire.idlName,
    totalBytes,
    payloadBytes,
    suffixBytes,
  });
}

function nullableRepresentativeFromRow(row: Readonly<Record<string, unknown>>): unknown {
  const values = [
    row.representative_signature, row.representative_slot,
    row.representative_transaction_index, row.representative_confirmation_status,
    row.representative_instruction_index, row.representative_inner_instruction_index,
  ];
  if (values.every((value) => value === null)) return null;
  return {
    signature: row.representative_signature,
    slot: row.representative_slot,
    transactionIndex: row.representative_transaction_index,
    confirmationStatus: row.representative_confirmation_status,
    instructionIndex: row.representative_instruction_index,
    innerInstructionIndex: row.representative_inner_instruction_index,
  };
}

function parseNullableRepresentative(input: unknown): MainnetTerminalRepresentativeV1 | null {
  if (input === null) return null;
  const value = exactRecord(input, [
    'signature', 'slot', 'transactionIndex', 'confirmationStatus', 'instructionIndex',
    'innerInstructionIndex',
  ]);
  const slot = safeInteger(value.slot);
  const transactionIndex = nullableSafeInteger(value.transactionIndex);
  const instructionIndex = nullableSafeInteger(value.instructionIndex);
  const innerInstructionIndex = nullableSafeInteger(value.innerInstructionIndex);
  if (typeof value.signature !== 'string' || value.signature.length === 0
    || value.signature.trim() !== value.signature
    || Buffer.byteLength(value.signature, 'utf8') > 128
    || !isCanonicalSolanaSignature(value.signature)
    || typeof value.confirmationStatus !== 'string'
    || !confirmationStatuses.has(value.confirmationStatus)
    || (instructionIndex === null && innerInstructionIndex !== null)) invalidEvidence();
  return Object.freeze({
    signature: value.signature,
    slot,
    transactionIndex,
    confirmationStatus: value.confirmationStatus as MainnetTerminalRepresentativeV1['confirmationStatus'],
    instructionIndex,
    innerInstructionIndex,
  });
}

function coalesceCurrentGroups(
  groups: readonly MainnetTerminalCurrentPopulationGroupV1[],
): MainnetTerminalCurrentPopulationGroupV1[] {
  const byKey = new Map<string, MainnetTerminalCurrentPopulationGroupV1>();
  for (const group of groups) {
    const key = currentSortKey(group);
    const prior = byKey.get(key);
    byKey.set(key, prior === undefined ? group : Object.freeze({
      ...prior,
      count: checkedAdd(prior.count, group.count),
    }));
  }
  return [...byKey.values()].sort((left, right) => bytewise(currentSortKey(left), currentSortKey(right)));
}

function coalesceDiagnosticGroups(
  groups: readonly MainnetTerminalDiagnosticGroupV1[],
): MainnetTerminalDiagnosticGroupV1[] {
  const byKey = new Map<string, MainnetTerminalDiagnosticGroupV1>();
  for (const group of groups) {
    const key = diagnosticSortKey(group);
    const prior = byKey.get(key);
    if (prior === undefined) {
      byKey.set(key, group);
      continue;
    }
    const representative = minimumRepresentative(prior.representative, group.representative);
    byKey.set(key, Object.freeze({
      ...prior,
      count: checkedAdd(prior.count, group.count),
      representative,
    }));
  }
  return [...byKey.values()].sort(
    (left, right) => bytewise(diagnosticSortKey(left), diagnosticSortKey(right)),
  );
}

function currentSortKey(group: MainnetTerminalCurrentPopulationGroupV1): string {
  return tuple([
    group.processingStatus, group.normalizedErrorName, nullableBoolean(group.retryable),
    group.failureState, sortableInteger(group.attempts), sortableInteger(group.attemptsInCycle),
    group.catchUpReasonCode ?? '',
  ]);
}

function diagnosticSortKey(group: MainnetTerminalDiagnosticGroupV1): string {
  return tuple([
    group.source, group.processingOutcome, nullableInteger(group.workerCycleAttempt),
    nullableInteger(group.workerRecoveryCount), nullableBoolean(group.retryable),
    nullableBoolean(group.retryExhausted), group.stage ?? '', group.originCode ?? '',
    group.diagnosticCode, group.catchUpCauseKind ?? '', group.catchUpReasonCode ?? '',
    group.completeness,
    group.pumpWire === null ? '' : tuple([
      group.pumpWire.surface, group.pumpWire.location, group.pumpWire.discriminatorHex,
      group.pumpWire.idlName, sortableInteger(group.pumpWire.totalBytes),
      sortableInteger(group.pumpWire.payloadBytes), nullableInteger(group.pumpWire.suffixBytes),
    ]),
  ]);
}

function representativeSortKey(value: MainnetTerminalRepresentativeV1): string {
  return tuple([
    value.signature, sortableInteger(value.slot), nullableInteger(value.transactionIndex),
    value.confirmationStatus, nullableInteger(value.instructionIndex),
    nullableInteger(value.innerInstructionIndex),
  ]);
}

function minimumRepresentative(
  left: MainnetTerminalRepresentativeV1 | null,
  right: MainnetTerminalRepresentativeV1 | null,
): MainnetTerminalRepresentativeV1 | null {
  if (left === null) return right;
  if (right === null) return left;
  return bytewise(representativeSortKey(left), representativeSortKey(right)) <= 0 ? left : right;
}

function parseIncompleteRows(rows: readonly unknown[]): Readonly<{
  parentRows: number;
  missingOccurrences: number;
}> {
  if (rows.length !== 1) invalidEvidence();
  const row = looseRecord(rows[0]);
  const parentRows = safeInteger(row.parent_count);
  const missingOccurrences = safeInteger(row.incomplete_count);
  if ((parentRows === 0) !== (missingOccurrences === 0)
    || missingOccurrences < parentRows) invalidEvidence();
  return Object.freeze({ parentRows, missingOccurrences });
}

function normalizeCurrentErrorName(value: unknown): NormalizedErrorName {
  if (value === null) return 'UNAVAILABLE';
  if (typeof value !== 'string' || value.length === 0) return 'LEGACY_OTHER';
  if (validObservedErrorName(value)) return value;
  if (value === 'RpcError' || value === 'RpcTransientError' || value === 'TransientFailure') {
    return 'LEGACY_RPC_ERROR';
  }
  if (value === 'TransactionInboxLeaseExpired') return 'LEGACY_LEASE_EXPIRED';
  return 'LEGACY_OTHER';
}

function parseNormalizedCurrentErrorName(value: unknown): NormalizedErrorName {
  if (typeof value !== 'string') invalidEvidence();
  if ((CURRENT_ERROR_NAMES as readonly string[]).includes(value) || validObservedErrorName(value)) {
    return value;
  }
  invalidEvidence();
}

function validObservedErrorName(value: string): boolean {
  const [name, version, stage, origin, extra] = value.split('.');
  return name === 'ObservedPipelineFailure' && version === 'v1' && extra === undefined
    && stage !== undefined && origin !== undefined
    && ((stage === 'unclassified' && origin === 'UNKNOWN')
      || (observedStages.has(stage) && observedOrigins.has(origin)));
}

function isCanonicalSolanaSignature(value: string): boolean {
  try {
    const decoded = bs58.decode(value);
    return decoded.length === 64 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}

function normalizeCatchUpReason(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === 'string' && catchUpReasonCodes.has(value) ? value : 'UNAVAILABLE';
}

function parseNormalizedCatchUpReason(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && (catchUpReasonCodes.has(value) || value === 'UNAVAILABLE')) {
    return value;
  }
  invalidEvidence();
}

function isCurrentUnavailable(group: MainnetTerminalCurrentPopulationGroupV1): boolean {
  return group.normalizedErrorName === 'UNAVAILABLE'
    || group.normalizedErrorName === 'LEGACY_OTHER'
    || group.catchUpReasonCode === 'UNAVAILABLE';
}

function parseArtifactArray<T>(input: unknown, parser: (value: unknown) => T): T[] {
  if (!Array.isArray(input) || input.length > MAINNET_TERMINAL_ATTRIBUTION_MAX_GROUPS) {
    invalidEvidence();
  }
  return input.map(parser);
}

function assertCanonicalOrder<T>(values: readonly T[], key: (value: T) => string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined
      || bytewise(key(previous), key(current)) >= 0) invalidEvidence();
  }
}

function sumCounts(groups: readonly { readonly count: number }[]): number {
  return groups.reduce((sum, group) => checkedAdd(sum, group.count), 0);
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) invalidEvidence();
  return result;
}

function safeInteger(value: unknown): number {
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
    || Object.is(value, -0)) invalidEvidence();
  return value;
}

function positiveSafeInteger(value: unknown): number {
  const parsed = safeInteger(value);
  if (parsed === 0) invalidEvidence();
  return parsed;
}

function nullableSafeInteger(value: unknown): number | null {
  return value === null ? null : safeInteger(value);
}

function closedString(value: unknown, allowed: ReadonlySet<string>): string {
  if (typeof value !== 'string' || !allowed.has(value)) invalidEvidence();
  return value;
}

function nullableClosedString(value: unknown, allowed: ReadonlySet<string>): string | null {
  return value === null ? null : closedString(value, allowed);
}

function nullableDiagnosticStage(value: unknown): ObservedPipelineStage | 'unclassified' | null {
  if (value === null || value === 'unclassified') return value;
  return closedString(value, observedStages) as ObservedPipelineStage;
}

function looseRecord(input: unknown): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalidEvidence();
  return input as Readonly<Record<string, unknown>>;
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  const value = looseRecord(input);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) invalidEvidence();
  return value;
}

function tuple(values: readonly string[]): string {
  return values.join('\u0000');
}

function sortableInteger(value: number): string {
  return value.toString().padStart(16, '0');
}

function nullableInteger(value: number | null): string {
  return value === null ? '' : sortableInteger(value);
}

function nullableBoolean(value: boolean | null): string {
  return value === null ? '' : value ? '1' : '0';
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertArtifactSize(artifact: MainnetTerminalAttributionV1): void {
  const bytes = Buffer.byteLength(`${JSON.stringify(artifact)}\n`, 'utf8');
  if (bytes > MAINNET_TERMINAL_ATTRIBUTION_MAX_BYTES) invalidEvidence();
}

function invalidEvidence(): never {
  throw new TypeError('Invalid mainnet terminal attribution evidence.');
}
