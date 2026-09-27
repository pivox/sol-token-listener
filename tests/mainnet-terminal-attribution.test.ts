import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAINNET_TERMINAL_ATTRIBUTION_MAX_BYTES,
  buildMainnetTerminalAttribution,
  parseMainnetTerminalAttribution,
  serializeMainnetTerminalAttribution,
} from '../scripts/lib/mainnet-terminal-attribution.js';

const observedBorsh =
  'ObservedPipelineFailure.v1.launchpad_observation.PUMP_BORSH_INVALID';

void test('separates every current failed/quarantined row from diagnostic occurrences', () => {
  const artifact = buildMainnetTerminalAttribution({
    currentPopulationRows: [
      currentRow({
        processing_status: 'FAILED',
        error_name: observedBorsh,
        error_retryable: false,
        failure_state: 'TERMINAL',
        attempts: 2,
        attempts_in_cycle: 2,
        catch_up_reason_code: null,
        row_count: '3',
      }),
      currentRow({
        processing_status: 'FAILED',
        error_name: 'RpcError',
        error_retryable: true,
        failure_state: 'RETRY_PENDING',
        attempts: 1,
        attempts_in_cycle: 1,
        catch_up_reason_code: null,
        row_count: '2',
      }),
      currentRow({
        processing_status: 'QUARANTINED',
        error_name: null,
        error_retryable: null,
        failure_state: 'TERMINAL',
        attempts: 0,
        attempts_in_cycle: 0,
        catch_up_reason_code: 'PUMP_SCHEMA_UNSUPPORTED',
        row_count: '5',
      }),
    ],
    diagnosticOccurrenceRows: [pumpOccurrence({ occurrence_count: '4' })],
    incompleteAttributionRows: [{ parent_count: '1', incomplete_count: '2' }],
  });

  assert.equal(artifact.schemaVersion, 'mainnet-terminal-attribution.v1');
  assert.deepEqual(artifact.currentPopulation, {
    totalRows: 10,
    retainedRows: 10,
    unavailableRows: 5,
    overflow: { groupCount: 0, rowCount: 0 },
    groups: [
      {
        processingStatus: 'FAILED',
        normalizedErrorName: 'LEGACY_RPC_ERROR',
        retryable: true,
        failureState: 'RETRY_PENDING',
        attempts: 1,
        attemptsInCycle: 1,
        catchUpReasonCode: null,
        count: 2,
      },
      {
        processingStatus: 'FAILED',
        normalizedErrorName: observedBorsh,
        retryable: false,
        failureState: 'TERMINAL',
        attempts: 2,
        attemptsInCycle: 2,
        catchUpReasonCode: null,
        count: 3,
      },
      {
        processingStatus: 'QUARANTINED',
        normalizedErrorName: 'UNAVAILABLE',
        retryable: null,
        failureState: 'TERMINAL',
        attempts: 0,
        attemptsInCycle: 0,
        catchUpReasonCode: 'PUMP_SCHEMA_UNSUPPORTED',
        count: 5,
      },
    ],
  });
  assert.equal(artifact.diagnosticOccurrences.totalOccurrences, 4);
  assert.equal(artifact.diagnosticOccurrences.retainedOccurrences, 4);
  assert.equal(artifact.diagnosticOccurrences.unavailableOccurrences, 0);
  assert.deepEqual(artifact.incompleteAttribution, {
    parentRows: 1,
    missingOccurrences: 2,
  });
  assert.equal(
    artifact.currentPopulation.retainedRows + artifact.currentPopulation.overflow.rowCount,
    artifact.currentPopulation.totalRows,
  );
  assert.equal(
    artifact.diagnosticOccurrences.retainedOccurrences
      + artifact.diagnosticOccurrences.overflow.occurrenceCount,
    artifact.diagnosticOccurrences.totalOccurrences,
  );
});

void test('maps arbitrary legacy error names and unavailable evidence without leaking text', () => {
  const secret = 'https://rpc.invalid/key?token=super-secret';
  const artifact = buildMainnetTerminalAttribution({
    currentPopulationRows: [currentRow({ error_name: secret, row_count: 7 })],
    diagnosticOccurrenceRows: [occurrence({
      diagnostic_code: 'UNAVAILABLE',
      completeness: 'UNAVAILABLE',
      occurrence_count: 6,
      representative_signature: null,
      representative_slot: null,
      representative_transaction_index: null,
      representative_confirmation_status: null,
      representative_instruction_index: null,
      representative_inner_instruction_index: null,
    })],
    // The marker remains authoritative even if the parent later succeeded and
    // therefore does not appear in currentPopulationRows.
    incompleteAttributionRows: [{ parent_count: 3, incomplete_count: 8 }],
  });
  const json = serializeMainnetTerminalAttribution(artifact);

  assert.equal(json.includes(secret), false);
  assert.equal(artifact.currentPopulation.groups[0]?.normalizedErrorName, 'LEGACY_OTHER');
  assert.equal(artifact.currentPopulation.unavailableRows, 7);
  assert.equal(artifact.diagnosticOccurrences.unavailableOccurrences, 6);
  assert.deepEqual(artifact.incompleteAttribution, {
    parentRows: 3,
    missingOccurrences: 8,
  });
});

void test('uses canonical bytewise ordering and is byte-identical after input shuffling', () => {
  const current = [
    currentRow({ error_name: 'TransactionInboxLeaseExpired', row_count: 2 }),
    currentRow({ error_name: observedBorsh, row_count: 1 }),
  ];
  const occurrences = [
    pumpOccurrence({ representative_signature: 'z-signature' }),
    occurrence({
      source: 'CATCH_UP',
      processing_outcome: 'QUARANTINED',
      worker_cycle_attempt: null,
      worker_recovery_count: null,
      retryable: null,
      retry_exhausted: null,
      stage: null,
      origin: null,
      diagnostic_code: 'UNAVAILABLE',
      catch_up_cause_kind: 'LOCATOR',
      catch_up_reason_code: 'PUMP_SCHEMA_UNSUPPORTED',
      completeness: 'COMPLETE',
      wire_surface: null,
      wire_location: null,
      wire_discriminator: null,
      wire_idl_name: null,
      wire_total_bytes: null,
      wire_payload_bytes: null,
      wire_suffix_bytes: null,
      occurrence_count: 2,
      representative_signature: null,
      representative_slot: null,
      representative_transaction_index: null,
      representative_confirmation_status: null,
      representative_instruction_index: null,
      representative_inner_instruction_index: null,
    }),
  ];
  const left = buildMainnetTerminalAttribution({
    currentPopulationRows: current,
    diagnosticOccurrenceRows: occurrences,
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 0 }],
  });
  const right = buildMainnetTerminalAttribution({
    currentPopulationRows: [...current].reverse(),
    diagnosticOccurrenceRows: [...occurrences].reverse(),
    incompleteAttributionRows: [{ parent_count: '0', incomplete_count: '0' }],
  });

  assert.equal(serializeMainnetTerminalAttribution(left), serializeMainnetTerminalAttribution(right));
  assert.deepEqual(
    left.diagnosticOccurrences.groups.map((group) => group.source),
    ['CATCH_UP', 'WORKER'],
  );
});

void test('retains 128 canonical groups and reports exact overflow groups and occurrences', () => {
  const currentRows = Array.from({ length: 130 }, (_unused, index) => currentRow({
    error_name: observedBorsh,
    attempts: index,
    attempts_in_cycle: index,
    row_count: index + 1,
  }));
  const occurrenceRows = Array.from({ length: 130 }, (_unused, index) => occurrence({
    worker_cycle_attempt: index,
    worker_recovery_count: index,
    occurrence_count: index + 1,
  }));
  const artifact = buildMainnetTerminalAttribution({
    currentPopulationRows: currentRows,
    diagnosticOccurrenceRows: occurrenceRows,
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 0 }],
  });

  assert.equal(artifact.currentPopulation.groups.length, 128);
  assert.deepEqual(artifact.currentPopulation.overflow, {
    groupCount: 2,
    rowCount: 129 + 130,
  });
  assert.equal(artifact.currentPopulation.totalRows, (130 * 131) / 2);
  assert.equal(artifact.diagnosticOccurrences.groups.length, 128);
  assert.deepEqual(artifact.diagnosticOccurrences.overflow, {
    groupCount: 2,
    occurrenceCount: 129 + 130,
  });
});

void test('rejects unsafe integers, inconsistent rows, and malformed artifact reconciliation', () => {
  assert.throws(() => buildMainnetTerminalAttribution({
    currentPopulationRows: [currentRow({ attempts: Number.MAX_SAFE_INTEGER + 1 })],
    diagnosticOccurrenceRows: [],
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 0 }],
  }), TypeError);
  assert.throws(() => buildMainnetTerminalAttribution({
    currentPopulationRows: [currentRow({
      processing_status: 'FAILED', failure_state: 'RETRY_PENDING', error_retryable: false,
    })],
    diagnosticOccurrenceRows: [],
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 0 }],
  }), TypeError);
  assert.throws(() => buildMainnetTerminalAttribution({
    currentPopulationRows: [currentRow({ error_retryable: true })],
    diagnosticOccurrenceRows: [],
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 0 }],
  }), TypeError);
  assert.throws(() => buildMainnetTerminalAttribution({
    currentPopulationRows: [],
    diagnosticOccurrenceRows: [],
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 1 }],
  }), TypeError);
  const valid = buildMainnetTerminalAttribution({
    currentPopulationRows: [],
    diagnosticOccurrenceRows: [],
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 0 }],
  });
  assert.throws(() => parseMainnetTerminalAttribution({
    ...valid,
    currentPopulation: { ...valid.currentPopulation, totalRows: 1 },
  }), TypeError);
  assert.throws(() => parseMainnetTerminalAttribution({ ...valid, privateKey: 'secret' }), TypeError);

  const unavailable = buildMainnetTerminalAttribution({
    currentPopulationRows: [currentRow({ error_name: 'arbitrary-private-error' })],
    diagnosticOccurrenceRows: [occurrence({
      diagnostic_code: 'UNAVAILABLE', completeness: 'UNAVAILABLE',
    })],
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 0 }],
  });
  assert.throws(() => parseMainnetTerminalAttribution({
    ...unavailable,
    currentPopulation: { ...unavailable.currentPopulation, unavailableRows: 0 },
  }), TypeError);
  assert.throws(() => parseMainnetTerminalAttribution({
    ...unavailable,
    diagnosticOccurrences: {
      ...unavailable.diagnosticOccurrences,
      unavailableOccurrences: 0,
    },
  }), TypeError);
});

void test('allows a fully unavailable catch-up occurrence without forged cause provenance', () => {
  const artifact = buildMainnetTerminalAttribution({
    currentPopulationRows: [],
    diagnosticOccurrenceRows: [occurrence({
      source: 'CATCH_UP',
      processing_outcome: 'QUARANTINED',
      worker_cycle_attempt: null,
      worker_recovery_count: null,
      retryable: null,
      retry_exhausted: null,
      stage: null,
      origin: null,
      diagnostic_code: 'UNAVAILABLE',
      catch_up_cause_kind: null,
      catch_up_reason_code: 'PROVIDER_SIGNATURE_MISSING',
      completeness: 'UNAVAILABLE',
    })],
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 0 }],
  });

  assert.equal(artifact.diagnosticOccurrences.unavailableOccurrences, 1);
  assert.equal(artifact.diagnosticOccurrences.groups[0]?.catchUpCauseKind, null);
});

void test('keeps Pump decoder cause provenance source-specific', () => {
  assert.doesNotThrow(() => buildMainnetTerminalAttribution({
    currentPopulationRows: [],
    diagnosticOccurrenceRows: [pumpOccurrence()],
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 0 }],
  }));
  assert.throws(() => buildMainnetTerminalAttribution({
    currentPopulationRows: [],
    diagnosticOccurrenceRows: [pumpOccurrence({ catch_up_cause_kind: 'PUMP_DECODER' })],
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 0 }],
  }), TypeError);
  assert.doesNotThrow(() => buildMainnetTerminalAttribution({
    currentPopulationRows: [],
    diagnosticOccurrenceRows: [pumpOccurrence({
      source: 'CATCH_UP',
      processing_outcome: 'QUARANTINED',
      worker_cycle_attempt: null,
      worker_recovery_count: null,
      retryable: null,
      retry_exhausted: null,
      catch_up_cause_kind: 'PUMP_DECODER',
      catch_up_reason_code: 'PUMP_SCHEMA_UNSUPPORTED',
    })],
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 0 }],
  }));
});

void test('keeps the canonical artifact below one MiB', () => {
  const artifact = buildMainnetTerminalAttribution({
    currentPopulationRows: Array.from({ length: 128 }, (_unused, index) => currentRow({
      error_name: observedBorsh,
      attempts: index,
      attempts_in_cycle: index,
      row_count: 1,
      ignored_secret: 'x'.repeat(10_000),
    })),
    diagnosticOccurrenceRows: Array.from({ length: 128 }, (_unused, index) => pumpOccurrence({
      worker_cycle_attempt: index,
      worker_recovery_count: index,
      representative_signature: `signature-${index}-${'z'.repeat(100)}`,
    })),
    incompleteAttributionRows: [{ parent_count: 0, incomplete_count: 0 }],
  });
  const bytes = Buffer.byteLength(serializeMainnetTerminalAttribution(artifact), 'utf8');
  assert.ok(bytes <= MAINNET_TERMINAL_ATTRIBUTION_MAX_BYTES);
});

function currentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    processing_status: 'FAILED',
    error_name: observedBorsh,
    error_retryable: false,
    failure_state: 'TERMINAL',
    attempts: 1,
    attempts_in_cycle: 1,
    catch_up_reason_code: null,
    row_count: 1,
    ...overrides,
  };
}

function occurrence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'WORKER',
    processing_outcome: 'FAILED',
    worker_cycle_attempt: 1,
    worker_recovery_count: 0,
    retryable: false,
    retry_exhausted: false,
    stage: 'launchpad_observation',
    origin: 'PUMP_BORSH_INVALID',
    diagnostic_code: 'WALLET_GRAPH_DATA_INVALID',
    catch_up_cause_kind: null,
    catch_up_reason_code: null,
    completeness: 'COMPLETE',
    wire_surface: null,
    wire_location: null,
    wire_discriminator: null,
    wire_idl_name: null,
    wire_total_bytes: null,
    wire_payload_bytes: null,
    wire_suffix_bytes: null,
    occurrence_count: 1,
    representative_signature: null,
    representative_slot: null,
    representative_transaction_index: null,
    representative_confirmation_status: null,
    representative_instruction_index: null,
    representative_inner_instruction_index: null,
    ...overrides,
  };
}

function pumpOccurrence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return occurrence({
    diagnostic_code: 'PUMP_BORSH_INVALID',
    catch_up_cause_kind: null,
    wire_surface: 'INSTRUCTION',
    wire_location: 'INNER',
    wire_discriminator: '0102030405060708',
    wire_idl_name: 'buy_v2',
    wire_total_bytes: 24,
    wire_payload_bytes: 16,
    wire_suffix_bytes: null,
    representative_signature: 'signature-a',
    representative_slot: '123',
    representative_transaction_index: 4,
    representative_confirmation_status: 'finalized',
    representative_instruction_index: 5,
    representative_inner_instruction_index: 1,
    ...overrides,
  });
}
