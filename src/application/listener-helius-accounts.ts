import { readFileSync } from 'node:fs';
import type { FetchFn } from '@solana/web3.js';
import type { AppConfig } from '../config/env.js';
import { parseHeliusAccountsFile } from '../config/helius-accounts.js';
import {
  HeliusAccountRotation,
  type HeliusAccountEvent,
} from '../solana/rpc/helius-account-rotation.js';
import { logger } from '../utils/logger.js';

type RotationConfig = Pick<
  AppConfig,
  'listenerHeliusAccountsPath' | 'listenerHeliusAccountCooldownMs' | 'httpRpcUrl' | 'wsRpcUrl'
>;

export interface ListenerHeliusAccountDependencies {
  readonly readFile?: (path: string) => string;
  readonly log?: (event: HeliusAccountEvent) => void;
  readonly fetch?: FetchFn;
  readonly now?: () => number;
}

/**
 * The listener's Helius account rotation (docs/superpowers/specs/2026-10-10-helius-listener-accounts-design.md,
 * 6), or undefined outside the stack, where no LISTENER_HELIUS_ACCOUNTS_PATH is set. An invalid
 * file stops the start: the error names an account, never a key.
 */
export function createListenerHeliusAccountRotation(
  config: RotationConfig,
  dependencies: ListenerHeliusAccountDependencies = {},
): HeliusAccountRotation | undefined {
  if (config.listenerHeliusAccountsPath === null) return undefined;
  const readFile = dependencies.readFile ?? ((path: string): string => readFileSync(path, 'utf8'));
  const accounts = parseHeliusAccountsFile(
    readFile(config.listenerHeliusAccountsPath),
    'LISTENER_HELIUS_ACCOUNTS_PATH',
  );
  return new HeliusAccountRotation({
    accounts,
    httpUrl: config.httpRpcUrl,
    websocketUrl: config.wsRpcUrl,
    cooldownMs: config.listenerHeliusAccountCooldownMs,
    log: dependencies.log ?? logHeliusAccountEvent,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}

export function heliusAccountLogLevel(event: HeliusAccountEvent): 'info' | 'warn' | 'error' {
  switch (event.event) {
    case 'rpc.helius_account_selected': return 'info';
    case 'rpc.helius_account_set_aside': return 'warn';
    case 'rpc.helius_accounts_unavailable': return 'error';
  }
}

const MESSAGES: Readonly<Record<HeliusAccountEvent['event'], string>> = Object.freeze({
  'rpc.helius_account_selected': 'Compte Helius du listener sélectionné.',
  'rpc.helius_account_set_aside': 'Compte Helius du listener mis à l’écart.',
  'rpc.helius_accounts_unavailable': 'Tous les comptes Helius du listener sont à l’écart.',
});

export function logHeliusAccountEvent(event: HeliusAccountEvent): void {
  logger[heliusAccountLogLevel(event)](event, MESSAGES[event.event]);
}
