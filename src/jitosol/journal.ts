import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { amount } from './config.js';
import type { JournalState, JournalStore } from './types.js';

const unsigned = z.string().refine((value) => { try { amount(value); return true; } catch { return false; } });
const signed = z.string().regex(/^-?(0|[1-9]\d*)$/).max(24);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const action = z.enum(['buy', 'withdraw', 'deactivate', 'claim']);
const transaction = z.object({
  kind: action, signature: z.string().min(1).max(128),
  wireTransactionBase64: z.string().min(4).max(10_000).refine((v) => Buffer.from(v, 'base64').toString('base64') === v),
  lastValidBlockHeight: integer, preparedAtMs: integer, quoteExpiresAtMs: integer.optional(), estimatedFeeLamports: unsigned,
  expected: z.object({ stakeAddress: z.string().min(1).optional(), minJitoReceivedUnits: unsigned.optional(), jitoSpentUnits: unsigned.optional(), refundableRentLamports: unsigned.optional(), minimumRedemptionLamports: unsigned.optional() }).strict(),
  broadcastAttempts: integer.optional(), lastBroadcastAtMs: integer.optional(), lastBroadcastError: z.string().optional(),
}).strict();
const effects = z.object({
  feeLamports: unsigned, actualInputLamports: unsigned.optional(), actualJitoReceivedUnits: unsigned.optional(), actualJitoSpentUnits: unsigned.optional(),
  stakeAddress: z.string().min(1).optional(), actualClaimedLamports: unsigned.optional(), refundableRentLamports: unsigned.optional(), nonRefundableCostLamports: unsigned.optional(),
}).strict();
const position = z.object({
  id: z.string().min(1), stage: z.enum(['buy-pending', 'purchased', 'withdrawn', 'deactivated', 'complete']), openedAtMs: integer,
  inputLamports: unsigned, actualJitoReceivedUnits: unsigned, stakeAddress: z.string().min(1).optional(),
  stakeRentLamports: unsigned, tokenAccountRentLamports: unsigned, feesLamports: unsigned, nonRefundableCostLamports: unsigned,
  actualClaimedLamports: unsigned.optional(), realizedProfitLamports: signed.optional(), completedAtMs: integer.optional(),
}).strict();
const journal = z.object({
  version: z.literal(1), configFingerprint: z.string().regex(/^[a-f0-9]{64}$/), sequence: integer,
  status: z.enum(['running', 'halted']), haltReason: z.string().optional(), completedCycles: integer,
  totalFeesLamports: unsigned, realizedProfitLamports: signed, realizedLossLamports: unsigned,
  confirmation: z.object({ quoteId: z.string().min(1), observedAtMs: integer, contextSlot: integer }).strict().optional(),
  position: position.optional(), pending: transaction.optional(),
  transactions: z.array(z.object({ positionId: z.string().min(1), transaction, outcome: z.enum(['finalized', 'failed']), effects, recordedAtMs: integer }).strict()).max(1000),
  completedPositions: z.array(position).max(100),
}).strict();

export function validateJournalState(value: unknown): JournalState {
  try {
    const parsed = journal.parse(value);
    if (parsed.completedCycles !== parsed.completedPositions.length) throw new Error('completed cycle count does not match history');
    if (parsed.pending && !parsed.position) throw new Error('pending transaction has no position');
    if (parsed.status === 'halted' && !parsed.haltReason) throw new Error('halted journal has no reason');
    if (parsed.position?.stage === 'complete' || parsed.completedPositions.some((p) => p.stage !== 'complete')) throw new Error('inconsistent position lifecycle');
    if (parsed.pending && parsed.transactions.some((record) => record.transaction.signature === parsed.pending?.signature)) throw new Error('pending signature already recorded');
    const totalFees = parsed.transactions.reduce((sum, record) => sum + amount(record.effects.feeLamports), 0n);
    if (totalFees !== amount(parsed.totalFeesLamports)) throw new Error('fee ledger total does not match receipts');
    let realizedProfit = 0n; let realizedLoss = 0n;
    for (const completed of parsed.completedPositions) {
      if (completed.realizedProfitLamports === undefined || completed.actualClaimedLamports === undefined || completed.completedAtMs === undefined) throw new Error('completed position lacks realized accounting');
      const profit = BigInt(completed.realizedProfitLamports);
      realizedProfit += profit;
      if (profit < 0n) realizedLoss -= profit;
    }
    if (realizedProfit !== BigInt(parsed.realizedProfitLamports) || realizedLoss !== amount(parsed.realizedLossLamports)) throw new Error('realized totals do not match completed positions');
    if (parsed.status === 'running' && parsed.position?.stage === 'buy-pending' && parsed.pending?.kind !== 'buy') throw new Error('running buy-pending position has no pending buy');
    // Zod describes optional properties as `T | undefined`; persisted JSON omits them.
    return parsed as JournalState;
  } catch (error) {
    throw new Error(`Invalid journal: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function code(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

async function inspectDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Journal directory must be a real directory, not a symlink');
  if ((info.mode & 0o077) !== 0) throw new Error('Journal directory must have private 0700 permissions');
}

async function readPrivateFile(file: string): Promise<string> {
  let handle: FileHandle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (code(error) === 'ELOOP') throw new Error('Journal file must not be a symlink');
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4_000_000 || (info.mode & 0o077) !== 0) throw new Error('Journal file must be a private regular file under 4 MB');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function readJournal(directory: string): Promise<JournalState | null> {
  try {
    await inspectDirectory(directory);
    const contents = await readPrivateFile(join(directory, 'state.json'));
    let value: unknown;
    try { value = JSON.parse(contents); } catch { throw new Error('Invalid journal: malformed JSON'); }
    return validateJournalState(value);
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    throw error;
  }
}

/** A stale writer lock is intentionally never stolen; recovery requires an operator. */
export class FileJournal implements JournalStore {
  readonly directory: string;
  private closed = false;
  private saving = false;

  private constructor(directory: string, private readonly token: string, private readonly lockHandle: FileHandle) { this.directory = directory; }

  static async open(directory: string): Promise<FileJournal> {
    const absolute = resolve(directory);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    await inspectDirectory(absolute);
    const token = randomUUID();
    let handle: FileHandle;
    try {
      handle = await open(join(absolute, 'writer.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
      let owner: { pid: number };
      try {
        const lock: unknown = JSON.parse(await readPrivateFile(join(absolute, 'writer.lock')));
        owner = z.looseObject({ pid: z.number().int().positive() }).parse(lock);
      } catch { throw new Error('Malformed journal writer lock; operator recovery required'); }
      try { process.kill(owner.pid, 0); }
      catch (probe) {
        if (code(probe) === 'ESRCH') throw new Error(`Stale journal writer lock for PID ${owner.pid}; operator must inspect pending transactions and remove the lock explicitly`);
      }
      throw new Error(`Journal locked by PID ${owner.pid}; single writer required`);
    }
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`);
      await handle.sync();
      await syncDirectory(absolute);
      return new FileJournal(absolute, token, handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async assertOwner(): Promise<void> {
    if (this.closed) throw new Error('Journal is closed');
    try {
      const owner: unknown = JSON.parse(await readPrivateFile(join(this.directory, 'writer.lock')));
      if (typeof owner !== 'object' || owner === null || !('token' in owner) || owner.token !== this.token) throw new Error('replaced lock');
      const held = await this.lockHandle.stat();
      const current = await lstat(join(this.directory, 'writer.lock'));
      if (held.ino !== current.ino || held.dev !== current.dev) throw new Error('replaced lock');
    } catch { throw new Error('Journal lock ownership lost; operator recovery required'); }
  }

  async load(): Promise<JournalState | null> {
    await this.assertOwner();
    return readJournal(this.directory);
  }

  async save(state: JournalState): Promise<void> {
    await this.assertOwner();
    if (this.saving) throw new Error('Concurrent journal writes are forbidden');
    const validated = validateJournalState(state);
    this.saving = true;
    const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      await inspectDirectory(this.directory);
      try {
        const existing = await lstat(join(this.directory, 'state.json'));
        if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Journal state must not be a symlink or special file');
      } catch (error) { if (code(error) !== 'ENOENT') throw error; }
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`);
      await handle.sync();
      await handle.close(); handle = undefined;
      await this.assertOwner();
      await rename(temporary, join(this.directory, 'state.json'));
      await syncDirectory(this.directory);
    } finally {
      if (handle) await handle.close();
      await unlink(temporary).catch((error: unknown) => { if (code(error) !== 'ENOENT') throw error; });
      this.saving = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.assertOwner();
      await unlink(join(this.directory, 'writer.lock'));
      await syncDirectory(this.directory);
    } finally {
      this.closed = true;
      await this.lockHandle.close();
    }
  }
}
