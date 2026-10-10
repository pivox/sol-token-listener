import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { errnoCode } from '../../src/deploy/errno-code.js';
import { DATABASE_LOGIN_NAMES } from '../../src/deploy/stack.js';
import {
  VaultClient,
  VaultDeniedError,
  VaultMissingError,
  VaultUnavailableError,
  type VaultFetch,
} from '../../src/deploy/vault-client.js';
import { VAULT_MOUNT, backSecretPath, loginSecretPath } from '../../src/deploy/vault-layout.js';

export const VAULT_POLICIES = Object.freeze(['back', 'migrate', 'backup', 'operator'] as const);
export const VAULT_APPROLES = Object.freeze(['back', 'migrate', 'backup'] as const);

export interface VaultSetupIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface VaultSetupDependencies {
  readonly fetch?: VaultFetch | undefined;
  readonly readFile: (path: string) => string;
  /** Owner-only parent directory and file; never overwrites an existing file. */
  readonly writeSecretFile: (path: string, content: string) => void;
  readonly random: (bytes: number) => Buffer;
}

export function writeSecretFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

const NODE_DEPENDENCIES: VaultSetupDependencies = Object.freeze({
  readFile: (path: string) => readFileSync(path, 'utf8'),
  writeSecretFile,
  random: (bytes: number) => randomBytes(bytes),
});

class SetupFileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SetupFileError';
  }
}

/**
 * `vault-setup init` runs once, from deploy/host/vault-init.sh, in the `vault-setup` tools
 * container (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 8.1). It initializes Vault
 * with one key share and saves the unseal key first, then:
 * - unseals Vault and enables a `file` audit device writing to its stdout (every later
 *   authenticated request reaches the container log, string values HMAC'd), then `sol/` (KV v2),
 *   AppRole and userpass, both without user lockout;
 * - loads the four policies, creates the three AppRoles and writes their files;
 * - generates the nine login passwords and the operator API token in Vault;
 * - creates the `operator` login, prints its password once and revokes the root token.
 * Files go under SOL_VAULT_OUT_DIR (/out): `unseal/unseal-key`, `approle/<name>.json`.
 * Exit codes: 0; 64 usage; 69 Vault unavailable; 77 refused; 78 Vault already initialized or a
 * policy file missing; 1 any other failure, reported by its errno code only.
 */
export async function runVaultSetupCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: VaultSetupIo,
  dependencies: VaultSetupDependencies = NODE_DEPENDENCIES,
): Promise<number> {
  if (argv.length !== 1 || argv[0] !== 'init') {
    io.stderr('usage: vault-setup init\n');
    return 64;
  }
  const out = environment.SOL_VAULT_OUT_DIR ?? '/out';
  const policiesDirectory = environment.SOL_VAULT_POLICIES_DIR ?? '/etc/sol/vault/policies';
  const client = new VaultClient({
    address: environment.VAULT_ADDR ?? 'http://vault:8200', fetch: dependencies.fetch,
  });
  let initRequested = false;
  let unsealKeySaved = false;
  try {
    const policies = VAULT_POLICIES.map((name) => [
      name, readPolicy(dependencies, `${policiesDirectory}/${name}.hcl`),
    ] as const);
    if ((await client.sealStatus()).initialized) {
      io.stderr('vault-setup: Vault is already initialized; nothing changed\n');
      return 78;
    }
    // Set before the call: a `sys/init` that dies on the client may have been processed all the same.
    initRequested = true;
    const { unsealKey, rootToken } = await client.initialize();
    dependencies.writeSecretFile(`${out}/unseal/unseal-key`, `${unsealKey}\n`);
    unsealKeySaved = true;
    await client.unseal(unsealKey);
    await client.enableStdoutAudit(rootToken);
    await client.enableKv2(rootToken, VAULT_MOUNT);
    await client.enableAuth(rootToken, 'approle');
    await client.disableLockout(rootToken, 'approle');
    await client.enableAuth(rootToken, 'userpass');
    await client.disableLockout(rootToken, 'userpass');
    for (const [name, policy] of policies) await client.putPolicy(rootToken, name, policy);
    for (const name of VAULT_APPROLES) {
      const credentials = await client.createAppRole(rootToken, name);
      dependencies.writeSecretFile(`${out}/approle/${name}.json`, `${JSON.stringify(credentials)}\n`);
    }
    for (const login of DATABASE_LOGIN_NAMES) {
      await client.writeKv(rootToken, loginSecretPath(login), { value: dependencies.random(32).toString('hex') });
    }
    await client.writeKv(rootToken, backSecretPath('operator-api-token'), {
      value: dependencies.random(32).toString('hex'),
    });
    const operatorPassword = dependencies.random(24).toString('base64url');
    await client.createUser(rootToken, 'operator', operatorPassword, 'operator');
    await client.revokeSelf(rootToken);
    io.stdout(`${JSON.stringify({
      service: 'vault-setup', event: 'vault.initialized',
      approles: VAULT_APPROLES, logins: DATABASE_LOGIN_NAMES.length,
    })}\n`);
    io.stdout(`Vault operator password, shown once (store it in your password manager): ${operatorPassword}\n`);
    return 0;
  } catch (error) {
    const tail = unsealKeySaved
      ? '; the unseal key is saved: start over as the runbook says'
      : initRequested
        ? '; Vault may be initialized but its unseal key was not saved: start over as the runbook says'
        : '';
    if (error instanceof SetupFileError) {
      io.stderr(`vault-setup: ${error.message}\n`);
      return 78;
    }
    if (error instanceof VaultUnavailableError) {
      io.stderr(`vault-setup: Vault unavailable (${error.message})${tail}\n`);
      return 69;
    }
    if (error instanceof VaultDeniedError || error instanceof VaultMissingError) {
      io.stderr(`vault-setup: refused by Vault (${error.message})${tail}\n`);
      return 77;
    }
    io.stderr(`vault-setup: setup failed (${errnoCode(error)})${tail}\n`);
    return 1;
  }
}

function readPolicy(dependencies: VaultSetupDependencies, path: string): string {
  try {
    return dependencies.readFile(path);
  } catch {
    throw new SetupFileError(`missing policy file ${path}`);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runVaultSetupCli(process.argv.slice(2), process.env, {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}
