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
const SIMULATION_ONLY_ALLOWED_BARE_MODULES = new Set([
  'pg', 'pino', 'dotenv', 'dotenv/config',
  '@solana/web3.js', '@solana/spl-token', '@solana/spl-token-metadata',
  'bn.js', 'bs58',
]);
const AUDITED_PUMPFUN_SDK_PATH = /^(?:dist\/)?src\/launchpads\/pumpfun\/official-sdk\.(?:js|ts)$/u;
const AUDITED_PUMPSWAP_SDK_PATH = /^(?:dist\/)?src\/markets\/pumpswap\/official-sdk\.(?:js|ts)$/u;
const SIMULATION_ONLY_ALLOWED_NODE_BUILTINS = new Set([
  'node:crypto', 'node:fs/promises', 'node:path', 'node:url', 'node:util/types',
]);
const SIMULATION_ONLY_ALLOWED_LOCAL_MODULES = [
  /^(?:dist\/)?src\/executor\/(?:main|config|database|dry-run-worker|simulation-worker|logger|runtime)\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/executor-simulation\/(?:attempt-evaluator|build-plan|build-receipt|instruction-inspector|provider-session|pumpfun-adapter|pumpfun-quote|pumpswap-adapter|solana-simulation-gateway|venue-router)\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/domain\/(?:execution-(?:dry-run|intent|simulation)|market|market-errors|types)\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/ports\/(?:execution-(?:dry-run-repository|intent-repository|market-gateway|simulation-gateway|simulation-repository|venue-repository)|market-rpc-reader|pumpswap-quote-provider)\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/storage\/(?:database|execution-(?:dry-run\.repository|intent\.repository|simulation\.repository|venue\.repository))\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/launchpads\/pumpfun\/(?:causal-quote|constants|official-sdk|generated\/pump-idl)\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/markets\/pumpswap\/(?:borsh-reader|constants|errors|official-sdk|pool-account-decoder|pumpswap-fee-state|pumpswap-quote\.provider|reserve-math|types|generated\/pumpswap-idl)\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/solana\/rpc\/types\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/utils\/json\.(?:js|ts)$/u,
];
const SIMULATION_ONLY_FORBIDDEN_PATH_SEGMENTS = new Set([
  'execution', 'paper', 'listener', 'raydium',
]);
const SIMULATION_ONLY_FORBIDDEN_IDENTIFIERS = new Set([
  'Keypair', 'Wallet', 'WalletSigner', 'Signer', 'SecretLoader',
  'keypair', 'wallet', 'createRequire', 'getBuiltinModule',
  'eval', 'Function', 'globalThis',
  'sendTransaction', 'sendRawTransaction', 'sendAndConfirmTransaction',
  'signTransaction', 'signAllTransactions', 'signMessage',
  'submitTransaction', 'submitSignedTransaction', 'submitRawTransaction',
  'simulateTransaction',
]);
const AUDITED_SIMULATION_PROVIDER_PATH = /^(?:dist\/)?src\/executor-simulation\/provider-session\.(?:js|ts)$/u;
const RISK_FOUNDATION_ALLOWED_BARE_MODULES = new Set(['pg']);
const RISK_FOUNDATION_ALLOWED_NODE_BUILTINS = new Set([
  'node:crypto', 'node:fs/promises', 'node:path', 'node:url', 'node:util/types',
]);
const RISK_FOUNDATION_ALLOWED_LOCAL_MODULES = [
  /^(?:dist\/)?src\/executor-risk\/(?:admission-service|reconciliation-service)\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/domain\/execution-(?:fault-policy|intent|provider-quota|reconciliation|risk-policy)\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/ports\/execution-(?:reconciliation-gateway|risk-repository)\.(?:js|ts)$/u,
  /^(?:dist\/)?src\/storage\/(?:database|execution-risk\.repository)\.(?:js|ts)$/u,
];
const RISK_FOUNDATION_FORBIDDEN_IDENTIFIERS = new Set([
  'Keypair', 'WalletSigner', 'Signer', 'SecretLoader',
  'createRequire', 'getBuiltinModule', 'eval', 'Function', 'global', 'globalThis',
  'simulateTransaction', 'sendTransaction', 'sendRawTransaction',
  'sendAndConfirmTransaction', 'signTransaction', 'signAllTransactions', 'signMessage',
  'submitTransaction', 'submitSignedTransaction', 'submitRawTransaction',
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

export function literalRuntimeModuleSpecifiers(sourceText: string, sourcePath: string): readonly string[] {
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const append = (node: ts.Expression | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (importDeclarationHasRuntimeValue(node)) append(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (exportDeclarationHasRuntimeValue(node)) append(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      append(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      append(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze(specifiers);
}

function importDeclarationHasRuntimeValue(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  return bindings === undefined
    || ts.isNamespaceImport(bindings)
    || bindings.elements.some((element) => !element.isTypeOnly);
}

function exportDeclarationHasRuntimeValue(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly || node.moduleSpecifier === undefined) return false;
  const clause = node.exportClause;
  return clause === undefined
    || ts.isNamespaceExport(clause)
    || clause.elements.some((element) => !element.isTypeOnly);
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

/**
 * Strict profile for the simulation-only executor. It permits no signing or
 * submission capability and permits the literal RPC method
 * `simulateTransaction` only in the reviewed provider-session boundary.
 */
export function simulationOnlyExecutorBoundaryViolations(
  sourceText: string,
  sourcePath: string,
  repositoryRoot: string,
): readonly string[] {
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [...executionBoundaryViolations(sourceText, sourcePath, repositoryRoot)];
  const normalizedSourcePath = relative(repositoryRoot, sourcePath).replaceAll('\\', '/');
  const isAuditedProvider = AUDITED_SIMULATION_PROVIDER_PATH.test(normalizedSourcePath);
  const isExactPumpFunSdkBridge = AUDITED_PUMPFUN_SDK_PATH.test(normalizedSourcePath)
    && hasExactPumpFunCreateRequireBridge(sourceFile);
  const isExactPumpSwapSdkBridge = AUDITED_PUMPSWAP_SDK_PATH.test(normalizedSourcePath)
    && hasExactPumpSwapNamedStaticBridge(sourceFile);

  for (const specifier of literalRuntimeModuleSpecifiers(sourceText, sourcePath)) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const normalized = specifier.replace(/[?#].*$/u, '');
      const target = normalized.startsWith('/') ? resolve(normalized) : resolve(dirname(sourcePath), normalized);
      const targetPath = relative(repositoryRoot, target).replaceAll('\\', '/');
      if (hasSimulationOnlyForbiddenPathSegment(targetPath)) {
        violations.push(`Forbidden simulation-only local module: ${specifier}`);
      } else if (!SIMULATION_ONLY_ALLOWED_LOCAL_MODULES.some((pattern) => pattern.test(targetPath))) {
        violations.push(`Simulation-only local module is outside the allowlist: ${specifier}`);
      }
      continue;
    }
    if (specifier === '@pump-fun/pump-sdk') {
      violations.push('Pump.fun SDK runtime import must use the exact audited createRequire bridge.');
      continue;
    }
    if (specifier === '@pump-fun/pump-swap-sdk') {
      if (!isExactPumpSwapSdkBridge) {
        violations.push(`Simulation-only SDK import is restricted to its audited named-import bridge: ${specifier}`);
      }
      continue;
    }
    if (specifier === 'node:module' && isExactPumpFunSdkBridge) {
      continue;
    }
    if (!SIMULATION_ONLY_ALLOWED_BARE_MODULES.has(specifier)
      && !SIMULATION_ONLY_ALLOWED_NODE_BUILTINS.has(specifier)) {
      violations.push(`Simulation-only module is outside the allowlist: ${specifier}`);
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      violations.push('Dynamic import is prohibited in simulation-only modules.');
    }
    if (ts.isIdentifier(node) && SIMULATION_ONLY_FORBIDDEN_IDENTIFIERS.has(node.text)
      && (node.text !== 'simulateTransaction' || !isAuditedProvider)
      && (node.text !== 'createRequire' || !isExactPumpFunSdkBridge)) {
      violations.push(`Forbidden simulation-only capability: ${node.text}`);
    }
    if (ts.isIdentifier(node) && node.text === 'global' && isAmbientGlobalReference(node)) {
      violations.push('Forbidden simulation-only capability: global');
    }
    if (ts.isStringLiteralLike(node) && node.text === 'simulateTransaction' && !isAuditedProvider) {
      violations.push('simulateTransaction is restricted to audited provider-session.');
    }
    if (ts.isElementAccessExpression(node)) appendSimulationOnlyElementAccess(node, violations);
    ts.forEachChild(node, visit);
  };
  appendReflectiveExecutorCapabilityViolations(sourceFile, violations);
  visit(sourceFile);
  return Object.freeze(violations);
}

/** Closed, inert graph used by the #51-E risk and reconciliation foundation. */
export function riskFoundationBoundaryViolations(
  sourceText: string,
  sourcePath: string,
  repositoryRoot: string,
): readonly string[] {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations = [...executionBoundaryViolations(sourceText, sourcePath, repositoryRoot)];
  for (const specifier of literalRuntimeModuleSpecifiers(sourceText, sourcePath)) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const normalized = specifier.replace(/[?#].*$/u, '');
      const target = normalized.startsWith('/')
        ? resolve(normalized)
        : resolve(dirname(sourcePath), normalized);
      const targetPath = relative(repositoryRoot, target).replaceAll('\\', '/');
      if (!RISK_FOUNDATION_ALLOWED_LOCAL_MODULES.some((pattern) => pattern.test(targetPath))) {
        violations.push(`Risk foundation local module is outside the allowlist: ${specifier}`);
      }
      continue;
    }
    if (!RISK_FOUNDATION_ALLOWED_BARE_MODULES.has(specifier)
      && !RISK_FOUNDATION_ALLOWED_NODE_BUILTINS.has(specifier)) {
      violations.push(`Risk foundation module is outside the allowlist: ${specifier}`);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )) violations.push('Dynamic module loading is forbidden in the risk foundation.');
    if (ts.isIdentifier(node) && (
      RISK_FOUNDATION_FORBIDDEN_IDENTIFIERS.has(node.text)
      || /(?:load.*secret|secret.*load)/iu.test(node.text)
    )) violations.push(`Forbidden risk foundation capability: ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze(violations);
}

function isAmbientGlobalReference(identifier: ts.Identifier): boolean {
  if (!isIdentifierReference(identifier)) return false;
  for (let scope: ts.Node | undefined = identifier.parent; scope !== undefined; scope = scope.parent) {
    if (scopeDeclaresName(scope, identifier.text)) return false;
  }
  return true;
}

function hasExactPumpFunCreateRequireBridge(sourceFile: ts.SourceFile): boolean {
  const nodeModuleImports = sourceFile.statements.filter((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement)
      && ts.isStringLiteralLike(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === 'node:module');
  const nodeModuleImport = nodeModuleImports[0];
  if (nodeModuleImports.length !== 1
    || nodeModuleImport === undefined
    || !isExactCreateRequireImport(nodeModuleImport)) return false;

  let createRequireIdentifiers = 0;
  let exactSdkLoads = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'createRequire') createRequireIdentifiers += 1;
    if (ts.isCallExpression(node) && isExactPumpFunSdkLoad(node)) exactSdkLoads += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return createRequireIdentifiers === 2 && exactSdkLoads === 1;
}

function isExactCreateRequireImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined || clause.isTypeOnly || clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings) || bindings.elements.length !== 1) return false;
  const binding = bindings.elements[0];
  if (binding === undefined) return false;
  return !binding.isTypeOnly && binding.propertyName === undefined && binding.name.text === 'createRequire';
}

function isExactPumpFunSdkLoad(node: ts.CallExpression): boolean {
  if (node.questionDotToken !== undefined || node.typeArguments !== undefined || node.arguments.length !== 1) return false;
  const sdk = node.arguments[0];
  const factory = node.expression;
  if (sdk === undefined || !ts.isStringLiteralLike(sdk) || sdk.text !== '@pump-fun/pump-sdk'
    || !ts.isCallExpression(factory)
    || factory.questionDotToken !== undefined
    || factory.typeArguments !== undefined
    || factory.arguments.length !== 1
    || !ts.isIdentifier(factory.expression)
    || factory.expression.text !== 'createRequire') return false;
  const meta = factory.arguments[0];
  return meta !== undefined
    && ts.isPropertyAccessExpression(meta)
    && meta.name.text === 'url'
    && ts.isMetaProperty(meta.expression)
    && meta.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && meta.expression.name.text === 'meta';
}

function hasExactPumpSwapNamedStaticBridge(sourceFile: ts.SourceFile): boolean {
  const sdkStatements = sourceFile.statements.filter((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return false;
    return statement.moduleSpecifier !== undefined
      && ts.isStringLiteralLike(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === '@pump-fun/pump-swap-sdk'
      && (ts.isImportDeclaration(statement)
        ? importDeclarationHasRuntimeValue(statement)
        : exportDeclarationHasRuntimeValue(statement));
  });
  const sdkStatement = sdkStatements[0];
  if (sdkStatements.length !== 1 || sdkStatement === undefined) return false;
  if (ts.isImportDeclaration(sdkStatement)) {
    const clause = sdkStatement.importClause;
    if (clause === undefined || clause.isTypeOnly || clause.name !== undefined) return false;
    const bindings = clause.namedBindings;
    return bindings !== undefined
      && ts.isNamedImports(bindings)
      && bindings.elements.length > 0
      && bindings.elements.every((element) => !element.isTypeOnly && element.propertyName === undefined);
  }
  if (!ts.isExportDeclaration(sdkStatement)) return false;
  const clause = sdkStatement.exportClause;
  return !sdkStatement.isTypeOnly
    && clause !== undefined
    && ts.isNamedExports(clause)
    && clause.elements.length > 0
    && clause.elements.every((element) => !element.isTypeOnly && element.propertyName === undefined);
}

function isIdentifierReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === identifier)
    || (ts.isQualifiedName(parent) && parent.right === identifier)
    || (ts.isPropertyAssignment(parent) && parent.name === identifier)
    || (ts.isPropertyDeclaration(parent) && parent.name === identifier)
    || (ts.isPropertySignature(parent) && parent.name === identifier)
    || (ts.isMethodDeclaration(parent) && parent.name === identifier)
    || (ts.isMethodSignature(parent) && parent.name === identifier)
    || (ts.isVariableDeclaration(parent) && parent.name === identifier)
    || (ts.isParameter(parent) && parent.name === identifier)
    || (ts.isBindingElement(parent) && (parent.name === identifier || parent.propertyName === identifier))
    || (ts.isFunctionDeclaration(parent) && parent.name === identifier)
    || (ts.isClassDeclaration(parent) && parent.name === identifier)
    || (ts.isInterfaceDeclaration(parent) && parent.name === identifier)
    || (ts.isTypeAliasDeclaration(parent) && parent.name === identifier)
    || (ts.isImportClause(parent) && parent.name === identifier)
    || (ts.isImportSpecifier(parent) && (parent.name === identifier || parent.propertyName === identifier))
    || (ts.isExportSpecifier(parent) && (parent.name === identifier || parent.propertyName === identifier))) {
    return false;
  }
  return true;
}

function scopeDeclaresName(scope: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(scope)) {
    if (scope.parameters.some((parameter) => bindingNameContains(parameter.name, name))) return true;
    if ('name' in scope && scope.name !== undefined && ts.isIdentifier(scope.name) && scope.name.text === name) return true;
  }
  if (ts.isCatchClause(scope)
    && scope.variableDeclaration !== undefined
    && bindingNameContains(scope.variableDeclaration.name, name)) return true;
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const initializer = scope.initializer;
    if (initializer !== undefined && ts.isVariableDeclarationList(initializer)
      && initializer.declarations.some((declaration) => bindingNameContains(declaration.name, name))) return true;
  }
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) {
    return scope.statements.some((statement) => statementDeclaresName(statement, name));
  }
  return false;
}

function statementDeclaresName(statement: ts.Statement, name: string): boolean {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) => bindingNameContains(declaration.name, name));
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
    && statement.name?.text === name) return true;
  if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
    const clause = statement.importClause;
    if (clause.name?.text === name) return true;
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) return bindings.name.text === name;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      return bindings.elements.some((element) => element.name.text === name);
    }
  }
  return false;
}

function bindingNameContains(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((element) =>
    !ts.isOmittedExpression(element) && bindingNameContains(element.name, name));
}

function appendSimulationOnlyElementAccess(node: ts.ElementAccessExpression, violations: string[]): void {
  const argument = node.argumentExpression;
  const staticKey = staticStringValue(argument);
  if (staticKey !== undefined) {
    if (SIMULATION_ONLY_FORBIDDEN_IDENTIFIERS.has(staticKey)) {
      violations.push(`Forbidden simulation-only capability: ${staticKey}`);
    }
    return;
  }
  if (!ts.isNumericLiteral(argument) && isPotentialSimulationCapabilityReceiver(node.expression)) {
    violations.push('Computed member acquisition is prohibited in simulation-only modules.');
  }
}

function staticStringValue(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined;
  const left = staticStringValue(expression.left);
  const right = staticStringValue(expression.right);
  return left === undefined || right === undefined ? undefined : `${left}${right}`;
}

function isPotentialSimulationCapabilityReceiver(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return /(?:client|connection|provider|rpc|wallet|signer|transaction)/iu.test(expression.text);
  return ts.isPropertyAccessExpression(expression)
    && /(?:client|connection|provider|rpc|wallet|signer|transaction)/iu.test(expression.name.text);
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

function hasSimulationOnlyForbiddenPathSegment(path: string): boolean {
  return path.replaceAll('\\', '/').toLocaleLowerCase('en-US').split('/').some((segment) =>
    SIMULATION_ONLY_FORBIDDEN_PATH_SEGMENTS.has(segment)
      || /^(?:paper|listener|raydium)(?:[._-]|$)/u.test(segment));
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
