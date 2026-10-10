/**
 * The listener's Helius accounts
 * (docs/superpowers/specs/2026-10-10-helius-listener-accounts-design.md, 5.1): a Vault entry
 * whose fields are account names and whose values are Helius API keys. Pure: no I/O. Messages
 * name an account, never a key.
 */

export const MAX_HELIUS_ACCOUNTS = 32;
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/u;
/** The rule of every secret file: one printable line without spaces. */
const API_KEY = /^[\x21-\x7e]{1,4096}$/u;

export interface HeliusAccount {
  readonly name: string;
  readonly apiKey: string;
}

export class HeliusAccountsError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'HeliusAccountsError';
  }
}

/** The accounts of a Vault entry or of the pulled file, sorted by name: the failover order. */
export function heliusAccountsFromEntry(data: unknown, label: string): readonly HeliusAccount[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new HeliusAccountsError(`${label}: expected one field per account`);
  }
  const record = data as Readonly<Record<string, unknown>>;
  const names = Object.keys(record).sort();
  // Every name is checked first: one that breaks the rule can hold anything, so no message may show it.
  if (!names.every((name) => ACCOUNT_NAME.test(name))) {
    throw new HeliusAccountsError(`${label}: invalid account name`);
  }
  if (names.length === 0 || names.length > MAX_HELIUS_ACCOUNTS) {
    throw new HeliusAccountsError(`${label}: expected 1 to ${String(MAX_HELIUS_ACCOUNTS)} accounts`);
  }
  return Object.freeze(names.map((name): HeliusAccount => {
    const apiKey = record[name];
    if (typeof apiKey !== 'string' || !API_KEY.test(apiKey)) {
      throw new HeliusAccountsError(`${label}: ${name} must be one printable line without spaces`);
    }
    return Object.freeze({ name, apiKey });
  }));
}

/** The pulled file: the compact JSON object of the entry, names sorted. */
export function renderHeliusAccounts(accounts: readonly HeliusAccount[]): string {
  const record: Record<string, string> = {};
  for (const { name, apiKey } of accounts) record[name] = apiKey;
  return JSON.stringify(record);
}

/** The pulled file read back; a parse error never echoes the text. */
export function parseHeliusAccountsFile(text: string, label: string): readonly HeliusAccount[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HeliusAccountsError(`${label}: not a JSON object`);
  }
  return heliusAccountsFromEntry(data, label);
}

/** `baseUrl` with the account's key as its `api-key` parameter: the form of Helius URLs. */
export function withApiKey(baseUrl: string, apiKey: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('api-key', apiKey);
  return url.toString();
}
