import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import {
  executionBoundaryViolations,
} from './helpers/execution-boundary.js';
import type {
  ExecutionDryRunAssessmentDraftV1,
  ExecutionDryRunAssessmentV1,
} from '../src/domain/execution-dry-run.js';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';
import type { ExecutionDryRunRepository } from '../src/ports/execution-dry-run-repository.js';

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
type IfEquals<Left, Right, EqualValue, DifferentValue> = (
  <Value>() => Value extends Left ? 1 : 2
) extends (
  <Value>() => Value extends Right ? 1 : 2
) ? EqualValue : DifferentValue;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */
type Equal<Left, Right> = IfEquals<Left, Right, true, false>;
type Expect<Value extends true> = Value;
type OptionalKeys<Value> = {
  [Key in keyof Value]-?: object extends Pick<Value, Key> ? Key : never;
}[keyof Value];
type ReadonlyKeys<Value> = {
  [Key in keyof Value]-?: IfEquals<
    Pick<Value, Key>, Readonly<Pick<Value, Key>>, Key, never
  >;
}[keyof Value];

interface Surface {
  readonly complete: (
    claim: ClaimedExecutionIntent,
    assessment: ExecutionDryRunAssessmentDraftV1,
  ) => Promise<ExecutionDryRunAssessmentV1>;
  readonly findExact: (
    assessment: ExecutionDryRunAssessmentDraftV1,
  ) => Promise<ExecutionDryRunAssessmentV1 | null>;
}

type AssertAll<Assertions extends Readonly<Record<string, true>>> = Assertions;
type ExactSurfaceAssertions = AssertAll<{
  keys: Expect<Equal<keyof ExecutionDryRunRepository, keyof Surface>>;
  readonlyKeys: Expect<Equal<ReadonlyKeys<ExecutionDryRunRepository>, keyof ExecutionDryRunRepository>>;
  optionalKeys: Expect<Equal<OptionalKeys<ExecutionDryRunRepository>, never>>;
  complete: Expect<Equal<ExecutionDryRunRepository['complete'], Surface['complete']>>;
  findExact: Expect<Equal<ExecutionDryRunRepository['findExact'], Surface['findExact']>>;
}>;
void (null as never as ExactSurfaceAssertions);

void test('execution dry-run repository is a type-only, domain-only sidecar boundary', async () => {
  const sourceUrl = new URL('../src/ports/execution-dry-run-repository.ts', import.meta.url);
  const sourcePath = fileURLToPath(sourceUrl);
  const source = await readFile(sourceUrl, 'utf8');
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  assert.equal(sourceFile.statements.length, 3);
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  assert.equal(imports.length, 2);
  assert.ok(imports.every((statement) => statement.importClause?.isTypeOnly));
  assert.deepEqual(
    imports.map((statement) => ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text : '').sort(),
    ['../domain/execution-dry-run.js', './execution-intent-repository.js'],
  );
  const declaration = sourceFile.statements.find(ts.isInterfaceDeclaration);
  assert.ok(declaration?.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  ));
  assert.equal(declaration?.name.text, 'ExecutionDryRunRepository');
  assert.deepEqual(executionBoundaryViolations(
    source, sourcePath, fileURLToPath(new URL('../', import.meta.url)),
  ), []);
});

function compileTimeNegativeAssertions(): void {
  const repository = null as never as ExecutionDryRunRepository;
  const claim = null as never as ClaimedExecutionIntent;
  const assessment = null as never as ExecutionDryRunAssessmentDraftV1;

  // @ts-expect-error sidecar completion accepts no signer capability.
  void repository.complete(claim, { ...assessment, signer: 'capability' });
  // @ts-expect-error sidecar lookup accepts no wallet capability.
  void repository.findExact({ ...assessment, wallet: 'capability' });
  // @ts-expect-error sidecar completion has no extra execution parameter.
  void repository.complete(claim, assessment, 'extra');
}
void compileTimeNegativeAssertions;
