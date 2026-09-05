import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { isProxy } from 'node:util/types';

const FORBIDDEN_KEY = /(?:SOLANA_(?:HTTP|WS)_RPC_URL|HELIUS_|PRIVATE_KEY|SECRET_KEY|KEYPAIR|MNEMONIC|RECOVERY_PHRASE|WALLET|PUBLIC_KEY|LIVE_TRADING_ENABLED|EXECUTOR_MODE|ARMAMENT)/u;

export interface ExecutionPreflightSourceConfig {
  readonly databaseUrl: string;
  readonly generationId: string;
  readonly targetIntentId: string;
  readonly simulationArtifactId: string;
  readonly outputPath: string;
}

export class ExecutionPreflightSourceConfigError extends TypeError {
  public readonly code = 'INVALID_EXECUTION_PREFLIGHT_SOURCE_CONFIG' as const;
  public constructor() {
    super('Invalid execution preflight source configuration.');
    this.name = 'ExecutionPreflightSourceConfigError';
  }
}

export function parseExecutionPreflightSourceConfig(
  input: unknown,
  applicationRoot = process.cwd(),
): ExecutionPreflightSourceConfig {
  try {
    if (!isEnvironment(input)) throw invalid();
    for (const key of Object.keys(input)) if (FORBIDDEN_KEY.test(key)) throw invalid();
    const databaseUrl = postgresUrl(value(input, 'DATABASE_URL'));
    const generationId = patterned(value(input, 'EXECUTOR_PREFLIGHT_GENERATION_ID'),
      /^execution_wallet_generation_[0-9a-f]{64}$/u, 96);
    const targetIntentId = patterned(value(input, 'EXECUTOR_PREFLIGHT_TARGET_INTENT_ID'),
      /^execution_intent_[0-9a-f]{64}$/u, 81);
    const simulationArtifactId = patterned(
      value(input, 'EXECUTOR_PREFLIGHT_SIMULATION_ARTIFACT_ID'),
      /^execution_simulation_artifact_[0-9a-f]{64}$/u, 94,
    );
    const outputPath = absolutePath(value(input, 'EXECUTOR_PREFLIGHT_SOURCE_PATH'));
    if (isWithin(resolve(applicationRoot), outputPath)) throw invalid();
    return Object.freeze({ databaseUrl, generationId, targetIntentId,
      simulationArtifactId, outputPath });
  } catch { throw invalid(); }
}

function isEnvironment(value: unknown): value is Record<string, string | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isProxy(value);
}
function value(environment: Record<string, string | undefined>, key: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  if (!descriptor?.enumerable || !('value' in descriptor)
    || typeof descriptor.value !== 'string') throw invalid();
  return descriptor.value;
}
function bounded(value: string, maximumBytes: number): string {
  if (value.length === 0 || value.trim() !== value || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > maximumBytes) throw invalid();
  return value;
}
function patterned(value: string, pattern: RegExp, maximumBytes: number): string {
  const parsed = bounded(value, maximumBytes);
  if (!pattern.test(parsed)) throw invalid();
  return parsed;
}
function postgresUrl(value: string): string {
  const parsed = bounded(value, 4_096);
  const url = new URL(parsed);
  if ((url.protocol !== 'postgresql:' && url.protocol !== 'postgres:')
    || url.hostname.length === 0 || url.hash.length > 0) throw invalid();
  return parsed;
}
function absolutePath(value: string): string {
  const parsed = bounded(value, 4_096);
  if (!isAbsolute(parsed) || normalize(parsed) !== parsed) throw invalid();
  return parsed;
}
function isWithin(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation));
}
function invalid(): ExecutionPreflightSourceConfigError {
  return new ExecutionPreflightSourceConfigError();
}
