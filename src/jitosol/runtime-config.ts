import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { amount, parseJitoBotConfig } from './config.js';
import type { JitoBotConfig } from './types.js';

const decimal = z.string().refine((value) => { try { amount(value); return true; } catch { return false; } });
const runtimeSchema = z.object({
  rpcUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  }).default('https://api.mainnet-beta.solana.com'),
  keypairPath: z.string().default(''),
  jupiterApiKeyFile: z.string().default(''),
  stateDirectory: z.string().min(1).default('~/.sol-token-listener/jitosol-bot'),
  pollIntervalMs: z.number().int().min(1000).max(60_000).default(10_000),
  claimPollIntervalMs: z.number().int().min(10_000).max(600_000).default(60_000),
  maxRuntimeSeconds: z.number().int().min(1).max(604_800).default(604_800),
  rpcTimeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  computeUnitLimit: z.number().int().min(100_000).max(1_400_000).default(400_000),
  computeUnitPriceMicroLamports: decimal.refine((value) => amount(value) <= 1_000_000n).default('0'),
  maxTransactionFeeLamports: decimal.refine((value) => amount(value) > 0n).default('250000'),
}).strict();

export interface JitoRuntimeConfig {
  strategy: JitoBotConfig;
  runtime: z.infer<typeof runtimeSchema>;
}

function absolute(path: string, base: string): string {
  return resolve(base, path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : path);
}

export function parseRuntimeConfig(value: unknown, baseDirectory = process.cwd()): JitoRuntimeConfig {
  const parsed = z.object({ strategy: z.unknown().default({}), runtime: runtimeSchema.default(() => runtimeSchema.parse({})) }).strict().parse(value);
  const strategy = parseJitoBotConfig(parsed.strategy);
  const runtime = parsed.runtime;
  runtime.stateDirectory = absolute(runtime.stateDirectory, baseDirectory);
  if (runtime.keypairPath) runtime.keypairPath = absolute(runtime.keypairPath, baseDirectory);
  if (runtime.jupiterApiKeyFile) runtime.jupiterApiKeyFile = absolute(runtime.jupiterApiKeyFile, baseDirectory);
  strategy.stopFile = absolute(strategy.stopFile === '.jitosol-bot/STOP' ? 'STOP' : strategy.stopFile, runtime.stateDirectory);
  if (amount(runtime.maxTransactionFeeLamports) * 4n > amount(strategy.networkBudgetLamports)) throw new Error('JITO_FEE_POLICY_EXCEEDS_CYCLE_BUDGET');
  const priorityFee = (BigInt(runtime.computeUnitLimit) * amount(runtime.computeUnitPriceMicroLamports) + 999_999n) / 1_000_000n;
  if (priorityFee + 5000n > amount(runtime.maxTransactionFeeLamports)) throw new Error('JITO_PRIORITY_FEE_EXCEEDS_TRANSACTION_BUDGET');
  return { strategy, runtime };
}

export async function readRuntimeConfig(path: string): Promise<JitoRuntimeConfig> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64_000) throw new Error('JITO_CONFIG_FILE_INVALID');
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    // Paths are relative to the operator's working directory, consistently across commands.
    return parseRuntimeConfig(value);
  } finally { await handle.close(); }
}

/** Only read an explicitly configured API credential; never discover environment secrets. */
export async function readJupiterApiKey(path: string): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > 1024) throw new Error('invalid credential');
      const key = (await handle.readFile('utf8')).trim();
      if (!/^[\x21-\x7e]{1,1000}$/.test(key)) throw new Error('invalid credential');
      return key;
    } finally { await handle.close(); }
  } catch { throw new Error('JITO_API_CREDENTIAL_UNAVAILABLE'); }
}
