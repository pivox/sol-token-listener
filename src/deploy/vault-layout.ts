/**
 * Where the stack's variables live in Vault and which entries each container reads at boot
 * (docs/superpowers/specs/2026-10-09-vault-secrets-design.md, 6.1 and 7.1). Pure: no I/O.
 */

import { parse } from 'dotenv';
import { isVariableName, parseRoleConfig } from './role-environment.js';
import { secretGrants } from './secret-distribution.js';
import {
  DATABASE_LOGIN_NAMES,
  REQUIRED_ROLES,
  ROLES,
  loginPasswordFile,
  type BackSecret,
  type DatabaseLogin,
  type StackMode,
} from './stack.js';

/** The KV v2 mount: every path below is relative to it. */
export const VAULT_MOUNT = 'sol';

/** One entry per former `config/<name>.env` file. */
export const CONFIG_NAMES = Object.freeze([
  'listener', 'live', 'live-recovery', 'operations', 'operator-api',
  'readiness', 'worker-sim', 'provider-evidence', 'preflight-bundle', 'retention',
] as const);
export type ConfigName = (typeof CONFIG_NAMES)[number];

/** The executor's keypair: the observe mode never reads it. */
export const WALLET_KEYPAIR: BackSecret = 'wallet-keypair.json';

/** Messages name entries and variables, never a value. */
export class VaultLayoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'VaultLayoutError';
  }
}

interface PullEntryFields {
  /** KV v2 path under the `sol/` mount. */
  readonly path: string;
  /** File relative to the container's configuration or secrets directory. */
  readonly file: string;
  /** A required entry stops the container when absent; the others are skipped. */
  readonly required: boolean;
}

/** A Vault entry a container reads at boot, and the file it becomes. */
export type PullEntry =
  | (PullEntryFields & { readonly kind: 'config'; readonly name: ConfigName })
  | (PullEntryFields & { readonly kind: 'secret' });

export function isConfigName(value: string): value is ConfigName {
  return (CONFIG_NAMES as readonly string[]).includes(value);
}

/** `config/<name>`: the entry of a configuration. */
export function configPath(name: ConfigName): string {
  return `config/${name}`;
}

/** `secrets/back/<secret>`: the entry of a secret file of the back. */
export function backSecretPath(secret: BackSecret): string {
  return `secrets/back/${secret}`;
}

/** `secrets/logins/<login>`: the entry of the password of a PostgreSQL login. */
export function loginSecretPath(login: DatabaseLogin): string {
  return `secrets/logins/${login}`;
}

function configNameOf(configFile: string): ConfigName {
  const name = configFile.replace(/\.env$/u, '');
  if (!isConfigName(name)) throw new VaultLayoutError(`unknown configuration file ${configFile}`);
  return name;
}

function loginOf(passwordFile: string): DatabaseLogin {
  const login = DATABASE_LOGIN_NAMES.find((candidate) => loginPasswordFile(candidate) === passwordFile);
  if (login === undefined) throw new VaultLayoutError(`unknown login file ${passwordFile}`);
  return login;
}

/**
 * The back reads the configuration and the secrets of its mode (`secretGrants`). The entries of
 * the roles supervisord starts are required. In observe mode it never reads the keypair.
 */
export function backEntries(mode: StackMode): readonly PullEntry[] {
  const required = new Set(REQUIRED_ROLES[mode].map((role) => configNameOf(ROLES[role].configFile)));
  const configs = CONFIG_NAMES.map((name): PullEntry => Object.freeze({
    kind: 'config', name, path: configPath(name), file: `${name}.env`, required: required.has(name),
  }));
  const secrets = new Map<string, PullEntry>();
  for (const grant of secretGrants(mode)) {
    if (mode === 'observe' && grant.file === WALLET_KEYPAIR) continue;
    // The file of a `back` grant comes from a `BackSecret` field of the role table.
    const path = grant.source === 'logins'
      ? loginSecretPath(loginOf(grant.file))
      : backSecretPath(grant.file as BackSecret);
    secrets.set(path, Object.freeze({
      kind: 'secret',
      path,
      file: `${grant.source}/${grant.file}`,
      required: grant.required || secrets.get(path)?.required === true,
    }));
  }
  const sorted = [...secrets.values()].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  return Object.freeze([...configs, ...sorted]);
}

/** Migrate reads the nine login passwords, all required. */
export function migrateEntries(): readonly PullEntry[] {
  return Object.freeze(DATABASE_LOGIN_NAMES.map((login): PullEntry => Object.freeze({
    kind: 'secret',
    path: loginSecretPath(login),
    file: `logins/${loginPasswordFile(login)}`,
    required: true,
  })));
}

/**
 * The `.env` text of a configuration entry: sorted `VARIABLE=value` lines. Refused when a key is
 * no variable name, when dotenv would not read it back as is or when the entry breaks the
 * configuration rules (`parseRoleConfig`), in that order.
 */
export function renderConfig(name: ConfigName, data: Readonly<Record<string, unknown>>): string {
  const label = configPath(name);
  const keys = Object.keys(data).sort();
  // Every key is checked first: one that is no variable name can hold anything, so no message
  // may show it.
  if (!keys.every((key) => isVariableName(key))) {
    throw new VaultLayoutError(`${label}: invalid variable name`);
  }
  const text = keys.map((key) => {
    const value = data[key];
    if (typeof value !== 'string') throw new VaultLayoutError(`${label}: ${key} must be a string`);
    return `${key}=${value}\n`;
  }).join('');
  // The round trip comes before the configuration rules: a value holding a line break reads as
  // further variables (`info\nNAME=x` gives `NAME`), and a rule refusing one of them would print
  // a fragment of the value.
  const parsed = parse(text);
  const changed = keys.find((key) => parsed[key] !== data[key]);
  if (changed !== undefined || Object.keys(parsed).length !== keys.length) {
    throw new VaultLayoutError(
      `${label}: ${changed ?? 'a variable'} does not survive the .env format `
        + '(#, quotes, outer spaces or line breaks)',
    );
  }
  // The parsed keys are now exactly the validated ones, so a refusal can only name a real variable.
  parseRoleConfig(text, label);
  return text;
}

/** A secret entry keeps its text in `value`; the file receives it unchanged. */
export function secretValue(path: string, data: Readonly<Record<string, unknown>>): string {
  const value = data.value;
  if (typeof value !== 'string' || value.length === 0) {
    throw new VaultLayoutError(`${path}: expected a non-empty value field`);
  }
  return value;
}
