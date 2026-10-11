import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileJournal, readJournal, validateJournalState } from '../src/jitosol/journal.js';
import type { JournalState } from '../src/jitosol/types.js';

function state(): JournalState {
  return { version: 1, configFingerprint: 'a'.repeat(64), sequence: 1, status: 'running', completedCycles: 0, totalFeesLamports: '0', realizedProfitLamports: '0', realizedLossLamports: '0', transactions: [], completedPositions: [] };
}

void test('journal atomically persists integer strings with private directory and file permissions', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'jito-journal-'));
  const directory = join(temp, 'state');
  const journal = await FileJournal.open(directory); t.after(async () => { await journal.close(); await rm(temp, { recursive: true, force: true }); });
  assert.equal(await journal.load(), null);
  await journal.save(state());
  assert.deepEqual(await journal.load(), state());
  assert.deepEqual(await readJournal(directory), state());
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'writer.lock'))).mode & 0o777, 0o600);
  assert.match(await readFile(join(directory, 'state.json'), 'utf8'), /"totalFeesLamports": "0"/);
});

void test('journal allows one writer and releases its own lock on close', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jito-lock-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await FileJournal.open(directory);
  await assert.rejects(FileJournal.open(directory), /locked/i);
  await first.close();
  const second = await FileJournal.open(directory);
  await second.close();
  await assert.rejects(second.save(state()), /closed/i);
});

void test('stale or malformed lock requires explicit operator recovery and is never removed automatically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jito-stale-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'writer.lock');
  await writeFile(file, JSON.stringify({ pid: 2_147_483_647, token: 'dead-writer' }), { mode: 0o600 });
  await assert.rejects(FileJournal.open(directory), /stale.*operator/i);
  assert.match(await readFile(file, 'utf8'), /dead-writer/);
  await writeFile(file, 'broken');
  await assert.rejects(FileJournal.open(directory), /malformed.*operator/i);
  assert.equal(await readFile(file, 'utf8'), 'broken');
});

void test('journal rejects corrupt, inconsistent, or unsafe state without replacing the previous durable state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jito-corrupt-'));
  const journal = await FileJournal.open(directory); t.after(async () => { await journal.close(); await rm(directory, { recursive: true, force: true }); });
  await journal.save(state());
  await assert.rejects(journal.save({ ...state(), totalFeesLamports: '-1' }), /invalid journal/i);
  assert.deepEqual(await journal.load(), state());
  await writeFile(join(directory, 'state.json'), '{"version":1}');
  await assert.rejects(journal.load(), /invalid journal/i);
});

void test('journal rejects symlinked directories and state files', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'jito-symlink-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const real = join(temp, 'real'); await mkdir(real, { mode: 0o700 });
  const alias = join(temp, 'alias'); await symlink(real, alias);
  await assert.rejects(FileJournal.open(alias), /symlink/i);
  await writeFile(join(temp, 'target'), JSON.stringify(state()));
  await symlink(join(temp, 'target'), join(real, 'state.json'));
  await assert.rejects(readJournal(real), /symlink/i);
});

void test('a replaced lock is never deleted by the previous owner', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jito-replaced-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const journal = await FileJournal.open(directory);
  await rm(join(directory, 'writer.lock'));
  await writeFile(join(directory, 'writer.lock'), JSON.stringify({ pid: process.pid, token: 'replacement' }), { mode: 0o600 });
  await assert.rejects(journal.save(state()), /lock ownership/i);
  await assert.rejects(journal.close(), /lock ownership/i);
  assert.match(await readFile(join(directory, 'writer.lock'), 'utf8'), /replacement/);
});

void test('journal rejects realized totals without matching completed positions or impossible running phases', () => {
  assert.throws(() => validateJournalState({ ...state(), realizedProfitLamports: '1' }), /realized/i);
  assert.throws(() => validateJournalState({ ...state(), realizedLossLamports: '1' }), /realized/i);
  assert.throws(() => validateJournalState({ ...state(), position: { id: 'orphan', stage: 'buy-pending', openedAtMs: 1, inputLamports: '3000000000', actualJitoReceivedUnits: '0', stakeRentLamports: '0', tokenAccountRentLamports: '0', feesLamports: '0', nonRefundableCostLamports: '0' } }), /pending/i);
});
