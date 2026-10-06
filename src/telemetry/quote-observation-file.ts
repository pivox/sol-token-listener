import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { QuoteObservationRow } from './quote-recorder.js';

/** Creates a private, append-only JSONL sink. Existing evidence is never truncated. */
export function createQuoteObservationFileSink(path: string): (row: QuoteObservationRow) => Promise<void> {
  if (path.trim().length === 0) throw new TypeError('Quote observation path must not be empty.');
  return async (row) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
  };
}
