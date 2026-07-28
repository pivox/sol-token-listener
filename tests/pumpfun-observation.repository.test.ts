import assert from 'node:assert/strict';
import test from 'node:test';
import { PumpFunObservationRepository } from '../src/storage/pumpfun-observation.repository.js';

void test('persiste un snapshot de courbe avec bigint et clé idempotente', async () => {
  const database = new RecordingDatabase();
  const repository = new PumpFunObservationRepository(database);
  await repository.upsertBondingCurveSnapshot({
    launchMint: 'mint', quoteAsset: quoteAsset(),
    realBaseReservesRaw: 9_007_199_254_740_993n,
    realQuoteReservesRaw: 2n, virtualBaseReservesRaw: 3n,
    virtualQuoteReservesRaw: 4n, progressBps: 5n, complete: false,
    cursor: { slot: 1n, transactionIndex: 2, instructionIndex: 3, innerInstructionIndex: null },
    confirmationStatus: 'confirmed',
  });

  assert.match(database.calls[0]?.text ?? '', /EXCLUDED\.confirmation_status = 'orphaned'/u);
  assert.match(database.calls[0]?.text ?? '', /ON CONFLICT/u);
  assert.ok(database.calls[0]?.values?.includes('9007199254740993'));
  assert.equal(database.calls[0]?.values?.some((value) => typeof value === 'bigint'), false);
});

void test('persiste séparément la résolution ou l’échec de metadata', async () => {
  const database = new RecordingDatabase();
  const repository = new PumpFunObservationRepository(database);
  await repository.upsertMetadataSnapshot({
    mint: 'mint', uri: 'https://example.test/meta.json', fetchedAtMs: 1,
    payloadVersion: 1,
    resolution: { status: 'FAILED', reason: 'JSON_INVALID', message: 'invalid' },
  });

  assert.match(database.calls[0]?.text ?? '', /token_metadata_snapshots/u);
  assert.equal(database.calls[0]?.values?.includes('JSON_INVALID'), true);
});

void test('réconcilie la finalité des trades sans régression', async () => {
  const database = new RecordingDatabase();
  const repository = new PumpFunObservationRepository(database);
  await repository.upsertTrade({
    id: 'trade', launchMint: 'mint', kind: 'BUY', trader: 'wallet',
    baseAmountRaw: 1n, quoteAmountRaw: 2n, quoteAsset: quoteAsset(),
    cursor: { slot: 1n, transactionIndex: 2, instructionIndex: 3, innerInstructionIndex: null },
    confirmationStatus: 'finalized',
  });

  assert.match(database.calls[0]?.text ?? '', /launch_trades\.confirmation_status = 'orphaned'/u);
  assert.match(database.calls[0]?.text ?? '', /EXCLUDED\.confirmation_status = 'finalized'/u);
});

function quoteAsset() {
  return { mint: 'quote', decimals: 6, tokenProgram: 'SPL_TOKEN' as const };
}

class RecordingDatabase {
  public readonly calls: { text: string; values: readonly unknown[] | undefined }[] = [];
  public async query(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values });
    return { rows: [], rowCount: 0, command: 'INSERT', oid: 0, fields: [] };
  }
}
