import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const source = await readFile(new URL('../scripts/deployment-smoke.mjs', import.meta.url), 'utf8');

function harness(fetchImpl: typeof fetch = async () => { throw new Error('Unexpected fetch'); }) {
  const context = createContext({
    Error, TypeError, AggregateError, Buffer, AbortController, AbortSignal,
    setTimeout, clearTimeout, fetch: fetchImpl,
    deadlineAt: Date.now() + 60_000, postgresPassword: 'generated-test-password',
    baseUrl: 'http://127.0.0.1:43210', cleanupDeadlineAt: null, activeSignalRuntime: null,
    projectResourceChecks: [], environment: {}, deploymentImages: {},
    canonicalMigrations: [], signalExitCodes: { SIGINT: 130, SIGTERM: 143 },
  });
  runInContext(
    source.slice(source.indexOf('const GLOBAL_TIMEOUT_MS'), source.indexOf('const root ='))
      + source.slice(source.indexOf('async function runDeployment')),
    context,
  );
  const api = runInContext(`({
    phase: typeof smokePhase === 'function' ? smokePhase : async (_phase, operation) => operation(),
    line: deploymentFailureLine, request: requestWithDeadline,
    body: readBoundedBody, sse: readSseToEof, deployment: runDeployment,
  })`, context) as {
    phase: (phase: string, operation: () => Promise<unknown>) => Promise<unknown>;
    line: (error: unknown) => string;
    request: (url: string) => Promise<unknown>;
    body: (response: { body: ReadableStream<Uint8Array> }, label: string) => Promise<unknown>;
    sse: (body: ReadableStream<Uint8Array>, controller: AbortController) => Promise<unknown>;
    deployment: (signal: null) => Promise<number>;
  };
  return { ...api, context };
}

function brokenBody(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.error(error); } });
}

void test('fetch rejection retains original error and safe phase, operation and cause code', async () => {
  const failure = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  const api = harness(async () => { throw failure; });
  await assert.rejects(api.phase('PUBLIC_HEALTH', () => api.request('http://127.0.0.1:43210')), (error) => error === failure);
  assert.equal(api.line(failure), 'Deployment smoke failed: TypeError(validation){phase=PUBLIC_HEALTH,operation=HTTP_HEADERS,transport=ECONNREFUSED}.\n');
});

void test('bounded body rejection is distinct from headers and preserves its transport cause', async () => {
  const failure = new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } });
  const api = harness();
  await assert.rejects(api.phase('FRONTEND', () => api.body({ body: brokenBody(failure) }, 'secret-url')), (error) => error === failure);
  assert.equal(api.line(failure), 'Deployment smoke failed: TypeError(validation){phase=FRONTEND,operation=HTTP_BODY,transport=UND_ERR_SOCKET}.\n');
});

void test('SSE read rejection has its own operation and does not relax shutdown assertions', async () => {
  const failure = new TypeError('terminated', { cause: { code: 'ECONNRESET' } });
  const api = harness();
  await assert.rejects(api.phase('SSE_SHUTDOWN', () => api.sse(brokenBody(failure), new AbortController())), (error) => error === failure);
  assert.equal(api.line(failure), 'Deployment smoke failed: TypeError(validation){phase=SSE_SHUTDOWN,operation=SSE_BODY,transport=ECONNRESET}.\n');
  assert.match(source, /if \(shutdownOffset < 0\) throw new Error\('SSE ended without server_shutdown\.'\)/u);
});

void test('cleanup annotation cannot replace the first phase and aggregate members stay distinct', async () => {
  const api = harness();
  const primary = new TypeError('fetch failed');
  const cleanup = new Error('cleanup failed');
  await assert.rejects(api.phase('PUBLIC_HEALTH', async () => { throw primary; }));
  await assert.rejects(api.phase('CLEANUP', async () => { throw primary; }));
  await assert.rejects(api.phase('CLEANUP', async () => { throw cleanup; }));
  const line = api.line(new AggregateError([primary, cleanup], 'secret aggregate'));
  assert.match(line, /TypeError\(validation\)\{phase=PUBLIC_HEALTH\}/u);
  assert.match(line, /Error\(cleanup\)\{phase=CLEANUP\}/u);
});

void test('a phase that throws an aggregate keeps its own safe phase', async () => {
  const api = harness();
  const failure = new AggregateError([new TypeError('secret')], 'secret');
  await assert.rejects(api.phase('BUILD', async () => { throw failure; }), (error) => error === failure);
  assert.equal(api.line(failure), 'Deployment smoke failed: AggregateError(1)[TypeError(validation)]{phase=BUILD}.\n');
});

void test('untrusted names, messages, codes and phase names never become public fields', async () => {
  const api = harness();
  const secret = 'PRIVATE_CREDENTIAL_123';
  const failure = Object.assign(new TypeError(`https://${secret}.invalid\n${secret}`), {
    name: secret,
    code: secret,
    cause: { code: secret, message: secret },
  });
  await assert.rejects(api.phase(secret, async () => { throw failure; }));
  const line = api.line(failure);
  assert.equal(line, 'Deployment smoke failed: UnknownError(validation).\n');
  for (const value of [secret, { name: secret, message: secret, code: secret }, null, undefined]) {
    assert.equal(api.line(value), 'Deployment smoke failed: UnknownError(non_error).\n');
  }
});

void test('aggregate diagnostics stay bounded and a successful phase preserves return value', async () => {
  const api = harness();
  assert.equal(await api.phase('PUBLIC_HEALTH', async () => 42), 42);
  const failure = new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  await assert.rejects(api.phase('PUBLIC_HEALTH', async () => { throw failure; }));
  const nested = new AggregateError(Array.from({ length: 20 }, () => new AggregateError(Array.from({ length: 20 }, () => failure), 'secret')), 'secret');
  const line = api.line(nested);
  assert.ok(Buffer.byteLength(line) <= 1_024);
  assert.doesNotMatch(line, /secret/u);
  assert.ok(line.endsWith('.\n'));
});

void test('diagnostic getters cannot leak after allowlisting or throw out of the formatter', () => {
  const api = harness();
  const secret = 'PRIVATE_GETTER_SECRET';
  let codeReads = 0;
  let nameReads = 0;
  const changing = new TypeError('fetch failed');
  Object.defineProperties(changing, {
    code: { get: () => ++codeReads === 1 ? 'ECONNRESET' : secret },
    name: { get: () => ++nameReads === 1 ? 'TypeError' : secret },
  });
  assert.equal(api.line(changing), 'Deployment smoke failed: TypeError(validation){transport=ECONNRESET}.\n');
  const throwing = new TypeError('secret');
  Object.defineProperty(throwing, 'message', { get() { throw new Error(secret); } });
  assert.equal(api.line(throwing), 'Deployment smoke failed: UnknownError(diagnostic_unavailable).\n');
});

void test('malformed aggregate members cannot leak a fake count or run an unbounded iterator', () => {
  const api = harness();
  const malformed = new AggregateError([], 'secret');
  Object.defineProperty(malformed, 'errors', {
    value: { length: 'PRIVATE_COUNT_SECRET', *[Symbol.iterator]() { yield new Error('secret'); } },
  });
  assert.equal(api.line(malformed), 'Deployment smoke failed: UnknownError(diagnostic_unavailable).\n');
  const errors = [new Error('secret')];
  Object.defineProperty(errors, Symbol.iterator, { value() { throw new Error('Do not invoke arbitrary iterators'); } });
  const bounded = new AggregateError([], 'secret');
  Object.defineProperty(bounded, 'errors', { value: errors });
  assert.equal(api.line(bounded), 'Deployment smoke failed: AggregateError(1)[Error(validation)].\n');
});

void test('real deployment sequencing attaches the failing phase and preserves successful cleanup', async () => {
  const api = harness();
  const failure = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  api.context.injectedFailure = failure;
  runInContext(`
    installSmokeSignalHandlers = () => ({ received: () => null, restore() {} });
    compose = async () => ({ stdout: '', stderr: '' });
    composeCommand = (args) => args;
    discoverFrontendBaseUrl = async () => 'http://127.0.0.1:43210';
    assertNonRoot = async () => undefined;
    assertPublicHealth = async () => { throw injectedFailure; };
    runDocker = async () => ({ stdout: '', stderr: '' });
    cleanupExplicitImages = async () => undefined;
  `, api.context);
  await assert.rejects(api.deployment(null), (error) => error === failure);
  assert.equal(api.line(failure), 'Deployment smoke failed: TypeError(validation){phase=PUBLIC_HEALTH,transport=ECONNRESET}.\n');
});
