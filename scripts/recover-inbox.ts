import { pathToFileURL } from 'node:url';
import type { InboxRecoveryResult } from '../src/domain/transaction-ingestion.js';
import { parseTransactionInboxRetryPolicy } from '../src/config/env.js';
import { closeDatabase, getDatabasePool } from '../src/storage/database.js';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';

const SOLANA_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/u;

interface RecoveryRepository {
  recoverExhausted(signature: string): Promise<InboxRecoveryResult>;
}

export interface InboxRecoveryCliOptions {
  readonly argv: readonly string[];
  readonly repository: RecoveryRepository;
  readonly write: (line: string) => void;
}

export async function runInboxRecoveryCli(options: InboxRecoveryCliOptions): Promise<number> {
  let parsed: { readonly signature: string; readonly confirmation: string };
  try {
    parsed = parseArguments(options.argv);
  } catch {
    writeResult(options.write, { event: 'transaction-inbox.recovery', code: 'RECOVERY_ARGUMENTS_INVALID' });
    return 2;
  }
  if (parsed.confirmation !== parsed.signature) {
    writeResult(options.write, {
      event: 'transaction-inbox.recovery', code: 'RECOVERY_CONFIRMATION_REQUIRED',
    });
    return 2;
  }
  try {
    const result = await options.repository.recoverExhausted(parsed.signature);
    writeResult(options.write, {
      event: 'transaction-inbox.recovery', code: result.code, signature: result.signature,
    });
    return result.code === 'RECOVERY_SCHEDULED'
      || result.code === 'RECOVERY_ALREADY_SCHEDULED' ? 0 : 2;
  } catch {
    writeResult(options.write, { event: 'transaction-inbox.recovery', code: 'RECOVERY_COMMAND_FAILED' });
    return 1;
  }
}

function parseArguments(
  argv: readonly string[],
): { readonly signature: string; readonly confirmation: string } {
  if (!Array.isArray(argv) || argv.length !== 2) throw new TypeError('Invalid arguments.');
  let signature: string | undefined;
  let confirmation: string | undefined;
  for (const argument of argv) {
    if (typeof argument !== 'string') throw new TypeError('Invalid argument.');
    if (argument.startsWith('--signature=') && signature === undefined) {
      signature = argument.slice('--signature='.length);
    } else if (argument.startsWith('--confirm=') && confirmation === undefined) {
      confirmation = argument.slice('--confirm='.length);
    } else {
      throw new TypeError('Invalid argument.');
    }
  }
  if (signature === undefined || confirmation === undefined
    || !SOLANA_SIGNATURE_PATTERN.test(signature)
    || !SOLANA_SIGNATURE_PATTERN.test(confirmation)) {
    throw new TypeError('Invalid signature arguments.');
  }
  return Object.freeze({ signature, confirmation });
}

function writeResult(
  write: (line: string) => void,
  value: Readonly<Record<string, string>>,
): void {
  write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  try {
    const policy = parseTransactionInboxRetryPolicy(process.env);
    const repository = new PostgresTransactionInboxRepository(getDatabasePool(), policy);
    process.exitCode = await runInboxRecoveryCli({
      argv: process.argv.slice(2),
      repository,
      write: (line) => { process.stdout.write(line); },
    });
  } catch {
    process.stdout.write('{"event":"transaction-inbox.recovery","code":"RECOVERY_COMMAND_FAILED"}\n');
    process.exitCode = 1;
  } finally {
    await closeDatabase().catch(() => undefined);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}
