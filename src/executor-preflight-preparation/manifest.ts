import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isProxy } from 'node:util/types';
import { canonicalStringifyJson, parseJson } from '../utils/json.js';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const MAX_MANIFEST_BYTES = 16_384;
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
  readonly beforeFileSystemOperation?: (
    operation: ExecutionPreflightIntentPreparationFileSystemOperation,
  ) => Promise<void>;
}

export type ExecutionPreflightIntentPreparationFileSystemOperation =
  | 'READ_EXISTING'
  | 'CREATE_TEMPORARY'
  | 'PUBLISH_OUTPUT'
  | 'REMOVE_TEMPORARY'
  | 'SYNC_DIRECTORY'
  | 'ROLLBACK_OUTPUT'
  | 'ROLLBACK_TEMPORARY';

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
  let synchronizeDirectory: ((path: string) => Promise<void>) | undefined;
  let beforeFileSystemOperation:
    ((operation: ExecutionPreflightIntentPreparationFileSystemOperation) => Promise<void>)
    | undefined;
  try {
    synchronizeDirectory = options.synchronizeDirectory;
    beforeFileSystemOperation = options.beforeFileSystemOperation;
  } catch {
    throw manifestError();
  }
  if (synchronizeDirectory !== undefined && typeof synchronizeDirectory !== 'function') {
    throw manifestError();
  }
  if (beforeFileSystemOperation !== undefined && typeof beforeFileSystemOperation !== 'function') {
    throw manifestError();
  }
  return Object.freeze({
    write: async (
      outputPath: string,
      input: ExecutionPreflightIntentPreparationManifestInputV1,
    ) => {
      try {
        const manifest = createExecutionPreflightIntentPreparationManifest(input);
        const content = canonicalStringifyJson(manifest);
        if (Buffer.byteLength(content, 'utf8') > MAX_MANIFEST_BYTES) throw manifestError();
        const destination = await authenticatedDestination(outputPath);
        try {
          if (await replayExact(destination, content, synchronizeDirectory,
            beforeFileSystemOperation)) return manifest;
          await publishExclusive(destination, content, synchronizeDirectory,
            beforeFileSystemOperation);
          return manifest;
        } finally {
          await destination.handle.close();
        }
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

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface AuthenticatedDestination {
  readonly parent: string;
  readonly path: string;
  readonly identity: DirectoryIdentity;
  readonly handle: FileHandle;
}

async function authenticatedDestination(outputPath: unknown): Promise<AuthenticatedDestination> {
  if (typeof outputPath !== 'string' || !isAbsolute(outputPath)
    || outputPath.includes('\0')) throw manifestError();
  const name = basename(outputPath);
  if (name === '' || name === '.' || name === '..') throw manifestError();
  const parent = await realpath(dirname(outputPath));
  await assertOutsideGitCheckout(parent);
  const path = join(parent, name);
  const parentStatus = await lstat(parent, { bigint: true });
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) throw manifestError();
  const identity = directoryIdentity(parentStatus);
  const handle = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStatus = await handle.stat({ bigint: true });
    if (!openedStatus.isDirectory() || !sameDirectory(identity, openedStatus)) {
      throw manifestError();
    }
    return { parent, path, identity, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
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

async function replayExact(
  destination: AuthenticatedDestination,
  content: string,
  synchronizeDirectory: ((path: string) => Promise<void>) | undefined,
  beforeOperation: ((operation: ExecutionPreflightIntentPreparationFileSystemOperation) =>
  Promise<void>) | undefined,
): Promise<boolean> {
  await invokeBefore(beforeOperation, 'READ_EXISTING');
  await assertParentIdentity(destination);
  let selected;
  try {
    selected = await lstat(destination.path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (!validProtectedFile(selected)) throw manifestError();
  await assertParentIdentity(destination);
  const handle = await open(destination.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(fileIdentity(selected), opened) || !validProtectedFile(opened)) {
      throw manifestError();
    }
    const stored = await handle.readFile('utf8');
    if (Buffer.byteLength(stored, 'utf8') !== Number(opened.size)
      || stored !== content || canonicalStringifyJson(parseJson(stored)) !== stored) {
      throw manifestError();
    }
    await handle.sync();
    await synchronizeAuthenticatedDirectory(destination, synchronizeDirectory, beforeOperation);
    await assertOutputIdentity(destination, fileIdentity(opened));
    return true;
  } finally {
    await handle.close();
  }
}

async function publishExclusive(
  destination: AuthenticatedDestination,
  content: string,
  synchronizeDirectory: ((path: string) => Promise<void>) | undefined,
  beforeOperation: ((operation: ExecutionPreflightIntentPreparationFileSystemOperation) =>
  Promise<void>) | undefined,
): Promise<void> {
  const temporaryPath = join(destination.parent,
    `.preflight-preparation-${randomUUID()}.tmp`);
  let linked = false;
  let published = false;
  let handle: FileHandle | null = null;
  try {
    await invokeBefore(beforeOperation, 'CREATE_TEMPORARY');
    await assertParentIdentity(destination);
    handle = await open(temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await assertParentIdentity(destination);
    await handle.chmod(0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    const status = await handle.stat({ bigint: true });
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    if (!validProtectedFile(status) || status.size !== BigInt(expectedBytes)
      || status.nlink !== 1n) throw manifestError();
    const replay = Buffer.alloc(expectedBytes);
    const read = await handle.read(replay, 0, replay.length, 0);
    if (read.bytesRead !== replay.length || replay.toString('utf8') !== content) {
      throw manifestError();
    }
    const inode = fileIdentity(status);
    await invokeBefore(beforeOperation, 'PUBLISH_OUTPUT');
    await assertParentIdentity(destination);
    await link(temporaryPath, destination.path);
    linked = true;
    await assertParentIdentity(destination);
    const linkedStatus = await handle.stat({ bigint: true });
    if (!sameFileIgnoringLinks(inode, linkedStatus) || linkedStatus.nlink !== 2n) {
      throw manifestError();
    }
    await invokeBefore(beforeOperation, 'REMOVE_TEMPORARY');
    await assertParentIdentity(destination);
    await assertPathIdentity(temporaryPath, fileIdentity(linkedStatus));
    await assertParentIdentity(destination);
    await assertPathIdentity(temporaryPath, fileIdentity(linkedStatus));
    await unlink(temporaryPath);
    await assertParentIdentity(destination);
    const publication = await handle.stat({ bigint: true });
    if (!sameFileIgnoringLinks(inode, publication) || publication.nlink !== 1n) {
      throw manifestError();
    }
    await synchronizeAuthenticatedDirectory(destination, synchronizeDirectory, beforeOperation);
    await assertOutputIdentity(destination, fileIdentity(publication));
    published = true;
  } finally {
    if (!published) {
      if (handle !== null) {
        if (linked) await unlinkIfSame(destination, destination.path, handle,
          'ROLLBACK_OUTPUT', beforeOperation);
        await unlinkIfSame(destination, temporaryPath, handle,
          'ROLLBACK_TEMPORARY', beforeOperation);
      }
    }
    if (handle !== null) await handle.close();
  }
}

async function synchronizeAuthenticatedDirectory(
  destination: AuthenticatedDestination,
  synchronizeDirectory: ((path: string) => Promise<void>) | undefined,
  beforeOperation: ((operation: ExecutionPreflightIntentPreparationFileSystemOperation) =>
  Promise<void>) | undefined,
): Promise<void> {
  await invokeBefore(beforeOperation, 'SYNC_DIRECTORY');
  await assertParentIdentity(destination);
  await assertDirectoryHandleIdentity(destination);
  if (synchronizeDirectory === undefined) await destination.handle.sync();
  else await synchronizeDirectory(destination.parent);
  await assertParentIdentity(destination);
  await assertDirectoryHandleIdentity(destination);
}

async function unlinkIfSame(
  destination: AuthenticatedDestination,
  path: string,
  handle: FileHandle,
  operation: 'ROLLBACK_OUTPUT' | 'ROLLBACK_TEMPORARY',
  beforeOperation: ((operation: ExecutionPreflightIntentPreparationFileSystemOperation) =>
  Promise<void>) | undefined,
): Promise<void> {
  try {
    await invokeBefore(beforeOperation, operation);
    await assertParentIdentity(destination);
    const inode = await handle.stat({ bigint: true });
    await assertPathIdentity(path, fileIdentity(inode));
    await assertParentIdentity(destination);
    await assertPathIdentity(path, fileIdentity(inode));
    await unlink(path);
  } catch {
    // A cleanup fence failure must never authorize deleting an unproven replacement.
  }
}

async function assertParentIdentity(destination: AuthenticatedDestination): Promise<void> {
  const status = await lstat(destination.parent, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()
    || !sameDirectory(destination.identity, status)) throw manifestError();
}

async function assertDirectoryHandleIdentity(destination: AuthenticatedDestination): Promise<void> {
  const status = await destination.handle.stat({ bigint: true });
  if (!status.isDirectory() || !sameDirectory(destination.identity, status)) throw manifestError();
}

async function assertOutputIdentity(
  destination: AuthenticatedDestination,
  identity: FileIdentity,
): Promise<void> {
  await assertParentIdentity(destination);
  await assertPathIdentity(destination.path, identity);
}

async function assertPathIdentity(path: string, identity: FileIdentity): Promise<void> {
  const status = await lstat(path, { bigint: true });
  if (status.isSymbolicLink() || !sameFile(identity, status)) throw manifestError();
}

function validProtectedFile(status: Readonly<{
  isFile(): boolean;
  isSymbolicLink(): boolean;
  mode: bigint;
  uid: bigint;
  size: bigint;
}>): boolean {
  const uid = process.getuid?.();
  return status.isFile() && !status.isSymbolicLink()
    && (status.mode & 0o777n) === 0o600n
    && status.size > 0n && status.size <= BigInt(MAX_MANIFEST_BYTES)
    && (uid === undefined || status.uid === BigInt(uid));
}

function directoryIdentity(status: Readonly<{ dev: bigint; ino: bigint }>): DirectoryIdentity {
  return Object.freeze({ dev: status.dev, ino: status.ino });
}

function fileIdentity(status: Readonly<{
  dev: bigint;
  ino: bigint;
  nlink: bigint;
}>): FileIdentity {
  return Object.freeze({ dev: status.dev, ino: status.ino, nlink: status.nlink });
}

function sameDirectory(
  identity: DirectoryIdentity,
  status: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
  return identity.dev === status.dev && identity.ino === status.ino;
}

function sameFile(
  identity: FileIdentity,
  status: Readonly<{ dev: bigint; ino: bigint; nlink: bigint }>,
): boolean {
  return sameFileIgnoringLinks(identity, status) && identity.nlink === status.nlink;
}

function sameFileIgnoringLinks(
  identity: FileIdentity,
  status: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
  return identity.dev === status.dev && identity.ino === status.ino;
}

async function invokeBefore(
  beforeOperation: ((operation: ExecutionPreflightIntentPreparationFileSystemOperation) =>
  Promise<void>) | undefined,
  operation: ExecutionPreflightIntentPreparationFileSystemOperation,
): Promise<void> {
  if (beforeOperation !== undefined) await beforeOperation(operation);
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
