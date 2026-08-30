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
  'simulateTransaction', 'sendTransaction', 'sendRawTransaction', 'signTransaction',
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
      if (!specifier.startsWith('node:') && !EXECUTOR_ALLOWED_BARE_MODULES.has(specifier)) {
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
  const visit = (node: ts.Node): void => {
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
  const name = ts.isIdentifier(node.expression)
    ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : ts.isElementAccessExpression(node.expression) && ts.isStringLiteralLike(node.expression.argumentExpression)
        ? node.expression.argumentExpression.text
        : null;
  if (name !== null && FORBIDDEN_CALLS.has(name)) violations.push(`Forbidden execution call: ${name}`);
}
