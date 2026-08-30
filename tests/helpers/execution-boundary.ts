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
  'createRequire', 'getBuiltinModule', 'eval', 'Function',
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

type ReflectBinding = 'OTHER' | 'GLOBAL_THIS' | 'REFLECT' | 'GET' | 'APPLY' | 'CONSTRUCT';

interface ReflectScope {
  readonly parent: ReflectScope | undefined;
  readonly bindings: Map<string, ReflectBinding>;
}

function appendReflectiveExecutorCapabilityViolations(
  sourceFile: ts.SourceFile,
  violations: string[],
): void {
  const root = createReflectScope(sourceFile, undefined);
  const visit = (node: ts.Node, scope: ReflectScope): void => {
    const activeScope = node !== sourceFile && isReflectScopeNode(node)
      ? createReflectScope(node, scope)
      : scope;
    if (ts.isVariableDeclaration(node)) updateReflectBinding(node, activeScope);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      updateAssignedReflectBinding(node, activeScope);
    }
    if (ts.isCallExpression(node)) appendReflectiveExecutorCall(node, activeScope, violations);
    ts.forEachChild(node, (child) => { visit(child, activeScope); });
  };
  visit(sourceFile, root);
}

function isReflectScopeNode(node: ts.Node): boolean {
  return ts.isBlock(node) || ts.isModuleBlock(node) || ts.isFunctionLike(node) || ts.isCatchClause(node);
}

function createReflectScope(owner: ts.Node, parent: ReflectScope | undefined): ReflectScope {
  const scope: ReflectScope = { parent, bindings: new Map() };
  if (ts.isSourceFile(owner) || ts.isBlock(owner) || ts.isModuleBlock(owner)) {
    for (const statement of owner.statements) appendStatementBindings(statement, scope);
  }
  if (ts.isFunctionLike(owner)) {
    for (const parameter of owner.parameters) appendBindingNames(parameter.name, scope);
    if (ts.isFunctionExpression(owner) && owner.name !== undefined) {
      scope.bindings.set(owner.name.text, 'OTHER');
    }
  }
  if (ts.isCatchClause(owner) && owner.variableDeclaration !== undefined) {
    appendBindingNames(owner.variableDeclaration.name, scope);
  }
  return scope;
}

function appendStatementBindings(statement: ts.Statement, scope: ReflectScope): void {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      appendBindingNames(declaration.name, scope);
    }
    return;
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))
    && statement.name !== undefined) {
    scope.bindings.set(statement.name.text, 'OTHER');
    return;
  }
  if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
    const clause = statement.importClause;
    if (clause.name !== undefined) scope.bindings.set(clause.name.text, 'OTHER');
    if (clause.namedBindings !== undefined) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        scope.bindings.set(clause.namedBindings.name.text, 'OTHER');
      } else {
        for (const element of clause.namedBindings.elements) {
          scope.bindings.set(element.name.text, 'OTHER');
        }
      }
    }
  }
}

function appendBindingNames(name: ts.BindingName, scope: ReflectScope): void {
  if (ts.isIdentifier(name)) {
    scope.bindings.set(name.text, 'OTHER');
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) appendBindingNames(element.name, scope);
  }
}

function updateReflectBinding(node: ts.VariableDeclaration, scope: ReflectScope): void {
  const initializer = node.initializer;
  if (initializer === undefined) return;
  const binding = reflectBinding(initializer, scope);
  if (ts.isIdentifier(node.name)) {
    scope.bindings.set(node.name.text, binding);
    return;
  }
  if (binding !== 'REFLECT' || !ts.isObjectBindingPattern(node.name)) return;
  for (const element of node.name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const property = staticBindingPropertyName(element);
    scope.bindings.set(element.name.text, reflectMethodBinding(property));
  }
}

function updateAssignedReflectBinding(node: ts.BinaryExpression, scope: ReflectScope): void {
  if (!ts.isIdentifier(node.left)) return;
  const binding = reflectBinding(node.right, scope);
  for (let current: ReflectScope | undefined = scope; current !== undefined; current = current.parent) {
    if (!current.bindings.has(node.left.text)) continue;
    current.bindings.set(node.left.text, binding);
    return;
  }
}

function staticBindingPropertyName(element: ts.BindingElement): string | null {
  const property = element.propertyName ?? element.name;
  if (ts.isIdentifier(property) || ts.isStringLiteralLike(property) || ts.isNumericLiteral(property)) {
    return property.text;
  }
  if (!ts.isComputedPropertyName(property)) return null;
  const expression = unwrapReflectExpression(property.expression);
  return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression) ? expression.text : null;
}

function reflectMethodBinding(property: string | null): ReflectBinding {
  if (property === 'get') return 'GET';
  if (property === 'apply') return 'APPLY';
  if (property === 'construct') return 'CONSTRUCT';
  return 'OTHER';
}

function reflectBinding(expression: ts.Expression, scope: ReflectScope): ReflectBinding {
  const value = unwrapReflectExpression(expression);
  if (ts.isIdentifier(value)) return resolveReflectBinding(value.text, scope);
  const member = staticMember(value);
  if (member !== null) {
    const receiver = reflectBinding(member.receiver, scope);
    if (receiver === 'GLOBAL_THIS' && member.property === 'Reflect') return 'REFLECT';
    if (receiver === 'REFLECT') return reflectMethodBinding(member.property);
  }
  if (ts.isCallExpression(value)) {
    const calledMember = staticMember(value.expression);
    if (calledMember !== null && calledMember.property === 'bind') {
      const receiver = reflectBinding(calledMember.receiver, scope);
      if (isReflectMethod(receiver)) return receiver;
    }
  }
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return reflectBinding(value.right, scope);
  }
  return 'OTHER';
}

function resolveReflectBinding(name: string, scope: ReflectScope): ReflectBinding {
  for (let current: ReflectScope | undefined = scope; current !== undefined; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding !== undefined) return binding;
  }
  if (name === 'Reflect') return 'REFLECT';
  if (name === 'globalThis') return 'GLOBAL_THIS';
  return 'OTHER';
}

function isReflectMethod(binding: ReflectBinding): boolean {
  return binding === 'GET' || binding === 'APPLY' || binding === 'CONSTRUCT';
}

function unwrapReflectExpression(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (ts.isParenthesizedExpression(value)
    || ts.isAsExpression(value)
    || ts.isTypeAssertionExpression(value)
    || ts.isNonNullExpression(value)
    || ts.isSatisfiesExpression(value)) {
    value = value.expression;
  }
  return value;
}

function staticMember(expression: ts.Expression): { readonly receiver: ts.Expression; readonly property: string | null } | null {
  const value = unwrapReflectExpression(expression);
  if (ts.isPropertyAccessExpression(value)) {
    return { receiver: value.expression, property: value.name.text };
  }
  if (ts.isElementAccessExpression(value)) {
    const argument = unwrapReflectExpression(value.argumentExpression);
    return {
      receiver: value.expression,
      property: ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument) ? argument.text : null,
    };
  }
  return null;
}

function appendReflectiveExecutorCall(
  node: ts.CallExpression,
  scope: ReflectScope,
  violations: string[],
): void {
  const callee = reflectBinding(node.expression, scope);
  if (callee === 'GET') {
    appendReflectivePropertyArgument(node.arguments, 1, violations);
    return;
  }
  if (callee === 'APPLY') {
    const target = node.arguments[0];
    if (target !== undefined && reflectBinding(target, scope) === 'GET') {
      appendReflectiveApplyArguments(node.arguments[2], violations);
    }
    return;
  }
  const member = staticMember(node.expression);
  if (member === null || reflectBinding(member.receiver, scope) !== 'GET') return;
  if (member.property === 'call') appendReflectivePropertyArgument(node.arguments, 2, violations);
  if (member.property === 'apply') appendReflectiveApplyArguments(node.arguments[1], violations);
}

function appendReflectivePropertyArgument(
  argumentsList: ts.NodeArray<ts.Expression>,
  index: number,
  violations: string[],
): void {
  if (argumentsList.some(ts.isSpreadElement)) {
    violations.push('Computed reflective executor capability is prohibited.');
    return;
  }
  appendReflectiveProperty(argumentsList[index], violations);
}

function appendReflectiveApplyArguments(expression: ts.Expression | undefined, violations: string[]): void {
  if (expression === undefined) return;
  const value = unwrapReflectExpression(expression);
  if (!ts.isArrayLiteralExpression(value) || value.elements.some(ts.isSpreadElement)) {
    violations.push('Computed reflective executor capability is prohibited.');
    return;
  }
  const property = value.elements[1];
  appendReflectiveProperty(property !== undefined && ts.isExpression(property) ? property : undefined, violations);
}

function appendReflectiveProperty(expression: ts.Expression | undefined, violations: string[]): void {
  if (expression === undefined) return;
  const value = unwrapReflectExpression(expression);
  if (ts.isStringLiteralLike(value)) {
    if (FORBIDDEN_CALLS.has(value.text) || EXECUTOR_FORBIDDEN_IDENTIFIERS.has(value.text)) {
      violations.push(`Forbidden reflective executor capability: ${value.text}`);
    }
    return;
  }
  if (ts.isNumericLiteral(value)) return;
  violations.push('Computed reflective executor capability is prohibited.');
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
