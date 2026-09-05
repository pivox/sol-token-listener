import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { isProxy } from 'node:util/types';

const FORBIDDEN_KEY = /(?:DATABASE_URL|SOLANA_(?:HTTP|WS)_RPC_URL|HELIUS_(?:API_KEY|PROJECT_ID)|PRIVATE_KEY|SECRET_KEY|KEYPAIR|MNEMONIC|RECOVERY_PHRASE|WALLET|LIVE_TRADING_ENABLED|EXECUTOR_MODE)/u;

export interface ExecutionPreflightBundleConfig {
  readonly draftPath: string;
  readonly privateKeyPath: string;
  readonly outputDirectory: string;
}

export class ExecutionPreflightBundleConfigError extends TypeError {
  public readonly code = 'INVALID_EXECUTION_PREFLIGHT_BUNDLE_CONFIG' as const;
  public constructor() {
    super('Invalid execution preflight bundle configuration.');
    this.name = 'ExecutionPreflightBundleConfigError';
  }
}

export function parseExecutionPreflightBundleConfig(
  input: unknown,
  applicationRoot = process.cwd(),
): ExecutionPreflightBundleConfig {
  try {
    if (!isEnvironment(input)) throw invalid();
    for (const key of Object.keys(input)) {
      if (FORBIDDEN_KEY.test(key) && key !== 'EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH') {
        throw invalid();
      }
    }
    const draftPath = absolutePath(value(input, 'EXECUTOR_PREFLIGHT_DRAFT_PATH'));
    const privateKeyPath = absolutePath(value(input, 'EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH'));
    const outputDirectory = absolutePath(value(
      input,
      'EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY',
    ));
    if (new Set([draftPath, privateKeyPath, outputDirectory]).size !== 3) throw invalid();
    const root = resolve(applicationRoot);
    for (const path of [draftPath, privateKeyPath, outputDirectory]) {
      if (isWithin(root, path)) throw invalid();
    }
    return Object.freeze({ draftPath, privateKeyPath, outputDirectory });
  } catch {
    throw invalid();
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation));
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

function absolutePath(value: string): string {
  if (value.length === 0 || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > 4_096
    || !isAbsolute(value) || normalize(value) !== value || value.includes('\0')) throw invalid();
  return value;
}

function invalid(): ExecutionPreflightBundleConfigError {
  return new ExecutionPreflightBundleConfigError();
}
