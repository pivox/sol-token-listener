import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'dotenv';
import { HeliusAccountsError, heliusAccountsFromEntry } from '../../src/config/helius-accounts.js';
import { errnoCode } from '../../src/deploy/errno-code.js';
import { INJECTED_KEYS, RoleEnvironmentError, rpcUrl } from '../../src/deploy/role-environment.js';
import type { BackSecret } from '../../src/deploy/stack.js';
import {
  VaultClient,
  VaultDeniedError,
  VaultMissingError,
  VaultUnavailableError,
  type VaultFetch,
} from '../../src/deploy/vault-client.js';
import {
  CONFIG_NAMES,
  HELIUS_LISTENER_ACCOUNTS,
  VaultLayoutError,
  backSecretPath,
  configPath,
  renderConfig,
  type ConfigName,
} from '../../src/deploy/vault-layout.js';

/** The back's URL secret and the role-file variable it comes from (the runbook's former copy). */
const URL_SECRETS: readonly Readonly<{
  secret: BackSecret; source: ConfigName; variable: string; protocol: 'https:' | 'wss:';
}>[] = Object.freeze([
  { secret: 'helius-executor-http-url', source: 'live', variable: 'SOLANA_HTTP_RPC_URL', protocol: 'https:' },
]);
/** Key files that deploy/host/vault-import.sh mounts under /import/keys. */
const KEY_FILES: readonly BackSecret[] = Object.freeze(['helius-admin-api-key', 'evidence-private-key', 'wallet-keypair.json']);
/** Bindings the stack needs whatever the source says (plan deviation 5). */
const STACK_BINDINGS: Readonly<Partial<Record<ConfigName, Readonly<Record<string, string>>>>> = Object.freeze({
  listener: Object.freeze({ API_HOST: '0.0.0.0', API_PORT: '3000' }),
  'operator-api': Object.freeze({ OPERATOR_API_HOST: '0.0.0.0', OPERATOR_API_PORT: '3100' }),
});
const EVIDENCE_DIRECTORY = '/var/lib/sol/evidence';

export interface VaultImportIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface VaultImportDependencies {
  readonly fetch?: VaultFetch | undefined;
  readonly exists: (path: string) => boolean;
  readonly readFile: (path: string) => string;
}

const NODE_DEPENDENCIES: VaultImportDependencies = Object.freeze({
  exists: (path: string) => existsSync(path),
  readFile: (path: string) => readFileSync(path, 'utf8'),
});

class ImportSourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ImportSourceError';
  }
}

interface ImportPlan {
  readonly writes: readonly (readonly [string, Readonly<Record<string, string>>])[];
  readonly configs: readonly string[];
  readonly templates: readonly string[];
  readonly secrets: readonly string[];
}

/**
 * `vault-import` runs from deploy/host/vault-import.sh in the `vault-import` tools container
 * (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 8.2, and plan deviation 5).
 * It reads the operator password on stdin and three sources under SOL_IMPORT_DIR:
 * - `env/`: the role files, in the lot5 layout;
 * - `keys/`: the key files;
 * - `templates/`: the repository templates.
 * Every entry is validated before the first write, every value is a string, and no value is printed.
 * A source needs at least one role file under `env/`: the templates, which the host script always
 * mounts, never make an import alone (a wrong source directory would replace every configuration
 * with placeholders). Exit codes: 0; 64 usage; 69 Vault unavailable; 77 refused by Vault (login,
 * policy or missing mount); 78 invalid source; 1 any other failure, reported by its errno code only.
 */
export async function runVaultImportCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  input: string,
  io: VaultImportIo,
  dependencies: VaultImportDependencies = NODE_DEPENDENCIES,
): Promise<number> {
  const password = (input.split('\n')[0] ?? '').replace(/\r$/u, '');
  if (argv.length !== 0 || password === '') {
    io.stderr('usage: vault-import < operator password\n');
    return 64;
  }
  try {
    const plan = planImport(
      environment.SOL_IMPORT_DIR ?? '/import', environment.SOL_IMPORT_EVIDENCE_PREFIX ?? '', dependencies,
    );
    const client = new VaultClient({
      address: environment.VAULT_ADDR ?? 'http://vault:8200', fetch: dependencies.fetch,
    });
    const token = await client.userpassLogin('operator', password);
    try {
      for (const [path, data] of plan.writes) await client.writeKv(token, path, data);
    } finally {
      await client.revokeSelf(token).catch(() => undefined);
    }
    io.stdout(`${JSON.stringify({
      service: 'vault-import', event: 'vault.imported',
      configs: plan.configs, templates: plan.templates, secrets: plan.secrets,
    })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ImportSourceError || error instanceof VaultLayoutError || error instanceof RoleEnvironmentError) {
      io.stderr(`vault-import: ${error.message}\n`);
      return 78;
    }
    if (error instanceof VaultUnavailableError) {
      io.stderr(`vault-import: Vault unavailable (${error.message})\n`);
      return 69;
    }
    if (error instanceof VaultDeniedError || error instanceof VaultMissingError) {
      io.stderr(`vault-import: refused by Vault (${error.message})\n`);
      return 77;
    }
    io.stderr(`vault-import: import failed (${errnoCode(error)})\n`);
    return 1;
  }
}

/**
 * The lot5 listener URLs become account `01` of the Helius account list, and their addresses
 * without the key become HELIUS_RPC_HTTP_URL and HELIUS_RPC_WS_URL (Helius accounts spec 5.5).
 */
function listenerAccount(parsed: Readonly<Record<string, string>>): Readonly<{
  apiKey: string; httpUrl: string; websocketUrl: string;
}> | null {
  const http = parsed.SOLANA_HTTP_RPC_URL;
  const websocket = parsed.SOLANA_WS_RPC_URL;
  const httpUrl = http === undefined || http === ''
    ? null : rpcUrl(http, 'listener.env: SOLANA_HTTP_RPC_URL', 'https:');
  const websocketUrl = websocket === undefined || websocket === ''
    ? null : rpcUrl(websocket, 'listener.env: SOLANA_WS_RPC_URL', 'wss:');
  if (httpUrl === null && websocketUrl === null) return null;
  if (httpUrl === null || websocketUrl === null) {
    throw new ImportSourceError('listener.env: SOLANA_HTTP_RPC_URL and SOLANA_WS_RPC_URL go together');
  }
  const httpKey = splitApiKey(httpUrl, 'SOLANA_HTTP_RPC_URL');
  const websocketKey = splitApiKey(websocketUrl, 'SOLANA_WS_RPC_URL');
  if (httpKey.apiKey !== websocketKey.apiKey) {
    throw new ImportSourceError('listener.env: SOLANA_HTTP_RPC_URL and SOLANA_WS_RPC_URL carry different api-key values');
  }
  return Object.freeze({ apiKey: httpKey.apiKey, httpUrl: httpKey.address, websocketUrl: websocketKey.address });
}

function splitApiKey(value: string, variable: string): Readonly<{ apiKey: string; address: string }> {
  const url = new URL(value);
  const apiKey = url.searchParams.get('api-key');
  if (apiKey === null || apiKey === '') throw new ImportSourceError(`listener.env: ${variable} has no api-key parameter`);
  url.searchParams.delete('api-key');
  return Object.freeze({ apiKey, address: url.toString() });
}

function planImport(directory: string, evidencePrefix: string, dependencies: VaultImportDependencies): ImportPlan {
  const writes: (readonly [string, Readonly<Record<string, string>>])[] = [];
  const configs: string[] = [];
  const templates: string[] = [];
  const secrets: string[] = [];
  const roleFiles = new Map<ConfigName, Readonly<Record<string, string>>>();
  let listenerKey: string | null = null;
  // Normalized, so dot segments of a relative directory argument (`../evidence`, resolved by the host
  // script against its current directory) do not make the prefix miss the absolute paths of the files.
  const prefix = evidencePrefix === '' ? '' : posix.normalize(evidencePrefix).replace(/\/+$/u, '');
  for (const name of CONFIG_NAMES) {
    const own = `${directory}/env/${name}.env`;
    const template = `${directory}/templates/${name}.env.example`;
    const fromOwn = dependencies.exists(own);
    if (!fromOwn && !dependencies.exists(template)) continue;
    const parsed = parse(dependencies.readFile(fromOwn ? own : template));
    if (fromOwn) roleFiles.set(name, parsed);
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (INJECTED_KEYS.has(key)) continue;
      data[key] = prefix !== '' && (value === prefix || value.startsWith(`${prefix}/`))
        ? `${EVIDENCE_DIRECTORY}${value.slice(prefix.length)}`
        : value;
    }
    if (name === 'listener' && fromOwn) {
      const account = listenerAccount(parsed);
      if (account !== null) {
        data.HELIUS_RPC_HTTP_URL = account.httpUrl;
        data.HELIUS_RPC_WS_URL = account.websocketUrl;
        listenerKey = account.apiKey;
      }
    }
    Object.assign(data, STACK_BINDINGS[name] ?? {});
    renderConfig(name, data);
    writes.push([configPath(name), Object.freeze(data)]);
    (fromOwn ? configs : templates).push(name);
  }
  if (listenerKey !== null) {
    const entry = Object.freeze({ '01': listenerKey });
    try {
      heliusAccountsFromEntry(entry, backSecretPath(HELIUS_LISTENER_ACCOUNTS));
    } catch (error) {
      if (error instanceof HeliusAccountsError) throw new ImportSourceError(error.message);
      throw error;
    }
    writes.push([backSecretPath(HELIUS_LISTENER_ACCOUNTS), entry]);
    secrets.push(HELIUS_LISTENER_ACCOUNTS);
  }
  for (const entry of URL_SECRETS) {
    const value = roleFiles.get(entry.source)?.[entry.variable];
    if (value === undefined || value === '') continue;
    // The rule boot applies in buildRoleEnvironment: a URL that imports also starts the back.
    const url = rpcUrl(value, `${entry.source}.env: ${entry.variable}`, entry.protocol);
    writes.push([backSecretPath(entry.secret), Object.freeze({ value: url })]);
    secrets.push(entry.secret);
  }
  for (const file of KEY_FILES) {
    const path = `${directory}/keys/${file}`;
    if (!dependencies.exists(path)) continue;
    const value = dependencies.readFile(path);
    if (value.trim() === '') throw new ImportSourceError(`keys/${file} is empty`);
    writes.push([backSecretPath(file), Object.freeze({ value })]);
    secrets.push(file);
  }
  // Last, so that a bad key file is reported first.
  if (configs.length === 0) throw new ImportSourceError(`no role file under ${directory}/env`);
  return Object.freeze({ writes, configs, templates, secrets });
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runVaultImportCli(process.argv.slice(2), process.env, readFileSync(0, 'utf8'), {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}
