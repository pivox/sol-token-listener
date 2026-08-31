import { dirname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';

const MODULE_EXTENSION = /\.(?:js|ts|mjs|cjs|mts|cts)$/iu;
const FORBIDDEN_BARE_SEGMENTS = new Set([
  'wallet', 'keypair', 'signing', 'submission', 'transaction-builder',
  'transaction-confirmer', 'trade-executor',
]);
const FORBIDDEN_CALLS = new Set([
  'sendTransaction', 'sendRawTransaction', 'sendAndConfirmTransaction',
  'signTransaction', 'signAllTransactions', 'signMessage',
  'submitTransaction', 'submitSignedTransaction', 'submitRawTransaction',
]);
const EXECUTOR_ALLOWED_BARE_MODULES = new Set([
  'pg', 'pino', 'dotenv', 'dotenv/config',
]);
// Exact builtin dependencies observed in both the source and compiled executor graphs.
const EXECUTOR_ALLOWED_NODE_BUILTINS = new Set([
  'node:crypto',
  'node:fs/promises',
  'node:path',
  'node:url',
  'node:util/types',
]);
const EXECUTOR_FORBIDDEN_BARE_MODULES = new Set([
  '@solana/web3.js', '@solana/spl-token',
  '@pump-fun/pump-sdk', '@pump-fun/pump-swap-sdk',
]);
const EXECUTOR_ALLOWED_LOCAL_MODULES = [
  /^(?:dist\/)?src\/executor\/(?:main|config|database|logger|dry-run-worker|runtime)\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/domain\/execution-(?:dry-run|intent)\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/ports\/execution-(?:dry-run-repository|intent-repository)\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/storage\/(?:database|execution-dry-run\.repository|execution-intent\.repository)\.(?:js|ts)$/u,
];
const EXECUTOR_FORBIDDEN_IDENTIFIERS = new Set([
  'Keypair', 'Wallet', 'WalletSigner', 'Signer', 'SecretLoader',
  'keypair', 'wallet', 'signer',
  'createRequire', 'getBuiltinModule', 'eval', 'Function', 'global', 'globalThis',
  'simulateTransaction', 'sendTransaction', 'sendRawTransaction', 'signTransaction',
]);
// These are the only nonliteral element accesses present in the reviewed executor graph.
const EXECUTOR_ALLOWED_DYNAMIC_ELEMENT_ACCESSES = new Set([
  'safe[key]',
  'result[key]',
  'record[key]',
  'EXACT_STATUS_REASONS[status]',
  'value[leadingZeroByteLength]',
  'assessmentRow[key]',
  'row[key]',
  'actual[key]',
  'expected[key]',
  'CLAIM_SQL[options.purpose]',
  'intentValues[key]',
]);

export function executionBoundaryViolations(sourceText: string, sourcePath: string, repositoryRoot: string): readonly string[] {
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) appendSpecifier(node.moduleSpecifier, sourcePath, repositoryRoot, violations);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) appendSpecifier(node.argument.literal, sourcePath, repositoryRoot, violations);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) appendDynamicImport(node, sourcePath, repositoryRoot, violations);
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') appendRequire(node, sourcePath, repositoryRoot, violations);
      else appendDangerousCall(node, violations);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      appendSpecifier(node.moduleReference.expression, sourcePath, repositoryRoot, violations);
      violations.push('require is prohibited in ESM boundary modules.');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export function literalModuleSpecifiers(sourceText: string, sourcePath: string): readonly string[] {
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const append = (node: ts.Expression | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) append(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) append(node.argument.literal);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      append(node.moduleReference.expression);
    }
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      append(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze(specifiers);
}

export function executorBoundaryViolations(
  sourceText: string,
  sourcePath: string,
  repositoryRoot: string,
): readonly string[] {
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [...executionBoundaryViolations(sourceText, sourcePath, repositoryRoot)];
  const specifiers = literalModuleSpecifiers(sourceText, sourcePath);
  for (const specifier of specifiers) {
    if (EXECUTOR_FORBIDDEN_BARE_MODULES.has(specifier)) {
      violations.push(`Forbidden executor module dependency: ${specifier}`);
      continue;
    }
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      if (!EXECUTOR_ALLOWED_NODE_BUILTINS.has(specifier)
        && !EXECUTOR_ALLOWED_BARE_MODULES.has(specifier)) {
        violations.push(`Executor module is outside the allowlist: ${specifier}`);
      }
      continue;
    }
    const normalized = specifier.replace(/[?#].*$/u, '');
    const target = normalized.startsWith('/')
      ? resolve(normalized)
      : resolve(dirname(sourcePath), normalized);
    const relativeTarget = relative(repositoryRoot, target).replaceAll('\\', '/');
    if (!EXECUTOR_ALLOWED_LOCAL_MODULES.some((pattern) => pattern.test(relativeTarget))) {
      violations.push(`Executor local module is outside the allowlist: ${specifier}`);
    }
  }
  appendReflectiveExecutorCapabilityViolations(sourceFile, violations);
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node)) {
      appendExecutorElementAccess(node, sourceFile, violations);
    }
    if (ts.isIdentifier(node) && (
      EXECUTOR_FORBIDDEN_IDENTIFIERS.has(node.text)
      || /(?:load.*secret|secret.*load)/iu.test(node.text)
    )) {
      violations.push(`Forbidden executor capability: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze(violations);
}

function appendRequire(node: ts.CallExpression, sourcePath: string, repositoryRoot: string, violations: string[]): void {
  const argument = node.arguments[0];
  if (node.arguments.length !== 1 || argument === undefined || !ts.isStringLiteralLike(argument)) {
    violations.push('Nonliteral require is prohibited in boundary modules.');
  } else {
    appendSpecifier(argument, sourcePath, repositoryRoot, violations);
  }
  violations.push('require is prohibited in ESM boundary modules.');
}

function appendDynamicImport(node: ts.CallExpression, sourcePath: string, repositoryRoot: string, violations: string[]): void {
  const argument = node.arguments[0];
  if (node.arguments.length !== 1 || argument === undefined || !ts.isStringLiteralLike(argument)) {
    violations.push('Nonliteral dynamic import is prohibited in boundary modules.');
    return;
  }
  appendSpecifier(argument, sourcePath, repositoryRoot, violations);
}

function appendSpecifier(node: ts.Expression | undefined, sourcePath: string, repositoryRoot: string, violations: string[]): void {
  if (node !== undefined && ts.isStringLiteralLike(node) && isForbiddenSpecifier(node.text, sourcePath, repositoryRoot)) {
    violations.push(`Forbidden module dependency: ${node.text}`);
  }
}

function isForbiddenSpecifier(specifier: string, sourcePath: string, repositoryRoot: string): boolean {
  const normalized = specifier.replace(/[?#].*$/u, '').replace(MODULE_EXTENSION, '');
  if (normalized.startsWith('.') || normalized.startsWith('/')) {
    const target = normalized.startsWith('/') ? resolve(normalized) : resolve(dirname(sourcePath), normalized);
    const executionRoot = resolve(repositoryRoot, 'src/execution');
    if (isWithin(target, executionRoot)) return true;
    return hasForbiddenSegment(target);
  }
  return hasForbiddenSegment(normalized);
}

function isWithin(target: string, directory: string): boolean {
  const path = relative(directory, target);
  return path === '' || (!path.startsWith('../') && path !== '..' && !isAbsolute(path));
}

function hasForbiddenSegment(path: string): boolean {
  return path.replaceAll('\\', '/').split('/').some((segment) => FORBIDDEN_BARE_SEGMENTS.has(segment));
}

function appendDangerousCall(node: ts.CallExpression, violations: string[]): void {
  if (ts.isElementAccessExpression(node.expression)) {
    if (isVettedComputedMemberCall(node)) return;
    const argument = node.expression.argumentExpression;
    if (!ts.isStringLiteralLike(argument) && !ts.isNumericLiteral(argument)) {
      violations.push('Computed member call is prohibited in boundary modules.');
    } else if (ts.isStringLiteralLike(argument) && FORBIDDEN_CALLS.has(argument.text)) {
      violations.push(`Forbidden execution call: ${argument.text}`);
    }
    return;
  }
  const name = ts.isIdentifier(node.expression)
    ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : ts.isElementAccessExpression(node.expression) && ts.isStringLiteralLike(node.expression.argumentExpression)
        ? node.expression.argumentExpression.text
        : null;
  if (name !== null && FORBIDDEN_CALLS.has(name)) violations.push(`Forbidden execution call: ${name}`);
}

function isVettedComputedMemberCall(node: ts.CallExpression): boolean {
  const member = node.expression;
  if (!ts.isElementAccessExpression(member)) return false;
  if (isAsyncIteratorCall(node, member)) return true;
  return isConditionValidatorCall(node, member, 'OBSERVED_CONDITION_VALUE_VALIDATORS')
    || isConditionValidatorCall(node, member, 'THRESHOLD_CONDITION_VALUE_VALIDATORS');
}

function isAsyncIteratorCall(node: ts.CallExpression, member: ts.ElementAccessExpression): boolean {
  const argument = member.argumentExpression;
  return member.questionDotToken === undefined
    && node.questionDotToken === undefined
    && node.typeArguments === undefined
    && node.arguments.length === 0
    && ts.isIdentifier(member.expression)
    && member.expression.text === 'body'
    && ts.isPropertyAccessExpression(argument)
    && ts.isIdentifier(argument.expression)
    && argument.expression.text === 'Symbol'
    && argument.name.text === 'asyncIterator';
}

function isConditionValidatorCall(
  node: ts.CallExpression,
  member: ts.ElementAccessExpression,
  validatorName: string,
): boolean {
  const argument = member.argumentExpression;
  const value = node.arguments[0];
  return member.questionDotToken === undefined
    && node.questionDotToken !== undefined
    && node.typeArguments === undefined
    && node.arguments.length === 1
    && ts.isIdentifier(member.expression)
    && member.expression.text === validatorName
    && ts.isIdentifier(argument)
    && argument.text === 'key'
    && value !== undefined
    && ts.isIdentifier(value)
    && value.text === 'value';
}

function appendReflectiveExecutorCapabilityViolations(
  sourceFile: ts.SourceFile,
  violations: string[],
): void {
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) && node.text === 'Reflect' && !isExactReflectOwnKeysReceiver(node))
      || isComputedReflectKey(node)) {
      violations.push(
        'Reflect syntax is prohibited outside exact Reflect.ownKeys(value) calls in executor modules.',
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function isExactReflectOwnKeysReceiver(node: ts.Identifier): boolean {
  const member = node.parent;
  if (!ts.isPropertyAccessExpression(member)
    || member.expression !== node
    || member.name.text !== 'ownKeys'
    || member.questionDotToken !== undefined) return false;
  const call = member.parent;
  const argument = ts.isCallExpression(call) ? call.arguments[0] : undefined;
  return ts.isCallExpression(call)
    && call.expression === member
    && call.questionDotToken === undefined
    && call.typeArguments === undefined
    && call.arguments.length === 1
    && argument !== undefined
    && !ts.isSpreadElement(argument);
}

function isComputedReflectKey(node: ts.Node): boolean {
  if (!ts.isStringLiteralLike(node) || node.text !== 'Reflect') return false;
  const parent = node.parent;
  return (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
    || (ts.isComputedPropertyName(parent) && parent.expression === node);
}

function appendExecutorElementAccess(
  node: ts.ElementAccessExpression,
  sourceFile: ts.SourceFile,
  violations: string[],
): void {
  const argument = node.argumentExpression;
  if (ts.isNumericLiteral(argument)) return;
  if (ts.isStringLiteralLike(argument)) {
    if (FORBIDDEN_CALLS.has(argument.text) || EXECUTOR_FORBIDDEN_IDENTIFIERS.has(argument.text)) {
      violations.push(`Forbidden executor capability: ${argument.text}`);
    }
    return;
  }
  const access = node.getText(sourceFile);
  if (!EXECUTOR_ALLOWED_DYNAMIC_ELEMENT_ACCESSES.has(access)) {
    violations.push(`Computed member access is outside the executor allowlist: ${access}`);
  }
}
