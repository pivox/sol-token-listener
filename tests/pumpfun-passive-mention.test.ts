import assert from 'node:assert/strict';
import test from 'node:test';
import * as hints from '../src/launchpads/pumpfun/websocket-create-hint.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';

const OTHER = '11111111111111111111111111111111';
const SECOND = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const invoke = (id = OTHER, depth = 1): string => `Program ${id} invoke [${depth}]`;
const success = (id = OTHER): string => `Program ${id} success`;
const passive = (logs: unknown): boolean => {
  assert.ok('isPassivePumpMentionFromLogs' in hints, 'passive proof export exists');
  return hints.isPassivePumpMentionFromLogs(logs, [PUMPSWAP_PROGRAM_ID]);
};

void test('proves a complete unrelated invocation with ordinary text and consumption', () => {
  assert.equal(passive([
    invoke(), 'Program log: unrelated instruction',
    `Program ${OTHER} consumed 100 of 200000 compute units`, success(),
  ]), true);
});

void test('accepts multiple complete roots and properly nested non-Pump CPI', () => {
  assert.equal(passive([invoke(), invoke(SECOND, 2), success(SECOND), success(),
    invoke(SECOND), success(SECOND)]), true);
});

void test('program text cannot masquerade as runtime control', () => {
  assert.equal(passive([invoke(), `Program log: ${invoke(PUMP_PROGRAM_ID)}`, success()]), true);
  assert.equal(passive([`Program log: ${invoke()}`, `Program log: ${success()}`]), false);
  assert.equal(passive([invoke(), `Program log: ${success()}`]), false);
});

void test('never excludes Pump or PumpSwap at root or CPI depth', () => {
  for (const id of [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID]) {
    assert.equal(passive([invoke(id), success(id)]), false);
    assert.equal(passive([invoke(), invoke(id, 2), success(id), success()]), false);
    assert.equal(passive([invoke(), success(), invoke(id), success(id)]), false);
  }
});

void test('validates coordinator-owned veto programs and always rejects Pump itself', () => {
  const proof = hints.isPassivePumpMentionFromLogs;
  assert.equal(proof([invoke(PUMP_PROGRAM_ID), success(PUMP_PROGRAM_ID)]), false);
  assert.equal(proof([invoke(), success()], [OTHER]), false);
  for (const veto of [null, ['invalid'], Array<string>(17).fill(SECOND)]) {
    assert.equal(proof([invoke(), success()], veto), false);
  }
});

void test('retains every unsupported, ambiguous or malformed log sequence', () => {
  for (const logs of [
    [], [invoke()], [success()], [invoke(), success(SECOND)],
    [invoke(OTHER, 2), success()], [invoke(), invoke(SECOND, 3), success(SECOND), success()],
    [invoke(), invoke(SECOND, 2), success(), success(SECOND)],
    [invoke().replace('[1]', '[01]'), success()],
    [invoke().replace('[1]', '[9007199254740993]'), success()],
    [invoke('1'.repeat(33)), success('1'.repeat(33))],
    [invoke(), success(), success()],
    [invoke(), `Program ${OTHER} failed: custom program error: 0x1`],
    [invoke(), 'Program data: AAAAAAAAAAA=', success()],
    [invoke(), 'Program data: malformed', success()],
    [invoke(), `Program return: ${OTHER} AA==`, success()],
    [invoke(), 'unknown runtime output', success()],
    [invoke(), 'Log truncated', success()],
    [invoke(), success(), 'Log truncated'],
    [invoke(), `Program ${SECOND} consumed 1 of 2 compute units`, success()],
    [`Program ${OTHER} consumed 1 of 2 compute units`, invoke(), success()],
    [invoke(), `Program ${OTHER} consumed 3 of 2 compute units`, success()],
    [invoke(), `Program ${OTHER} consumed 01 of 2 compute units`, success()],
    ['Program log: text', invoke(), success()],
    [invoke(), success(), 'Program log: text'],
    [invoke(), `Program log: text\n${success()}`, success()],
    [invoke(), 'Program log: text\r', success()],
    [invoke(), 'Program log: text\u0000', success()],
    [invoke(), 'Program log: text\u2028', success()],
    [invoke(), `${success()}\n`],
  ]) assert.equal(passive(logs), false, JSON.stringify(logs));
});

void test('hardened snapshot rejects hostile structures without invoking traps or getters', () => {
  const hostile = (): never => { throw new Error('must not execute'); };
  const accessor = [invoke(), success()];
  Object.defineProperty(accessor, '0', { get: hostile });
  const sparse = [invoke(), success()];
  sparse.length = 3;
  const extra = Object.assign([invoke(), success()], { extra: true });
  const proxy = new Proxy([invoke(), success()], { get: hostile, ownKeys: hostile });
  const revoked = Proxy.revocable([invoke(), success()], {});
  revoked.revoke();
  for (const value of [undefined, null, {}, 'logs', [1], accessor, sparse, extra, proxy,
    revoked.proxy]) assert.equal(passive(value), false);
});

void test('enforces count, per-line and total UTF-8 byte bounds', () => {
  assert.equal(passive(Array.from({ length: 258 }, (_, i) => i % 2 ? success() : invoke())), false);
  assert.equal(passive([invoke(), `Program log: ${'x'.repeat(16384)}`, success()]), false);
  assert.equal(passive([invoke(), ...Array<string>(5).fill(`Program log: ${'x'.repeat(14000)}`), success()]), false);
  assert.equal(passive([invoke(), `Program log: ${'é'.repeat(8192)}`, success()]), false);
});
