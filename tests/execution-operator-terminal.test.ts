import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeOperatorAction,
  ExecutionOperatorTerminalError,
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
