import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { RoleEnvironmentError } from '../../src/deploy/role-environment.js';
import { isStackMode, type StackMode } from '../../src/deploy/stack.js';
import {
  VaultClient,
  VaultDeniedError,
  VaultMissingError,
  VaultUnavailableError,
  parseAppRoleCredentials,
  type AppRoleCredentials,
  type VaultFetch,
} from '../../src/deploy/vault-client.js';
import {
  VaultLayoutError,
  backEntries,
  migrateEntries,
  renderConfig,
  secretValue,
  type PullEntry,
} from '../../src/deploy/vault-layout.js';

export interface VaultPullIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface VaultPullDependencies {
  readonly fetch?: VaultFetch | undefined;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, content: string, mode: number) => void;
}

/** Owner-only parents for secrets, 0755 for configurations, then the exact file mode whatever the umask. */
export function writePulledFile(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: mode === 0o600 ? 0o700 : 0o755 });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

const NODE_DEPENDENCIES: VaultPullDependencies = Object.freeze({
  now: () => Date.now(),
  sleep: async (milliseconds: number) => { await delay(milliseconds); },
  readFile: (path: string) => readFileSync(path, 'utf8'),
  writeFile: writePulledFile,
});

const RETRY_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** An unreadable AppRole file or missing required entries: EX_CONFIG. */
class PullConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PullConfigurationError';
  }
}

type Target =
  | Readonly<{ container: 'back'; mode: StackMode }>
  | Readonly<{ container: 'migrate'; mode: null }>;

interface PulledFile {
  readonly kind: 'config' | 'secret';
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}

/**
 * `vault-pull back observe|live` (sol-entrypoint) and `vault-pull migrate` (sol-admin migrate)
 * read the container's Vault entries into tmpfs at the current paths
 * (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 7). Nothing is written until every
 * required entry is read and valid, and no value is ever printed. Exit codes: 0; 64 usage;
 * 69 Vault unavailable past SOL_VAULT_PULL_TIMEOUT_MS (60 s); 77 AppRole or policy refused;
 * 78 unreadable AppRole file, missing required entry or invalid entry; 1 any other failure, which
 * is reported by its errno code only.
 */
export async function runVaultPullCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: VaultPullIo,
  dependencies: VaultPullDependencies = NODE_DEPENDENCIES,
): Promise<number> {
  const target = parseTarget(argv);
  if (target === null) {
    io.stderr('usage: vault-pull back observe|live | vault-pull migrate\n');
    return 64;
  }
  const entries = target.container === 'back' ? backEntries(target.mode) : migrateEntries();
  // Each container writes where its consumer reads: distribute-secrets (back), admin-database (migrate).
  const secretsDirectory = target.container === 'back'
    ? environment.SOL_SECRETS_DIR ?? '/root/secrets'
    : environment.SOL_DB_SECRETS_DIR ?? '/root/secrets/db';
  const configDirectory = environment.SOL_CONFIG_DIR ?? '/etc/sol/config';
  const timeoutMs = timeoutOf(environment.SOL_VAULT_PULL_TIMEOUT_MS);
  const client = new VaultClient({
    address: environment.VAULT_ADDR ?? 'http://vault:8200', fetch: dependencies.fetch,
  });
  try {
    const credentials = readCredentials(dependencies, environment.SOL_VAULT_APPROLE ?? '/root/vault/approle.json');
    const deadline = dependencies.now() + timeoutMs;
    for (;;) {
      try {
        const values = await readEntries(client, credentials, entries);
        const files = materialize(entries, values, secretsDirectory, configDirectory);
        // Validation is complete before the first write; a write failing midway leaves files in a tmpfs the container discards.
        for (const file of files) dependencies.writeFile(file.path, file.content, file.mode);
        io.stdout(`${JSON.stringify({
          service: 'vault-pull',
          event: 'vault.pulled',
          container: target.container,
          ...(target.mode === null ? {} : { mode: target.mode }),
          configs: files.filter((file) => file.kind === 'config').length,
          secrets: files.filter((file) => file.kind === 'secret').length,
          absent: entries.filter((entry) => !values.has(entry.path)).map((entry) => entry.path),
        })}\n`);
        return 0;
      } catch (error) {
        if (!(error instanceof VaultUnavailableError) || dependencies.now() >= deadline) throw error;
        await dependencies.sleep(RETRY_INTERVAL_MS);
      }
    }
  } catch (error) {
    return reportFailure(error, io, timeoutMs);
  }
}

function parseTarget(argv: readonly string[]): Target | null {
  const [container, mode, ...rest] = argv;
  if (rest.length > 0) return null;
  if (container === 'back' && mode !== undefined && isStackMode(mode)) return { container, mode };
  if (container === 'migrate' && mode === undefined) return { container, mode: null };
  return null;
}

function timeoutOf(raw: string | undefined): number {
  return raw !== undefined && /^[1-9][0-9]{0,6}$/u.test(raw) ? Number(raw) : DEFAULT_TIMEOUT_MS;
}

function readCredentials(dependencies: VaultPullDependencies, path: string): AppRoleCredentials {
  try {
    return parseAppRoleCredentials(dependencies.readFile(path));
  } catch {
    throw new PullConfigurationError(`missing or invalid AppRole file ${path}`);
  }
}

async function readEntries(
  client: VaultClient,
  credentials: AppRoleCredentials,
  entries: readonly PullEntry[],
): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
  const token = await client.appRoleLogin(credentials);
  try {
    const values = new Map<string, Readonly<Record<string, unknown>>>();
    const missing: string[] = [];
    for (const entry of entries) {
      try {
        values.set(entry.path, await client.readKv(token, entry.path));
      } catch (error) {
        if (!(error instanceof VaultMissingError)) throw error;
        if (entry.required) missing.push(entry.path);
      }
    }
    if (missing.length > 0) throw new PullConfigurationError(`missing required entries: ${missing.join(', ')}`);
    return values;
  } finally {
    await client.revokeSelf(token).catch(() => undefined);
  }
}

function materialize(
  entries: readonly PullEntry[],
  values: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  secretsDirectory: string,
  configDirectory: string,
): readonly PulledFile[] {
  const files: PulledFile[] = [];
  for (const entry of entries) {
    const data = values.get(entry.path);
    if (data === undefined) continue;
    files.push(entry.kind === 'config'
      ? { kind: 'config', path: `${configDirectory}/${entry.file}`, content: renderConfig(entry.name, data), mode: 0o644 }
      : { kind: 'secret', path: `${secretsDirectory}/${entry.file}`, content: secretValue(entry.path, data), mode: 0o600 });
  }
  return files;
}

function reportFailure(error: unknown, io: VaultPullIo, timeoutMs: number): number {
  if (error instanceof VaultUnavailableError) {
    io.stderr(`vault-pull: Vault unavailable for ${String(Math.round(timeoutMs / 1_000))} s (${error.message})\n`);
    return 69;
  }
  if (error instanceof VaultDeniedError || error instanceof VaultMissingError) {
    io.stderr(`vault-pull: refused by Vault (${error.message})\n`);
    return 77;
  }
  if (error instanceof PullConfigurationError || error instanceof VaultLayoutError || error instanceof RoleEnvironmentError) {
    io.stderr(`vault-pull: ${error.message}\n`);
    return 78;
  }
  io.stderr(`vault-pull: unexpected failure (${errnoCode(error)})\n`);
  return 1;
}

/** Only an errno code reaches the log, never a message (it may quote a path or a value). */
function errnoCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return typeof code === 'string' && /^E[A-Z0-9]+$/u.test(code) ? code : 'unknown';
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runVaultPullCli(process.argv.slice(2), process.env, {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
}
