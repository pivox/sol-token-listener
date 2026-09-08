import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createExecutionPreflightIntentPreparationManifest,
  createExecutionPreflightIntentPreparationManifestWriter,
  ExecutionPreflightIntentPreparationManifestError,
  type ExecutionPreflightIntentPreparationManifestInputV1,
} from '../src/executor-preflight-preparation/manifest.js';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;
const CREATED_AT_MS = 1_788_000_000_000;
const PREPARED_AT_MS = CREATED_AT_MS + 1_000;
const EXPIRES_AT_MS = PREPARED_AT_MS + 30_000;

void test('creates a frozen, closed, redacted and versioned manifest', () => {
  const manifest = createExecutionPreflightIntentPreparationManifest(validInput());

  assert.equal(Object.isFrozen(manifest), true);
  assert.deepEqual(Object.keys(manifest), [
    'schemaVersion',
    'runId', 'runFingerprint',
    'pairId', 'pairFingerprint',
    'targetIntentId', 'simulationIntentId',
    'assessmentId', 'assessmentFingerprint',
    'artifactId', 'artifactFingerprint',
    'createdAtMs', 'preparedAtMs', 'expiresAtMs', 'purgeAfterMs',
    'state', 'canaryStatus', 'paperMainnet49Status', 'liveCapabilityPresent',
  ]);
  assert.equal(manifest.schemaVersion,
    'execution-preflight-intent-preparation-manifest.v1');
  assert.equal(manifest.state, 'PREFLIGHT_INTENT_PREPARED');
  assert.equal(manifest.canaryStatus, 'CANARY_NOT_STARTED');
  assert.equal(manifest.paperMainnet49Status, 'NON_EXECUTED_NON_VALIDATED');
  assert.equal(manifest.liveCapabilityPresent, false);
  assert.doesNotMatch(JSON.stringify(manifest),
    /mint|amount|url|lease|secret|private|wallet|keypair|transaction/iu);
});

void test('rejects mutable, extended, malformed and temporally incoherent manifest inputs', () => {
  const valid = validInput();
  const cases: unknown[] = [
    { ...valid },
    Object.freeze({ ...valid, mint: 'forbidden' }),
    Object.freeze({ ...valid, runFingerprint: 'f'.repeat(63) }),
    Object.freeze({ ...valid, targetIntentId: valid.simulationIntentId }),
    Object.freeze({ ...valid, preparedAtMs: CREATED_AT_MS - 1 }),
    Object.freeze({ ...valid, expiresAtMs: PREPARED_AT_MS }),
    Object.freeze({ ...valid, purgeAfterMs: PREPARED_AT_MS + FOUR_HOURS_MS - 1 }),
  ];
  for (const value of cases) {
    assert.throws(
      () => createExecutionPreflightIntentPreparationManifest(value),
      isRedactedManifestError,
    );
  }

  const accessor = Object.freeze(Object.defineProperty({}, 'runId', {
    enumerable: true,
    get: () => { throw new Error('secret path'); },
  }));
  assert.throws(() => createExecutionPreflightIntentPreparationManifest(accessor),
    isRedactedManifestError);

  const hostileOptions = Object.defineProperty({}, 'synchronizeDirectory', {
    get: () => { throw new Error('sensitive dependency detail'); },
  });
  assert.throws(
    () => createExecutionPreflightIntentPreparationManifestWriter(hostileOptions),
    isRedactedManifestError,
  );
});

void test('writes one canonical owner-only manifest without overwriting files or following symlinks',
  async (context) => {
    const root = await temporaryDirectory(context, 'preflight-preparation-manifest-');
    const writer = createExecutionPreflightIntentPreparationManifestWriter();
    assert.equal(Object.isFrozen(writer), true);
    const output = join(root, 'prepared.json');

    const manifest = await writer.write(output, validInput());
    const stored = await readFile(output, 'utf8');
    const status = await lstat(output);
    assert.equal(status.isFile(), true);
    assert.equal(status.isSymbolicLink(), false);
    assert.equal(status.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(stored), manifest);
    assert.equal(stored.endsWith('\n'), false);

    await assert.rejects(writer.write(output, validInput()), isRedactedManifestError);
    assert.equal(await readFile(output, 'utf8'), stored);

    const protectedPath = join(root, 'protected.json');
    const symlinkPath = join(root, 'linked.json');
    await writeFile(protectedPath, 'protected', { mode: 0o600 });
    await symlink(protectedPath, symlinkPath);
    await assert.rejects(writer.write(symlinkPath, validInput()), isRedactedManifestError);
    assert.equal(await readFile(protectedPath, 'utf8'), 'protected');
    assert.deepEqual((await readdir(root)).filter((name) => name.includes('.tmp')), []);
  });

void test('requires an absolute path, an existing parent and a location outside every Git checkout',
  async (context) => {
    const root = await temporaryDirectory(context, 'preflight-preparation-path-');
    const writer = createExecutionPreflightIntentPreparationManifestWriter();

    await assert.rejects(writer.write('relative.json', validInput()), isRedactedManifestError);
    await assert.rejects(
      writer.write(join(root, 'missing', 'manifest.json'), validInput()),
      isRedactedManifestError,
    );

    const checkout = join(root, 'checkout');
    await mkdir(checkout);
    await writeFile(join(checkout, '.git'), 'gitdir: redacted\n', { mode: 0o600 });
    await assert.rejects(
      writer.write(join(checkout, 'manifest.json'), validInput()),
      isRedactedManifestError,
    );

    const checkoutAlias = join(root, 'checkout-alias');
    await symlink(checkout, checkoutAlias);
    await assert.rejects(
      writer.write(join(checkoutAlias, 'manifest.json'), validInput()),
      isRedactedManifestError,
    );
    assert.deepEqual(await readdir(checkout), ['.git']);
  });

void test('removes every publication and temporary file when directory fsync fails',
  async (context) => {
    const root = await temporaryDirectory(context, 'preflight-preparation-fsync-');
    const output = join(root, 'manifest.json');
    const synchronized: string[] = [];
    const writer = createExecutionPreflightIntentPreparationManifestWriter({
      synchronizeDirectory: async (path) => {
        synchronized.push(path);
        throw new Error('sensitive durability detail');
      },
    });

    await assert.rejects(writer.write(output, validInput()), isRedactedManifestError);
    assert.deepEqual(synchronized, [await realpath(root)]);
    assert.deepEqual(await readdir(root), []);
  });

function validInput(
  overrides: Partial<ExecutionPreflightIntentPreparationManifestInputV1> = {},
): ExecutionPreflightIntentPreparationManifestInputV1 {
  return Object.freeze({
    runId: `execution_preflight_preparation_${'1'.repeat(64)}`,
    runFingerprint: '2'.repeat(64),
    pairId: `execution_preflight_intent_pair_${'3'.repeat(64)}`,
    pairFingerprint: '4'.repeat(64),
    targetIntentId: `execution_intent_${'5'.repeat(64)}`,
    simulationIntentId: `execution_intent_${'6'.repeat(64)}`,
    assessmentId: `execution_dry_run_assessment_${'7'.repeat(64)}`,
    assessmentFingerprint: '8'.repeat(64),
    artifactId: `execution_simulation_artifact_${'9'.repeat(64)}`,
    artifactFingerprint: 'a'.repeat(64),
    createdAtMs: CREATED_AT_MS,
    preparedAtMs: PREPARED_AT_MS,
    expiresAtMs: EXPIRES_AT_MS,
    purgeAfterMs: PREPARED_AT_MS + FOUR_HOURS_MS,
    ...overrides,
  });
}

async function temporaryDirectory(
  context: TestContext,
  prefix: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function isRedactedManifestError(error: unknown): boolean {
  assert.ok(error instanceof ExecutionPreflightIntentPreparationManifestError);
  assert.equal(error.name, 'ExecutionPreflightIntentPreparationManifestError');
  assert.equal(error.code, 'PREFLIGHT_PREPARATION_EXPORT_FAILED');
  assert.equal(error.message, 'Execution preflight preparation manifest export failed.');
  assert.doesNotMatch(error.message, /path|secret|sensitive|git|symlink|fsync/iu);
  return true;
}
