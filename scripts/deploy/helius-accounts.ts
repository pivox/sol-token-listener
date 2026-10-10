import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { HeliusAccountsError, parseHeliusAccountsFile } from '../../src/config/helius-accounts.js';
import { errnoCode } from '../../src/deploy/errno-code.js';

export interface HeliusAccountsCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * `helius-accounts names <file>`: the account names of a pulled Helius list as a JSON array, for
 * `sol helius reload`; never a key. Exit codes: 0; 64 usage; 78 invalid list; 1 unreadable file.
 */
export function runHeliusAccountsCli(
  argv: readonly string[],
  io: HeliusAccountsCliIo,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): number {
  const [command, file, ...rest] = argv;
  if (command !== 'names' || file === undefined || rest.length > 0) {
    io.stderr('usage: helius-accounts names <file>\n');
    return 64;
  }
  let text: string;
  try {
    text = readFile(file);
  } catch (error) {
    io.stderr(`helius-accounts: cannot read ${file} (${errnoCode(error)})\n`);
    return 1;
  }
  try {
    io.stdout(`${JSON.stringify(parseHeliusAccountsFile(text, file).map(({ name }) => name))}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof HeliusAccountsError)) throw error;
    io.stderr(`helius-accounts: ${error.message}\n`);
    return 78;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = runHeliusAccountsCli(process.argv.slice(2), {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}
