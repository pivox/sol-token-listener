import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { literalModuleSpecifiers } from './helpers/execution-boundary.js';

const portUrl = new URL('../src/ports/execution-live-repository.ts', import.meta.url);
// H1 changes exactly these four production modules: the claim port/storage and
// the durable live read/deadline port/storage. The older injectable #51-G
// executor graph is deliberately excluded because it owns pre-existing signer
// and submission capabilities that H1 neither composes nor changes.
const h1ProductionModules = Object.freeze([
  Object.freeze({
    url: new URL('../src/ports/execution-intent-repository.ts', import.meta.url),
    allowedDependencies: new Set(['../domain/execution-intent.js']),
  }),
  Object.freeze({
    url: portUrl,
    allowedDependencies: new Set([
      '../domain/execution-live.js',
      '../domain/execution-live-signed-simulation.js',
      '../domain/execution-intent.js',
      '../domain/execution-reconciliation.js',
      '../executor-risk/reconciliation-service.js',
      './execution-intent-repository.js',
      './execution-simulation-gateway.js',
    ]),
  }),
  Object.freeze({
    url: new URL('../src/storage/execution-intent.repository.ts', import.meta.url),
    allowedDependencies: new Set([
      'node:crypto',
      'node:util/types',
      '@solana/web3.js',
      '../domain/execution-intent.js',
      '../ports/execution-intent-repository.js',
      './database.js',
    ]),
  }),
  Object.freeze({
    url: new URL('../src/storage/execution-live.repository.ts', import.meta.url),
    allowedDependencies: new Set([
      'node:crypto',
      'node:util/types',
      'bs58',
      'pg',
      '../domain/execution-live.js',
      '../domain/execution-live-signed-simulation.js',
      '../domain/execution-intent.js',
      '../domain/execution-reconciliation.js',
      '../ports/execution-intent-repository.js',
      '../ports/execution-live-repository.js',
      '../ports/execution-simulation-gateway.js',
      './database.js',
      './execution-intent.repository.js',
      './execution-risk.repository.js',
    ]),
  }),
]);

void test('live repository port exposes only closed durable lifecycle commands', async () => {
  const source = await readFile(portUrl, 'utf8');
  for (const method of [
    'persistSigned',
    'inspectSignedTransaction',
    'authenticatePersistedSignedTransaction',
    'recordSignedSimulation',
    'revokeBeforeSubmission',
    'beginSubmission',
    'recordSubmissionOutcome',
    'recordConfirmation',
    'readConfirmationWork',
    'commitReconciliation',
    'readReconciliationWork',
    'createDeadlineExitIntent',
    'createNextDeadlineExitIntent',
  ]) assert.match(source, new RegExp(`readonly ${method}:|${method}\\(`, 'u'));
  for (const contract of [
    'ExecutionLiveConfirmationWorkV1',
    'ExecutionLiveReconciliationWorkV1',
  ]) assert.match(source, new RegExp(`interface ${contract}\\b`, 'u'));
  assert.doesNotMatch(
    source,
    /Keypair|sendRawTransaction|sendTransaction|Connection|PRIVATE|SECRET/u,
  );
  assert.doesNotMatch(source, /\bany\b/u);
});

void test('H1 durable modules import no RPC, keypair, signer, or submission gateway', async () => {
  for (const module of h1ProductionModules) {
    const path = fileURLToPath(module.url);
    const source = await readFile(module.url, 'utf8');
    assert.deepEqual(h1DependencyViolations(source, path, module.allowedDependencies), []);
  }

  const durableContract = "import type { ExecutionSimulationEvidenceV1 } from '../ports/execution-simulation-gateway.js';";
  assert.deepEqual(h1DependencyViolations(
    durableContract,
    'durable-contract.ts',
    new Set(['../ports/execution-simulation-gateway.js']),
  ), []);
  for (const prohibitedSource of [
    "import { Connection } from '@solana/web3.js';",
    "import '../executor-live/keypair-loader.js';",
    "void import('../executor-live/submission-gateway.js');",
    "import type { RpcProvider } from '../domain/rpc-provider.js';",
    "import type { MarketRpcReader } from './market-rpc-reader.js';",
  ]) assert.notDeepEqual(h1DependencyViolations(
    prohibitedSource,
    'prohibited-capability.ts',
    new Set<string>(),
  ), []);
});

function h1DependencyViolations(
  source: string,
  sourcePath: string,
  allowedDependencies: ReadonlySet<string>,
): readonly string[] {
  const violations: string[] = [];
  for (const specifier of literalModuleSpecifiers(source, sourcePath)) {
    if (!allowedDependencies.has(specifier)) {
      violations.push(`H1 module dependency is outside its allowlist: ${specifier}`);
    }
  }
  if (hasDynamicModuleLoading(source, sourcePath)) {
    violations.push('Dynamic module loading is forbidden in H1 modules.');
  }
  return Object.freeze(violations);
}

function hasDynamicModuleLoading(source: string, sourcePath: string): boolean {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      found = true;
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
