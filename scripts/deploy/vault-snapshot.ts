import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { errnoCode } from '../../src/deploy/errno-code.js';
import {
  VaultClient,
  VaultDeniedError,
  VaultMissingError,
  VaultUnavailableError,
  parseAppRoleCredentials,
  type AppRoleCredentials,
  type VaultFetch,
} from '../../src/deploy/vault-client.js';

class NotGzipError extends Error {
  public constructor() {
    super('Vault answered no gzip snapshot');
    this.name = 'NotGzipError';
  }
}

/** Every raft snapshot is a gzip stream, whose first bytes are `1f 8b`. */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * `vault-snapshot` runs from deploy/host/backup.sh in the `vault-snapshot` tools container
 * (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 8.4). It reads the backup AppRole
 * JSON on stdin and Vault's raft snapshot (gzip, about 50 KB) whole, checks that it is a gzip
 * stream, then writes it to stdout in one go: a failed or truncated read, or an answer that is no
 * gzip, never reaches stdout. backup.sh keeps the file only on exit 0. Exit codes: 0; 64 usage;
 * 69 Vault unavailable or no gzip answer; 77 refused; 78 invalid AppRole JSON; 1 any other
 * failure, reported by its errno code only.
 */
export async function runVaultSnapshotCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  input: string,
  output: (chunk: Uint8Array) => Promise<void>,
  io: Readonly<{ stderr: (text: string) => void }>,
  fetchImpl?: VaultFetch,
): Promise<number> {
  if (argv.length !== 0) {
    io.stderr('usage: vault-snapshot < backup AppRole JSON > snapshot\n');
    return 64;
  }
  let credentials: AppRoleCredentials;
  try {
    credentials = parseAppRoleCredentials(input);
  } catch {
    io.stderr('vault-snapshot: expected the backup AppRole JSON on stdin\n');
    return 78;
  }
  const client = new VaultClient({ address: environment.VAULT_ADDR ?? 'http://vault:8200', fetch: fetchImpl });
  try {
    const token = await client.appRoleLogin(credentials);
    try {
      const snapshot = await client.snapshot(token);
      if (!isGzip(snapshot)) throw new NotGzipError();
      await output(snapshot);
    } finally {
      await client.revokeSelf(token).catch(() => undefined);
    }
    return 0;
  } catch (error) {
    if (error instanceof NotGzipError) {
      io.stderr(`vault-snapshot: ${error.message}\n`);
      return 69;
    }
    if (error instanceof VaultUnavailableError) {
      io.stderr(`vault-snapshot: Vault unavailable (${error.message})\n`);
      return 69;
    }
    if (error instanceof VaultDeniedError || error instanceof VaultMissingError) {
      io.stderr(`vault-snapshot: refused by Vault (${error.message})\n`);
      return 77;
    }
    io.stderr(`vault-snapshot: snapshot failed (${errnoCode(error)})\n`);
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  // A closed stdout then reaches the write callback as EPIPE instead of crashing the process,
  // so the token is still revoked.
  process.stdout.on('error', () => undefined);
  process.exitCode = await runVaultSnapshotCli(
    process.argv.slice(2),
    process.env,
    readFileSync(0, 'utf8'),
    async (chunk) => new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (error) => { if (error === null || error === undefined) resolve(); else reject(error); });
    }),
    { stderr: (text) => { process.stderr.write(text); } },
  );
}
