import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import {
  createExecutionIntentDraft,
  type ExecutionIntentDraftV1,
  type ExecutionIntentReasonCode,
  type ExecutionIntentStatus,
  type ExecutionIntentV1,
} from '../src/domain/execution-intent.js';
import {
  executionBoundaryViolations,
} from './helpers/execution-boundary.js';
import type {
  ClaimedExecutionIntent,
  ExecutionClaimPurpose,
  ExecutionIntentRepository,
  ExecutionIntentTransitionEvidenceV1,
  ExecutionIntentTransitionInput,
} from '../src/ports/execution-intent-repository.js';

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left] ? true : false
  : false;
type Expect<Value extends true> = Value;

type CreateResult = Readonly<{
  readonly kind: 'CREATED' | 'REPLAYED';
  readonly intent: ExecutionIntentV1;
}>;
type ClaimOptions = Readonly<{
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly purpose: ExecutionClaimPurpose;
}>;
type AttemptResult = Readonly<{
  readonly intentId: string;
  readonly attemptNumber: number;
  readonly startedAtMs: number;
}>;
type FinishAttemptInput = Readonly<{
  readonly attemptNumber: number;
  readonly status: 'COMPLETED' | 'ABANDONED';
  readonly effectiveVenue: 'PUMP_FUN' | 'PUMP_SWAP' | null;
  readonly providerId: string | null;
  readonly reasonCode: ExecutionIntentReasonCode;
}>;

type ExactSurfaceAssertions = readonly [
  Expect<Equal<keyof ExecutionIntentRepository,
    'create' | 'claim' | 'beginAttempt' | 'finishAttempt' | 'renew' | 'release' | 'transition' | 'expirePreSubmission' | 'read'>>,
  Expect<Equal<ExecutionIntentRepository['create'], (draft: ExecutionIntentDraftV1) => Promise<CreateResult>>>,
  Expect<Equal<ExecutionIntentRepository['claim'], (options: ClaimOptions) => Promise<ClaimedExecutionIntent | null>>>,
  Expect<Equal<ExecutionIntentRepository['beginAttempt'], (claim: ClaimedExecutionIntent) => Promise<AttemptResult>>>,
  Expect<Equal<ExecutionIntentRepository['finishAttempt'], (claim: ClaimedExecutionIntent, input: FinishAttemptInput) => Promise<boolean>>>,
  Expect<Equal<ExecutionIntentRepository['renew'], (claim: ClaimedExecutionIntent, leaseMs: number) => Promise<boolean>>>,
  Expect<Equal<ExecutionIntentRepository['release'], (claim: ClaimedExecutionIntent) => Promise<boolean>>>,
  Expect<Equal<ExecutionIntentRepository['transition'], (claim: ClaimedExecutionIntent, input: ExecutionIntentTransitionInput) => Promise<ExecutionIntentV1>>>,
  Expect<Equal<ExecutionIntentRepository['expirePreSubmission'], (limit: number) => Promise<number>>>,
  Expect<Equal<ExecutionIntentRepository['read'], (intentId: string) => Promise<ExecutionIntentV1 | null>>>,
  Expect<Equal<ExecutionClaimPurpose, 'EXECUTE' | 'CONFIRM' | 'RECONCILE'>>,
  Expect<Equal<keyof ClaimedExecutionIntent, 'intent' | 'leaseOwner' | 'leaseToken' | 'leaseExpiresAtMs'>>,
  Expect<Equal<ClaimedExecutionIntent['intent'], ExecutionIntentV1>>,
  Expect<Equal<ClaimedExecutionIntent['leaseOwner'], string>>,
  Expect<Equal<ClaimedExecutionIntent['leaseToken'], string>>,
  Expect<Equal<ClaimedExecutionIntent['leaseExpiresAtMs'], number>>,
  Expect<Equal<keyof ExecutionIntentTransitionEvidenceV1, 'payloadVersion' | 'attemptNumber' | 'sourceEventId' | 'observedAtMs'>>,
  Expect<Equal<ExecutionIntentTransitionEvidenceV1['payloadVersion'], 1>>,
  Expect<Equal<ExecutionIntentTransitionEvidenceV1['attemptNumber'], number | null>>,
  Expect<Equal<ExecutionIntentTransitionEvidenceV1['sourceEventId'], string | null>>,
  Expect<Equal<ExecutionIntentTransitionEvidenceV1['observedAtMs'], number>>,
  Expect<Equal<keyof ExecutionIntentTransitionInput, 'intentId' | 'expectedStatus' | 'nextStatus' | 'leaseToken' | 'reasonCode' | 'humanMessage' | 'activationPhase' | 'evidence'>>,
  Expect<Equal<ExecutionIntentTransitionInput['intentId'], string>>,
  Expect<Equal<ExecutionIntentTransitionInput['expectedStatus'], ExecutionIntentStatus>>,
  Expect<Equal<ExecutionIntentTransitionInput['nextStatus'], ExecutionIntentStatus>>,
  Expect<Equal<ExecutionIntentTransitionInput['leaseToken'], string>>,
  Expect<Equal<ExecutionIntentTransitionInput['reasonCode'], ExecutionIntentReasonCode>>,
  Expect<Equal<ExecutionIntentTransitionInput['humanMessage'], string>>,
  Expect<Equal<ExecutionIntentTransitionInput['activationPhase'], 'NONE' | 'CANARY' | 'MICRO_LIVE' | 'PILOT'>>,
  Expect<Equal<ExecutionIntentTransitionInput['evidence'], ExecutionIntentTransitionEvidenceV1>>,
];

const exactSurfaceAssertions: ExactSurfaceAssertions = [
  true, true, true, true, true, true, true, true, true, true, true, true, true, true,
  true, true, true, true, true, true, true, true, true, true, true, true, true, true,
  true, true,
];
void exactSurfaceAssertions;

void test('execution intent repository is an allowlisted domain-only persistence boundary', async () => {
  const sourceUrl = new URL('../src/ports/execution-intent-repository.ts', import.meta.url);
  const sourcePath = fileURLToPath(sourceUrl);
  const source = await readFile(sourceUrl, 'utf8');
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const exported = sourceFile.statements.filter(isExportedPortDeclaration);

  assert.equal(imports.length, 1);
  const [domainImport] = imports;
  assert.ok(domainImport?.importClause?.isTypeOnly);
  assert.equal(domainImport?.moduleSpecifier.getText(sourceFile), "'../domain/execution-intent.js'");
  assert.ok(domainImport?.importClause?.namedBindings !== undefined);
  assert.ok(domainImport?.importClause?.namedBindings !== undefined
    && ts.isNamedImports(domainImport.importClause.namedBindings));
  const namedImports = domainImport?.importClause?.namedBindings;
  assert.deepEqual(
    namedImports !== undefined && ts.isNamedImports(namedImports)
      ? namedImports.elements.map((element) => element.name.text).sort()
      : [],
    ['ExecutionIntentDraftV1', 'ExecutionIntentReasonCode', 'ExecutionIntentStatus', 'ExecutionIntentV1'],
  );
  assert.deepEqual(
    exported.map((statement) => declarationName(statement)).sort(),
    [
      'ClaimedExecutionIntent',
      'ExecutionClaimPurpose',
      'ExecutionIntentRepository',
      'ExecutionIntentTransitionEvidenceV1',
      'ExecutionIntentTransitionInput',
    ],
  );
  assert.equal(sourceFile.statements.filter((statement) => hasExportModifier(statement)).length, 5);
  assert.deepEqual(executionBoundaryViolations(source, sourcePath, fileURLToPath(new URL('../', import.meta.url))), []);
  assert.deepEqual(moduleEscapeViolations(sourceFile), []);
  assert.deepEqual(forbiddenTokenViolations(sourceFile), []);
});

void test('execution intent repository contract supports frozen execution lifecycle values', async () => {
  const repository = new StrictFakeExecutionIntentRepository();
  const draft = createExecutionIntentDraft({
    strategyId: 'strategy', strategyVersion: 1, positionId: 'position', logicalCommandId: 'command',
    mint: '11111111111111111111111111111111', side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112', quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9, quoteAmountRaw: 1n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: 'event', decisionFingerprint: 'a'.repeat(64), requestedAtMs: 1, expiresAtMs: 2,
  });
  const created = await repository.create(draft);
  const claim = await repository.claim({ ownerId: 'worker', leaseMs: 30_000, purpose: 'EXECUTE' });
  assert.ok(claim);
  const attempt = await repository.beginAttempt(claim);
  const evidence = Object.freeze({ payloadVersion: 1, attemptNumber: attempt.attemptNumber, sourceEventId: 'event', observedAtMs: 3 } satisfies ExecutionIntentTransitionEvidenceV1);
  const transition = Object.freeze({
    intentId: created.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claim.leaseToken, reasonCode: 'INTENT_LEASE_LOST', humanMessage: 'claimed by worker',
    activationPhase: 'NONE', evidence,
  } satisfies ExecutionIntentTransitionInput);

  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(created.intent));
  assert.ok(Object.isFrozen(claim));
  assert.ok(Object.isFrozen(attempt));
  assert.ok(Object.isFrozen(evidence));
  assert.ok(Object.isFrozen(transition));
  assert.equal(await repository.finishAttempt(claim, {
    attemptNumber: attempt.attemptNumber, status: 'COMPLETED', effectiveVenue: 'PUMP_FUN',
    providerId: 'provider', reasonCode: 'INTENT_DUPLICATE',
  }), true);
  assert.equal(await repository.renew(claim, 30_000), true);
  assert.equal((await repository.transition(claim, transition)).id, created.intent.id);
  assert.equal(await repository.release(claim), true);
  assert.equal(await repository.expirePreSubmission(10), 0);
  assert.equal((await repository.read(created.intent.id))?.id, created.intent.id);
});

function compileTimeNegativeAssertions(): void {
  const repository = null as never as ExecutionIntentRepository;
  const claim = null as never as ClaimedExecutionIntent;
  const evidence: ExecutionIntentTransitionEvidenceV1 = {
    payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: 1,
  };

  // @ts-expect-error claim accepts no caller-controlled clock.
  void repository.claim({ ownerId: 'worker', leaseMs: 1, purpose: 'EXECUTE', nowMs: 1 });
  // @ts-expect-error renew accepts no caller-controlled clock.
  void repository.renew(claim, 1, 2);
  // @ts-expect-error claim options cannot carry a signer capability.
  void repository.claim({ ownerId: 'worker', leaseMs: 1, purpose: 'EXECUTE', signer: 'capability' });
  // @ts-expect-error transition input cannot carry a wallet capability.
  const transition: ExecutionIntentTransitionInput = { intentId: 'id', expectedStatus: 'PENDING', nextStatus: 'PROCESSING', leaseToken: 'lease', reasonCode: 'INTENT_LEASE_LOST', humanMessage: 'message', activationPhase: 'NONE', evidence, wallet: 'capability' };
  // @ts-expect-error claimed values are readonly.
  claim.leaseToken = 'other';
  // @ts-expect-error proof values are readonly.
  evidence.observedAtMs = 2;
  // @ts-expect-error claim purposes are closed.
  const purpose: ExecutionClaimPurpose = 'SUBMIT';
  // @ts-expect-error activation phases are closed.
  transition.activationPhase = 'LIVE';
  // @ts-expect-error transition values are readonly.
  transition.humanMessage = 'other';
  // @ts-expect-error submission is not a repository method.
  void repository.submission();
  void purpose;
}
void compileTimeNegativeAssertions;

class StrictFakeExecutionIntentRepository implements ExecutionIntentRepository {
  private intent: ExecutionIntentV1 | null = null;

  public async create(draft: ExecutionIntentDraftV1): Promise<CreateResult> {
    this.intent = Object.freeze({
      ...draft, status: 'PENDING', attemptCount: 0, lastReasonCode: null, terminalAtMs: null,
      reconciliationCompletedAtMs: null, purgeAfterMs: null, createdAtMs: 1, updatedAtMs: 1,
    });
    return Object.freeze({ kind: 'CREATED', intent: this.intent });
  }

  public async claim(_options: ClaimOptions): Promise<ClaimedExecutionIntent | null> {
    return this.intent === null ? null : Object.freeze({
      intent: this.intent, leaseOwner: 'worker', leaseToken: 'lease', leaseExpiresAtMs: 30_001,
    });
  }

  public async beginAttempt(claim: ClaimedExecutionIntent): Promise<AttemptResult> {
    return Object.freeze({ intentId: claim.intent.id, attemptNumber: 1, startedAtMs: 2 });
  }

  public async finishAttempt(_claim: ClaimedExecutionIntent, _input: FinishAttemptInput): Promise<boolean> { return true; }
  public async renew(_claim: ClaimedExecutionIntent, _leaseMs: number): Promise<boolean> { return true; }
  public async release(_claim: ClaimedExecutionIntent): Promise<boolean> { return true; }
  public async transition(_claim: ClaimedExecutionIntent, _input: ExecutionIntentTransitionInput): Promise<ExecutionIntentV1> { assert.ok(this.intent); return this.intent; }
  public async expirePreSubmission(_limit: number): Promise<number> { return 0; }
  public async read(intentId: string): Promise<ExecutionIntentV1 | null> { return this.intent?.id === intentId ? this.intent : null; }
}

function hasExportModifier(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function isExportedPortDeclaration(
  statement: ts.Statement,
): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration {
  return hasExportModifier(statement) && (
    ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)
  );
}

function declarationName(statement: ts.TypeAliasDeclaration | ts.InterfaceDeclaration): string {
  return statement.name.text;
}

function moduleEscapeViolations(sourceFile: ts.SourceFile): readonly string[] {
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) violations.push('export-from');
    if (ts.isImportEqualsDeclaration(node)) violations.push('import-equals');
    if (ts.isImportTypeNode(node)) violations.push('import-type');
    if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )) violations.push('dynamic-module-load');
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function forbiddenTokenViolations(sourceFile: ts.SourceFile): readonly string[] {
  const forbidden = new Set(['wallet', 'signer', 'transport', 'submission', 'transactionBuilder']);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && forbidden.has(node.text)) violations.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}
