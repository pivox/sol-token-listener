import assert from 'node:assert/strict';
import test from 'node:test';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import type { CatchUpAdmissionCoverageCandidate } from '../src/ports/catch-up-admission-coverage-repository.js';
import {
  PostgresTransactionInboxRepository,
  TransactionInboxConflictError,
  TransactionInboxRepositoryError,
} from '../src/storage/transaction-inbox.repository.js';

const fingerprint = 'a'.repeat(64);

void test('reads exact durable WebSocket and terminal coverage in one ordered read-only batch', async () => {
  const sql: string[] = [];
  const websocket = candidate('covered-websocket', 1n);
  const missing = candidate('missing', 2n);
  const terminal = candidate('covered-terminal', 3n, 'confirmed');
  const candidates = [websocket, missing, terminal];
  const rows = [websocketRow(websocket), absentRow(missing), terminalRow(terminal)];
  rows.forEach((row, index) => { row.ordinality = String(index + 1); });
  const repository = new PostgresTransactionInboxRepository(fakePool(async (text, values) => {
    sql.push(text);
    assert.equal(values?.length, 1);
    return { rows, rowCount: rows.length };
  }));

  assert.deepEqual(await repository.readExistingCatchUpCoverage(candidates, new AbortController().signal), [
    alreadyAdmitted(websocket),
    alreadyAdmitted(terminal),
  ]);
  assert.equal(sql.length, 1);
  const statement = sql[0];
  assert.ok(statement);
  assert.doesNotMatch(statement, /\b(?:UPDATE|INSERT|DELETE|FOR\s+(?:UPDATE|SHARE)|LOCK)\b/iu);
  assert.match(statement, /ORDER BY candidate\.ordinality/u);
});

void test('leaves confirmation advancement and program enrichment uncovered', async () => {
  const advanceCandidate = candidate('advance', 4n, 'finalized');
  const enrichmentCandidate = Object.freeze({ ...candidate('program-enrichment', 5n),
    programIds: Object.freeze([PUMP_PROGRAM_ID, 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'].sort()) });
  const candidates = [advanceCandidate, enrichmentCandidate];
  const advance = websocketRow(advanceCandidate);
  advance.inbox_confirmation_status = 'confirmed';
  const enrichment = websocketRow(enrichmentCandidate);
  enrichment.inbox_program_ids = [PUMP_PROGRAM_ID];
  const rows = [advance, enrichment];
  rows.forEach((row, index) => { row.ordinality = String(index + 1); });
  const repository = new PostgresTransactionInboxRepository(fakePool(async () => ({
    rows, rowCount: rows.length,
  })));

  assert.deepEqual(await repository.readExistingCatchUpCoverage(candidates, new AbortController().signal), []);
});

void test('fails closed when successful source evidence contradicts a persisted failed classification', async () => {
  const value = candidate('failed-first-success-second', 6n);
  const stored = websocketRow(value);
  stored.inbox_discovery_sources = ['CATCH_UP'];
  stored.catch_up_classification_version = 1;
  stored.catch_up_disposition = 'IGNORED';
  stored.catch_up_reason_code = 'SOLANA_TRANSACTION_FAILED';
  stored.catch_up_action_key = 'NONE';
  stored.catch_up_mints = [];
  stored.catch_up_evidence_fingerprint = fingerprint;
  stored.catch_up_classified_at = new Date(1_000);
  const repository = new PostgresTransactionInboxRepository(fakePool(async () => ({
    rows: [stored], rowCount: 1,
  })));

  await assert.rejects(
    repository.readExistingCatchUpCoverage([value], new AbortController().signal),
    TransactionInboxConflictError,
  );
});

void test('rejects duplicate candidates before I/O and cancellation after the bounded query', async () => {
  let calls = 0;
  const value = candidate('duplicate', 7n);
  const controller = new AbortController();
  const repository = new PostgresTransactionInboxRepository(fakePool(async () => {
    calls += 1;
    controller.abort();
    return { rows: [absentRow(value)], rowCount: 1 };
  }));
  await assert.rejects(repository.readExistingCatchUpCoverage([value, value], controller.signal),
    TransactionInboxRepositoryError);
  assert.equal(calls, 0);
  await assert.rejects(repository.readExistingCatchUpCoverage([value], controller.signal),
    TransactionInboxRepositoryError);
  assert.equal(calls, 1);
});

function candidate(
  signature: string,
  slot: bigint,
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' = 'processed',
): CatchUpAdmissionCoverageCandidate {
  return Object.freeze({
    signature, slot, confirmationStatus, programIds: Object.freeze([PUMP_PROGRAM_ID]),
  });
}

function baseRow(value: CatchUpAdmissionCoverageCandidate): Record<string, unknown> {
  return {
    ordinality: '1', candidate_signature: value.signature, candidate_slot: value.slot.toString(),
    candidate_confirmation_status: value.confirmationStatus,
    candidate_program_ids: [...value.programIds],
    inbox_signature: null, inbox_observed_slot: null, inbox_discovery_sources: null,
    inbox_program_ids: null, inbox_confirmation_status: null,
    inbox_finality_evidence_version: null, inbox_immutable_fingerprint: null,
    inbox_processed_at: null,
    catch_up_classification_version: null, catch_up_disposition: null,
    catch_up_reason_code: null, catch_up_action_key: null, catch_up_mints: null,
    catch_up_evidence_fingerprint: null, catch_up_classified_at: null,
    receipt_signature: null, receipt_observed_slot: null, receipt_confirmation_status: null,
    receipt_finality_evidence_version: null, receipt_immutable_fingerprint: null,
    receipt_replay_completed_at: null,
  };
}

function websocketRow(value: CatchUpAdmissionCoverageCandidate): Record<string, unknown> {
  return {
    ...baseRow(value), inbox_signature: value.signature, inbox_observed_slot: value.slot.toString(),
    inbox_discovery_sources: ['WEBSOCKET'], inbox_program_ids: [...value.programIds],
    inbox_confirmation_status: value.confirmationStatus,
  };
}

function absentRow(value: CatchUpAdmissionCoverageCandidate): Record<string, unknown> {
  return baseRow(value);
}

function terminalRow(value: CatchUpAdmissionCoverageCandidate): Record<string, unknown> {
  return {
    ...baseRow(value), receipt_signature: value.signature,
    receipt_observed_slot: value.slot.toString(), receipt_confirmation_status: 'finalized',
    receipt_finality_evidence_version: '0', receipt_immutable_fingerprint: fingerprint,
    receipt_replay_completed_at: new Date(1_000),
  };
}

function alreadyAdmitted(value: CatchUpAdmissionCoverageCandidate) {
  return Object.freeze({ signature: value.signature, slot: value.slot, disposition: null,
    persistence: 'ALREADY_ADMITTED' as const, admission: 'NOT_ENQUEUED' as const,
    ingestionPriority: null });
}

function fakePool(query: (text: string, values?: readonly unknown[]) => Promise<{
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
}>) {
  return {
    query,
    async connect() { throw new Error('not used'); },
  };
}
