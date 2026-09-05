import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { isProxy } from 'node:util/types';

const FORBIDDEN_KEY = /(?:DATABASE_URL|SOLANA_(?:HTTP|WS)_RPC_URL|HELIUS_|PRIVATE_KEY|SECRET_KEY|KEYPAIR|MNEMONIC|RECOVERY_PHRASE|WALLET|LIVE_TRADING_ENABLED|EXECUTOR_MODE|EVIDENCE_PRIVATE_KEY)/u;

export interface ExecutionPreflightDraftConfig {
  readonly sourcePath: string;
  readonly gateCatalogPath: string;
  readonly outputPath: string;
}

export class ExecutionPreflightDraftConfigError extends TypeError {
  public readonly code = 'INVALID_EXECUTION_PREFLIGHT_DRAFT_CONFIG' as const;
  public constructor() {
    super('Invalid execution preflight draft configuration.');
    this.name = 'ExecutionPreflightDraftConfigError';
  }
}

export function parseExecutionPreflightDraftConfig(
  input: unknown,
  applicationRoot = process.cwd(),
): ExecutionPreflightDraftConfig {
  try {
    if (!isEnvironment(input)) throw invalid();
    for (const key of Object.keys(input)) if (FORBIDDEN_KEY.test(key)) throw invalid();
    const sourcePath = absolutePath(value(input, 'EXECUTOR_PREFLIGHT_SOURCE_PATH'));
    const gateCatalogPath = absolutePath(value(input, 'EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH'));
    const outputPath = absolutePath(value(input, 'EXECUTOR_PREFLIGHT_DRAFT_PATH'));
    if (new Set([sourcePath, gateCatalogPath, outputPath]).size !== 3) throw invalid();
    const root = resolve(applicationRoot);
    for (const path of [sourcePath, gateCatalogPath, outputPath]) {
      if (isWithin(root, path)) throw invalid();
    }
    return Object.freeze({ sourcePath, gateCatalogPath, outputPath });
  } catch {
    throw invalid();
  }
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
function absolutePath(input: string): string {
  if (input.length === 0 || input.trim() !== input || input.includes('\0')
    || Buffer.byteLength(input, 'utf8') > 4_096 || !isAbsolute(input)
    || normalize(input) !== input) throw invalid();
  return input;
}
function isWithin(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation));
}
function invalid(): ExecutionPreflightDraftConfigError {
  return new ExecutionPreflightDraftConfigError();
}
