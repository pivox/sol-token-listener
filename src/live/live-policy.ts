import { isAbsolute, relative, resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';

export interface LivePolicy {
  readonly cluster: 'mainnet-beta';
  readonly expectedGenesisHash: string;
  readonly expectedWallet: string;
  readonly keypairFile: string;
  readonly buyAmountLamports: bigint;
  readonly maxExposureLamports: bigint;
  readonly maxLossLamports: bigint;
  readonly exitReserveLamports: bigint;
  readonly maxPriorityFeeLamports: bigint;
  readonly maxSlippageBps: number;
  readonly maxBuys: 1;
  readonly maxConcurrentPositions: 1;
  readonly maxSessionSeconds: number;
}

/** Parses only the explicit live namespace; this module never reads dotenv or key material. */
export function parseLivePolicy(
  environment: Readonly<Record<string, string | undefined>>,
  projectRoot = process.cwd(),
): LivePolicy {
  if (environment.LIVE_ENABLE !== 'true') throw new Error('LIVE_ENABLE must be explicitly true.');
  const expectedGenesisHash = required(environment, 'LIVE_EXPECTED_GENESIS_HASH');
  const expectedWallet = required(environment, 'LIVE_EXPECTED_WALLET');
  const keypairFile = required(environment, 'LIVE_KEYPAIR_FILE');
  validatePublicKey(expectedGenesisHash, 'LIVE_EXPECTED_GENESIS_HASH');
  validatePublicKey(expectedWallet, 'LIVE_EXPECTED_WALLET');
  if (!isAbsolute(keypairFile) || inside(resolve(projectRoot), resolve(keypairFile))) {
    throw new Error('LIVE_KEYPAIR_FILE must be an absolute path outside the project directory.');
  }

  const buyAmountLamports = positiveBigint(environment, 'LIVE_BUY_AMOUNT_LAMPORTS');
  const maxExposureLamports = positiveBigint(environment, 'LIVE_MAX_EXPOSURE_LAMPORTS');
  const maxLossLamports = positiveBigint(environment, 'LIVE_MAX_LOSS_LAMPORTS');
  const exitReserveLamports = positiveBigint(environment, 'LIVE_EXIT_RESERVE_LAMPORTS');
  const maxPriorityFeeLamports = nonNegativeBigint(environment, 'LIVE_MAX_PRIORITY_FEE_LAMPORTS');
  if (maxExposureLamports < buyAmountLamports) throw new Error('LIVE_MAX_EXPOSURE_LAMPORTS is below the buy amount.');
  if (maxLossLamports > maxExposureLamports) throw new Error('LIVE_MAX_LOSS_LAMPORTS exceeds exposure.');
  if (exitReserveLamports <= maxPriorityFeeLamports) {
    throw new Error('LIVE_EXIT_RESERVE_LAMPORTS must exceed LIVE_MAX_PRIORITY_FEE_LAMPORTS; the reserve must at least leave room for the full permitted priority fee plus a nonzero base network fee.');
  }
  const maxBuys = integer(environment, 'LIVE_MAX_BUYS', 1, 1);
  const maxSlippageBps = integer(environment, 'LIVE_MAX_SLIPPAGE_BPS', 1, 1_000);
  const maxSessionSeconds = integer(environment, 'LIVE_MAX_SESSION_SECONDS', 1, 3_600);
  void maxBuys;

  return Object.freeze({
    cluster: 'mainnet-beta',
    expectedGenesisHash,
    expectedWallet,
    keypairFile,
    buyAmountLamports,
    maxExposureLamports,
    maxLossLamports,
    exitReserveLamports,
    maxPriorityFeeLamports,
    maxSlippageBps,
    maxBuys: 1,
    maxConcurrentPositions: 1,
    maxSessionSeconds,
  });
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0 || value !== value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function positiveBigint(environment: Readonly<Record<string, string | undefined>>, name: string): bigint {
  const value = required(environment, name);
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${name} must be a positive canonical integer.`);
  return BigInt(value);
}

function nonNegativeBigint(environment: Readonly<Record<string, string | undefined>>, name: string): bigint {
  const value = required(environment, name);
  if (!/^(0|[1-9]\d*)$/u.test(value)) throw new Error(`${name} must be a non-negative canonical integer.`);
  return BigInt(value);
}

function integer(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = required(environment, name);
  if (!/^(0|[1-9]\d*)$/u.test(value)) throw new Error(`${name} must be a canonical integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} is outside its permitted range.`);
  return parsed;
}

function validatePublicKey(value: string, name: string): void {
  try {
    if (new PublicKey(value).toBase58() !== value) throw new Error();
  } catch {
    throw new Error(`${name} must be a valid base58 32-byte value.`);
  }
}

function inside(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}
