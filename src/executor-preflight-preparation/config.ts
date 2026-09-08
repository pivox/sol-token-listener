import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { isProxy } from 'node:util/types';
import {
  parseExecutorConfig,
  type SimulationOnlyExecutorConfig,
} from '../executor/config.js';

const HANDOFF_RESERVE_MS = 5_000;
const FORBIDDEN_SELECTOR_KEY = /^EXECUTOR_PREFLIGHT_(?:PAIR|TARGET|SIMULATION|INTENT|MINT|SQL|GENERATION)(?:_|$)/u;

export interface ExecutionPreflightPreparationConfigV1 {
  readonly payloadVersion: 1;
  readonly enabled: true;
  readonly selectionWindowMs: number;
  readonly preparationLeaseMs: number;
  readonly outputPath: string;
  readonly executor: SimulationOnlyExecutorConfig;
}

export class ExecutionPreflightPreparationConfigError extends TypeError {
  public readonly code = 'INVALID_EXECUTION_PREFLIGHT_PREPARATION_CONFIG' as const;

  public constructor() {
    super('Invalid execution preflight preparation configuration.');
    this.name = 'ExecutionPreflightPreparationConfigError';
  }
}

export function parseExecutionPreflightPreparationConfig(
  environmentValue: unknown,
  applicationRoot = process.cwd(),
): ExecutionPreflightPreparationConfigV1 {
  try {
    const environment = safeEnvironment(environmentValue);
    rejectSelectorInjection(environment);
    if (read(environment, 'EXECUTOR_PREFLIGHT_PREPARATION_ENABLED') !== 'true') throw invalid();
    const executor = parseExecutorConfig(environment);
    if (executor.mode !== 'simulation-only') throw invalid();
    const selectionWindowMs = duration(
      environment,
      'EXECUTOR_PREFLIGHT_PREPARATION_SELECTION_WINDOW_MS',
      120_000,
      10_001,
      300_000,
    );
    const preparationLeaseMs = duration(
      environment,
      'EXECUTOR_PREFLIGHT_PREPARATION_LEASE_MS',
      60_000,
      1,
      300_000,
    );
    if (preparationLeaseMs < executor.leaseMs
      || preparationLeaseMs > selectionWindowMs - HANDOFF_RESERVE_MS) throw invalid();
    const outputPath = externalAbsolutePath(
      read(environment, 'EXECUTOR_PREFLIGHT_PREPARATION_OUTPUT_PATH'),
      applicationRoot,
    );
    return Object.freeze({
      payloadVersion: 1,
      enabled: true,
      selectionWindowMs,
      preparationLeaseMs,
      outputPath,
      executor,
    });
  } catch {
    throw invalid();
  }
}

function safeEnvironment(value: unknown): Record<string, string | undefined> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw invalid();
  }
  return value as Record<string, string | undefined>;
}

function rejectSelectorInjection(environment: Record<string, string | undefined>): void {
  for (const key of Object.getOwnPropertyNames(environment)) {
    if (!FORBIDDEN_SELECTOR_KEY.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
      || descriptor.value !== undefined) throw invalid();
  }
}

function read(
  environment: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)
    || descriptor.value !== undefined && typeof descriptor.value !== 'string') throw invalid();
  return descriptor.value as string | undefined;
}

function duration(
  environment: Record<string, string | undefined>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const encoded = read(environment, key);
  if (encoded === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(encoded)) throw invalid();
  const parsed = Number(encoded);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw invalid();
  return parsed;
}

function externalAbsolutePath(value: string | undefined, applicationRoot: string): string {
  if (value === undefined || value.length === 0 || value.trim() !== value
    || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 4_096
    || !isAbsolute(value) || normalize(value) !== value) throw invalid();
  const root = resolve(applicationRoot);
  const candidate = resolve(value);
  const relation = relative(root, candidate);
  if (relation === '' || relation !== '..' && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation)) throw invalid();
  return value;
}

function invalid(): ExecutionPreflightPreparationConfigError {
  return new ExecutionPreflightPreparationConfigError();
}
