import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
export interface JournalRow { id: string; [key: string]: unknown }
export const identity = (data: unknown): string => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const missing = (e: unknown): boolean => e instanceof Error && 'code' in e && e.code === 'ENOENT';

/** Single writer. fsync before acknowledgement; recovery never truncates evidence. */
export class EvidenceJournal {
  private readonly ids: Set<string>;
  private constructor(private readonly file: FileHandle, private readonly lockPath: string, public readonly rows: JournalRow[]) {
    this.ids = new Set(rows.map(x => x.id));
  }
  public static async open(filename: string): Promise<EvidenceJournal> {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const lockPath = filename + '.lock';
    try { const lock = await open(lockPath,'wx',0o600); await lock.writeFile(String(process.pid)); await lock.close(); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const pid = Number(await readFile(lockPath,'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('JOURNAL_LOCK_INVALID');
      try { process.kill(pid,0); } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ESRCH') { await unlink(lockPath); return this.open(filename); }
        throw new Error('JOURNAL_LOCKED');
      }
      throw new Error('JOURNAL_LOCKED');
    }
    try {
      let text = '';
      try { text = await readFile(filename,'utf8'); } catch (e) { if (!missing(e)) throw e; }
      const end = text.lastIndexOf('\n'); const complete = text.slice(0,end+1); const tail = text.slice(end+1);
      const rows = parseJournal(complete);
      const file = await open(filename,'a',0o600);
      const journal = new EvidenceJournal(file,lockPath,rows);
      if (tail !== '') {
        await file.writeFile('\n');
        await journal.append({ id: `tail:${identity(tail)}`, kind: 'torn_tail_recovery', hash: identity(tail) });
      }
      return journal;
    } catch (e) { await unlink(lockPath); throw e; }
  }
  public async append(row: JournalRow): Promise<boolean> {
    if (this.ids.has(row.id)) return false;
    await this.file.writeFile(JSON.stringify(row)+'\n'); await this.file.sync();
    this.ids.add(row.id); this.rows.push(row); return true;
  }
  public async close(): Promise<void> { await this.file.close(); await unlink(this.lockPath); }
}
export function parseJournal(text: string): JournalRow[] {
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
  const rows: JournalRow[] = [];
  for (let i=0;i<lines.length;i++) {
    const line = lines[i]; if (line === undefined) throw new Error('JOURNAL_LINE_MISSING');
    try {
      const row: unknown = JSON.parse(line);
      if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string') throw new Error('INVALID_ROW');
      rows.push(row as JournalRow);
    } catch {
      const next: unknown = JSON.parse(lines[i+1] ?? '{}');
      if (typeof next !== 'object' || next === null || !('kind' in next) || next.kind !== 'torn_tail_recovery'
        || !('hash' in next) || next.hash !== identity(line)) throw new Error('JOURNAL_CORRUPT');
    }
  }
  return rows;
}
