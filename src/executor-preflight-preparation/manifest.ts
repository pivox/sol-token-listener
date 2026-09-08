import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isProxy } from 'node:util/types';
import { canonicalStringifyJson } from '../utils/json.js';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const INPUT_KEYS = Object.freeze([
  'runId', 'runFingerprint',
  'pairId', 'pairFingerprint',
  'targetIntentId', 'simulationIntentId',
  'assessmentId', 'assessmentFingerprint',
  'artifactId', 'artifactFingerprint',
  'createdAtMs', 'preparedAtMs', 'expiresAtMs', 'purgeAfterMs',
] as const);

export interface ExecutionPreflightIntentPreparationManifestInputV1 {
  readonly runId: string;
  readonly runFingerprint: string;
  readonly pairId: string;
  readonly pairFingerprint: string;
  readonly targetIntentId: string;
  readonly simulationIntentId: string;
  readonly assessmentId: string;
  readonly assessmentFingerprint: string;
  readonly artifactId: string;
  readonly artifactFingerprint: string;
  readonly createdAtMs: number;
  readonly preparedAtMs: number;
  readonly expiresAtMs: number;
  readonly purgeAfterMs: number;
}

export interface ExecutionPreflightIntentPreparationManifestV1
  extends ExecutionPreflightIntentPreparationManifestInputV1 {
  readonly schemaVersion: 'execution-preflight-intent-preparation-manifest.v1';
  readonly state: 'PREFLIGHT_INTENT_PREPARED';
  readonly canaryStatus: 'CANARY_NOT_STARTED';
  readonly paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED';
  readonly liveCapabilityPresent: false;
}

export interface ExecutionPreflightIntentPreparationManifestWriter {
  write(
    outputPath: string,
    input: ExecutionPreflightIntentPreparationManifestInputV1,
  ): Promise<ExecutionPreflightIntentPreparationManifestV1>;
}

export interface ExecutionPreflightIntentPreparationManifestWriterOptions {
  readonly synchronizeDirectory?: (path: string) => Promise<void>;
}

export class ExecutionPreflightIntentPreparationManifestError extends Error {
  public readonly code = 'PREFLIGHT_PREPARATION_EXPORT_FAILED' as const;

  public constructor() {
    super('Execution preflight preparation manifest export failed.');
    this.name = 'ExecutionPreflightIntentPreparationManifestError';
  }
}

export function createExecutionPreflightIntentPreparationManifest(
  input: unknown,
): ExecutionPreflightIntentPreparationManifestV1 {
  try {
    const value = manifestInput(input);
    return Object.freeze({
      schemaVersion: 'execution-preflight-intent-preparation-manifest.v1',
      runId: value.runId,
      runFingerprint: value.runFingerprint,
      pairId: value.pairId,
      pairFingerprint: value.pairFingerprint,
      targetIntentId: value.targetIntentId,
      simulationIntentId: value.simulationIntentId,
      assessmentId: value.assessmentId,
      assessmentFingerprint: value.assessmentFingerprint,
      artifactId: value.artifactId,
      artifactFingerprint: value.artifactFingerprint,
      createdAtMs: value.createdAtMs,
      preparedAtMs: value.preparedAtMs,
      expiresAtMs: value.expiresAtMs,
      purgeAfterMs: value.purgeAfterMs,
      state: 'PREFLIGHT_INTENT_PREPARED',
      canaryStatus: 'CANARY_NOT_STARTED',
      paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
      liveCapabilityPresent: false,
    });
  } catch {
    throw manifestError();
  }
}

export function createExecutionPreflightIntentPreparationManifestWriter(
  options: ExecutionPreflightIntentPreparationManifestWriterOptions = {},
): ExecutionPreflightIntentPreparationManifestWriter {
  let synchronizeDirectory: (path: string) => Promise<void>;
  try {
    synchronizeDirectory = options.synchronizeDirectory ?? syncDirectory;
  } catch {
    throw manifestError();
  }
  if (typeof synchronizeDirectory !== 'function') throw manifestError();
  return Object.freeze({
    write: async (
      outputPath: string,
      input: ExecutionPreflightIntentPreparationManifestInputV1,
    ) => {
      try {
        const manifest = createExecutionPreflightIntentPreparationManifest(input);
        const content = canonicalStringifyJson(manifest);
        const destination = await protectedDestination(outputPath);
        await publishExclusive(destination.parent, destination.path, content, synchronizeDirectory);
        return manifest;
      } catch {
        throw manifestError();
      }
    },
  });
}

function manifestInput(value: unknown): ExecutionPreflightIntentPreparationManifestInputV1 {
  const row = exactFrozenRecord(value, INPUT_KEYS);
  const input = Object.freeze({
    runId: patterned(row.runId, /^execution_preflight_preparation_[0-9a-f]{64}$/u),
    runFingerprint: fingerprint(row.runFingerprint),
    pairId: patterned(row.pairId, /^execution_preflight_intent_pair_[0-9a-f]{64}$/u),
    pairFingerprint: fingerprint(row.pairFingerprint),
    targetIntentId: intentId(row.targetIntentId),
    simulationIntentId: intentId(row.simulationIntentId),
    assessmentId: patterned(row.assessmentId,
      /^execution_dry_run_assessment_[0-9a-f]{64}$/u),
    assessmentFingerprint: fingerprint(row.assessmentFingerprint),
    artifactId: patterned(row.artifactId,
      /^execution_simulation_artifact_[0-9a-f]{64}$/u),
    artifactFingerprint: fingerprint(row.artifactFingerprint),
    createdAtMs: timestamp(row.createdAtMs),
    preparedAtMs: timestamp(row.preparedAtMs),
    expiresAtMs: timestamp(row.expiresAtMs),
    purgeAfterMs: timestamp(row.purgeAfterMs),
  });
  if (input.targetIntentId === input.simulationIntentId
    || input.preparedAtMs < input.createdAtMs
    || input.expiresAtMs <= input.preparedAtMs
    || input.purgeAfterMs !== input.preparedAtMs + FOUR_HOURS_MS) throw manifestError();
  return input;
}

async function protectedDestination(outputPath: unknown): Promise<Readonly<{
  readonly parent: string;
  readonly path: string;
}>> {
  if (typeof outputPath !== 'string' || !isAbsolute(outputPath)
    || outputPath.includes('\0')) throw manifestError();
  const name = basename(outputPath);
  if (name === '' || name === '.' || name === '..') throw manifestError();
  const parent = await realpath(dirname(outputPath));
  await assertOutsideGitCheckout(parent);
  const path = join(parent, name);
  try {
    await lstat(path);
    throw manifestError();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return Object.freeze({ parent, path });
}

async function assertOutsideGitCheckout(start: string): Promise<void> {
  let candidate = start;
  for (;;) {
    try {
      await lstat(join(candidate, '.git'));
      throw manifestError();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return;
    candidate = parent;
  }
}

async function publishExclusive(
  parent: string,
  outputPath: string,
  content: string,
  synchronizeDirectory: (path: string) => Promise<void>,
): Promise<void> {
  const temporaryPath = join(parent, `.preflight-preparation-${randomUUID()}.tmp`);
  let linked = false;
  let published = false;
  try {
    const handle = await open(temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      const status = await handle.stat();
      const expectedBytes = Buffer.byteLength(content, 'utf8');
      if (!status.isFile() || (status.mode & 0o777) !== 0o600 || status.size !== expectedBytes) {
        throw manifestError();
      }
      const replay = Buffer.alloc(expectedBytes);
      const read = await handle.read(replay, 0, replay.length, 0);
      if (read.bytesRead !== replay.length || replay.toString('utf8') !== content) {
        throw manifestError();
      }
    } finally {
      await handle.close();
    }
    await link(temporaryPath, outputPath);
    linked = true;
    await unlink(temporaryPath);
    await synchronizeDirectory(parent);
    published = true;
  } finally {
    if (!published) {
      if (linked) await unlink(outputPath).catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await handle.stat();
    if (!status.isDirectory()) throw manifestError();
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function exactFrozenRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (typeof value !== 'object' || value === null || isProxy(value) || !Object.isFrozen(value)) {
    throw manifestError();
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw manifestError();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw manifestError();
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw manifestError();
    }
    result[key] = descriptor.value;
  }
  return result as Readonly<Record<Keys[number], unknown>>;
}

function patterned(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw manifestError();
  return value;
}

function fingerprint(value: unknown): string {
  return patterned(value, /^[0-9a-f]{64}$/u);
}

function intentId(value: unknown): string {
  return patterned(value, /^execution_intent_[0-9a-f]{64}$/u);
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > MAX_TIMESTAMP_MS || Object.is(value, -0)) throw manifestError();
  return value as number;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'ENOENT';
}

function manifestError(): ExecutionPreflightIntentPreparationManifestError {
  return new ExecutionPreflightIntentPreparationManifestError();
}
