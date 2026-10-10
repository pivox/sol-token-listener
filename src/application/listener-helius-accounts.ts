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
  'listenerHeliusAccountsPath' | 'listenerHeliusAccountCooldownMs' | 'httpRpcUrl' | 'wsRpcUrl' | 'httpRpcFallbackUrls'
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
  const primary = new URL(config.httpRpcUrl);
  for (const fallback of config.httpRpcFallbackUrls) {
    const url = new URL(fallback);
    if (url.origin === primary.origin && url.pathname === primary.pathname) {
      throw new Error(
        'LISTENER_HELIUS_ACCOUNTS_PATH cannot be combined with a SOLANA_HTTP_RPC_FALLBACK_URLS entry on the primary address.',
      );
    }
  }
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
  // Explicit calls: boundary modules may not use computed member calls (tests/bootstrap-safety).
  const message = MESSAGES[event.event];
  switch (heliusAccountLogLevel(event)) {
    case 'info': logger.info(event, message); return;
    case 'warn': logger.warn(event, message); return;
    case 'error': logger.error(event, message); return;
  }
}
