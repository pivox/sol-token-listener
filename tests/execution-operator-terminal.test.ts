import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeOperatorAction,
  authorizeCanaryArmament,
  ExecutionOperatorTerminalError,
  type AuthorizeOperatorCanaryArmInput,
} from '../src/executor-operations/terminal.js';

const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;

void test('requires one exact TTY phrase and returns only a hashed authorization', async () => {
  const writes: string[] = [];
  const authorization = await authorizeOperatorAction({
    terminal: {
      isTTY: true,
      write: (value) => { writes.push(value); },
      readLine: async () => 'CONFIRM ARM CANARY 11111111 abcdef123456',
    },
    nonceSource: () => 'abcdef123456',
    payloadVersion: 1,
    generationId,
    walletPublicKey: '11111111111111111111111111111111',
    action: 'ARM',
    phase: 'CANARY',
    contextFingerprint: 'b'.repeat(64),
    operatorId: 'operator-primary',
    nowMs: 1_000,
  });
  assert.equal(writes.length, 1);
  assert.match(writes[0] ?? '', /CONFIRM ARM CANARY 11111111 abcdef123456/u);
  assert.equal(authorization.nonceHash.length, 64);
  assert.equal(JSON.stringify(authorization).includes('abcdef123456'), false);
});

void test('refuses non-TTY, wrong phrases and malformed nonce sources with one fixed error', async () => {
  const base = {
    nonceSource: () => 'abcdef123456',
    payloadVersion: 1 as const,
    generationId,
    walletPublicKey: '11111111111111111111111111111111',
    action: 'RESUME' as const,
    phase: null,
    contextFingerprint: 'b'.repeat(64),
    operatorId: 'operator-primary',
    nowMs: 1_000,
  };
  for (const input of [
    {
      ...base,
      terminal: { isTTY: false, write() {}, readLine: async () => '' },
    },
    {
      ...base,
      terminal: { isTTY: true, write() {}, readLine: async () => 'yes' },
    },
    {
      ...base,
      nonceSource: () => 'bad nonce',
      terminal: { isTTY: true, write() {}, readLine: async () => '' },
    },
  ]) await assert.rejects(
    authorizeOperatorAction(input),
    (error) => error instanceof ExecutionOperatorTerminalError
      && error.code === 'OPERATOR_AUTHORIZATION_INVALID'
      && error.message === 'Operator authorization failed.',
  );
});

void test('binds a CANARY V2 arm authorization to the complete untruncated target request', async () => {
  const writes: string[] = [];
  const requestFingerprint = 'f'.repeat(64);
  const phrase = `CONFIRM ARM V2 CANARY 11111111111111111111111111111111 execution_intent_${'a'.repeat(64)} So11111111111111111111111111111111111111112 So11111111111111111111111111111111111111112 500000 500000 300000 1788134700000 ${requestFingerprint} abcdef123456`;
  const authorization = await authorizeCanaryArmament({
    terminal: { isTTY: true, write: (value: string) => { writes.push(value); }, readLine: async () => phrase },
    nonceSource: () => 'abcdef123456', payloadVersion: 2, generationId,
    walletPublicKey: '11111111111111111111111111111111', action: 'ARM', phase: 'CANARY',
    contextFingerprint: requestFingerprint, operatorId: 'operator-primary', nowMs: 1_788_134_400_000,
    targetIntentId: `execution_intent_${'a'.repeat(64)}`,
    targetMint: 'So11111111111111111111111111111111111111112',
    targetQuoteMint: 'So11111111111111111111111111111111111111112', targetQuoteAmountRaw: 500_000n,
    maximumCapitalLamports: 500_000n, maximumHoldingMs: 300_000, expiresAtMs: 1_788_134_700_000,
    policyFingerprint: 'b'.repeat(64), walletSnapshotFingerprint: 'c'.repeat(64),
    providerSnapshotFingerprint: 'd'.repeat(64), runtimeQuoteMaxAgeMs: 3_000,
    runtimeSlippageBps: 500n, runtimeSnapshotMaxSlotLag: 8, runtimeMaxComputeUnits: 300_000n,
    runtimeMaxFeeLamports: 100_000n, runtimeMaxFeePayerLamportDebit: 2_500_000n,
    runtimeMaxRpcCallsPerAttempt: 12, runtimeLeaseMs: 120_000,
  });
  assert.equal(authorization.payloadVersion, 2);
  assert.equal(authorization.contextFingerprint, requestFingerprint);
  assert.equal(authorization.nonceHash.length, 64);
  assert.match(writes.join(''), /11111111111111111111111111111111/u);
  assert.match(writes.join(''), /execution_intent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/u);
  assert.match(writes.join(''), /So11111111111111111111111111111111111111112/u);
  assert.match(writes.join(''), new RegExp(requestFingerprint, 'u'));
  for (const detail of [
    'policyFingerprint=', 'walletSnapshotFingerprint=', 'providerSnapshotFingerprint=',
    'runtimeQuoteMaxAgeMs=3000', 'runtimeSlippageBps=500', 'runtimeSnapshotMaxSlotLag=8',
    'runtimeMaxComputeUnits=300000', 'runtimeMaxFeeLamports=100000',
    'runtimeMaxFeePayerLamportDebit=2500000', 'runtimeMaxRpcCallsPerAttempt=12',
    'runtimeLeaseMs=120000',
  ]) assert.match(writes.join(''), new RegExp(detail, 'u'));
});

void test('refuses V2 non-TTY, wrong phrase, nonce and sensitive target/runtime inputs', async () => {
  const base = canaryInput();
  for (const input of [
    { ...base, terminal: { isTTY: false, write() {}, readLine: async () => '' } },
    { ...base, terminal: { isTTY: true, write() {}, readLine: async () => 'wrong phrase' } },
    { ...base, nonceSource: () => 'not-a-nonce' },
    { ...base, targetQuoteAmountRaw: 500_001n },
    { ...base, targetMint: 'not-a-public-key' },
    { ...base, runtimeLeaseMs: 120_001 },
  ]) await assert.rejects(authorizeCanaryArmament(input), ExecutionOperatorTerminalError);
});

function canaryInput(
  overrides: Partial<AuthorizeOperatorCanaryArmInput> = {},
): AuthorizeOperatorCanaryArmInput {
  return {
    terminal: { isTTY: true, write() {}, readLine: async () => '' }, nonceSource: () => 'abcdef123456',
    payloadVersion: 2, generationId, walletPublicKey: '11111111111111111111111111111111',
    action: 'ARM', phase: 'CANARY', contextFingerprint: 'f'.repeat(64), operatorId: 'operator-primary',
    nowMs: 1_788_134_400_000, targetIntentId: `execution_intent_${'a'.repeat(64)}`,
    targetMint: 'So11111111111111111111111111111111111111112',
    targetQuoteMint: 'So11111111111111111111111111111111111111112', targetQuoteAmountRaw: 500_000n,
    maximumCapitalLamports: 500_000n, maximumHoldingMs: 300_000, expiresAtMs: 1_788_134_700_000,
    policyFingerprint: 'b'.repeat(64), walletSnapshotFingerprint: 'c'.repeat(64),
    providerSnapshotFingerprint: 'd'.repeat(64), runtimeQuoteMaxAgeMs: 3_000,
    runtimeSlippageBps: 500n, runtimeSnapshotMaxSlotLag: 8, runtimeMaxComputeUnits: 300_000n,
    runtimeMaxFeeLamports: 100_000n, runtimeMaxFeePayerLamportDebit: 2_500_000n,
    runtimeMaxRpcCallsPerAttempt: 12, runtimeLeaseMs: 120_000, ...overrides,
  };
}
