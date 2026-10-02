import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { serialize } from 'node:v8';
import { deflateRawSync } from 'node:zlib';
import {
  BlockTransactionPayloadCodecError,
  decodeBlockTransactionPayload,
  encodeBlockTransactionPayload,
  MAX_BLOCK_COMPRESSION_INPUT_BYTES,
  MAX_COMPRESSED_TRANSACTION_BYTES,
} from '../src/solana/rpc/block-transaction-payload-codec.js';

const ERROR_MESSAGE = 'Block transaction payload codec failed';
const value = { slot: 42n, bytes: new Uint8Array([0, 255]), logs: ['x'.repeat(4096)], error: null };
const serialized = serialize(value);
const hash = createHash('sha256').update(serialized).digest('hex');
const compressed = deflateRawSync(serialized, { level: 1 });

function tagged(mode: 'r' | 'd', bytes: Uint8Array, length = serialized.byteLength, digest = hash): string {
  return `b1:${mode}:${length}:${digest}:${Buffer.from(bytes).toString('base64')}`;
}

function rejectsRedacted(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof BlockTransactionPayloadCodecError);
    assert.equal(error.name, 'BlockTransactionPayloadCodecError');
    assert.equal(error.message, ERROR_MESSAGE);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.deepEqual(Object.keys(error), ['name']);
    return true;
  });
}

void test('compressible V8 values preserve bigint, typed bytes, logs and null', () => {
  const { payload } = encodeBlockTransactionPayload(serialize(value), MAX_BLOCK_COMPRESSION_INPUT_BYTES);
  assert.match(payload, /^b1:d:/);
  assert.deepEqual(decodeBlockTransactionPayload(payload), value);
});

void test('the immutable limits are exactly one MiB per transaction and 32 MiB per block', () => {
  assert.equal(MAX_COMPRESSED_TRANSACTION_BYTES, 1048576);
  assert.equal(MAX_BLOCK_COMPRESSION_INPUT_BYTES, 33554432);
});

void test('zero budget preserves raw V8 bytes without attempting compression', () => {
  const result = encodeBlockTransactionPayload(serialized, 0);
  assert.equal(result.compressionInputBytes, 0);
  assert.equal(result.payload, tagged('r', serialized));
  assert.deepEqual(decodeBlockTransactionPayload(result.payload), value);
});

void test('exact remaining budget permits compression but one fewer byte does not', () => {
  const exact = encodeBlockTransactionPayload(serialized, serialized.byteLength);
  const insufficient = encodeBlockTransactionPayload(serialized, serialized.byteLength - 1);
  assert.equal(exact.compressionInputBytes, serialized.byteLength);
  assert.equal(exact.payload, tagged('d', compressed));
  assert.equal(insufficient.compressionInputBytes, 0);
  assert.equal(insufficient.payload, tagged('r', serialized));
});

void test('attempted incompressible input consumes its entire compression budget', () => {
  const input = randomBytes(4096);
  const result = encodeBlockTransactionPayload(input, input.byteLength);
  assert.match(result.payload, /^b1:r:/);
  assert.equal(result.compressionInputBytes, input.byteLength);
  const next = encodeBlockTransactionPayload(serialized, input.byteLength - result.compressionInputBytes);
  assert.match(next.payload, /^b1:r:/);
  assert.equal(next.compressionInputBytes, 0);
});

void test('a transaction exactly one MiB is compressed, one byte above is raw', () => {
  const atLimit = encodeBlockTransactionPayload(new Uint8Array(MAX_COMPRESSED_TRANSACTION_BYTES), MAX_BLOCK_COMPRESSION_INPUT_BYTES);
  const aboveLimit = encodeBlockTransactionPayload(new Uint8Array(MAX_COMPRESSED_TRANSACTION_BYTES + 1), MAX_BLOCK_COMPRESSION_INPUT_BYTES);
  assert.match(atLimit.payload, /^b1:d:1048576:/);
  assert.equal(atLimit.compressionInputBytes, MAX_COMPRESSED_TRANSACTION_BYTES);
  assert.match(aboveLimit.payload, /^b1:r:1048577:/);
  assert.equal(aboveLimit.compressionInputBytes, 0);
});

void test('large valid raw V8 values still round-trip above the compression cap', () => {
  const large = { logs: ['z'.repeat(MAX_COMPRESSED_TRANSACTION_BYTES + 1)] };
  const result = encodeBlockTransactionPayload(serialize(large), MAX_BLOCK_COMPRESSION_INPUT_BYTES);
  assert.match(result.payload, /^b1:r:/);
  assert.equal(result.compressionInputBytes, 0);
  assert.deepEqual(decodeBlockTransactionPayload(result.payload), large);
});

void test('raw fallback wins when deflate is larger or equally sized as canonical text', () => {
  const equallySized = new Uint8Array(4);
  const fixtures = [new Uint8Array([1, 2]), equallySized];
  assert.equal(deflateRawSync(equallySized, { level: 1 }).toString('base64').length, Buffer.from(equallySized).toString('base64').length);
  for (const input of fixtures) {
    const result = encodeBlockTransactionPayload(input, MAX_BLOCK_COMPRESSION_INPUT_BYTES);
    assert.match(result.payload, /^b1:r:/);
    assert.equal(result.compressionInputBytes, input.byteLength);
  }
});

void test('encoding hashes and retains only the supplied Uint8Array view', () => {
  const storage = new Uint8Array(serialized.byteLength + 20);
  storage.set(serialized, 10);
  const result = encodeBlockTransactionPayload(storage.subarray(10, -10), 0);
  assert.equal(result.payload, tagged('r', serialized));
  storage.fill(0);
  assert.deepEqual(decodeBlockTransactionPayload(result.payload), value);
});

for (const budget of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_BLOCK_COMPRESSION_INPUT_BYTES + 1, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
  void test(`invalid compression budget ${String(budget)} is a fixed redacted error`, () => {
    rejectsRedacted(() => encodeBlockTransactionPayload(serialized, budget as number));
  });
}

void test('empty encode input is rejected rather than generating a zero-length tag', () => {
  rejectsRedacted(() => encodeBlockTransactionPayload(new Uint8Array(), 0));
});

for (const mode of ['r', 'd'] as const) {
  void test(`${mode} decoding returns independent graphs and byte arrays on every call`, () => {
    const payload = tagged(mode, mode === 'r' ? serialized : compressed);
    const first = decodeBlockTransactionPayload(payload) as typeof value;
    const second = decodeBlockTransactionPayload(payload) as typeof value;
    assert.notEqual(first, second);
    assert.notEqual(first.logs, second.logs);
    assert.notEqual(first.bytes, second.bytes);
    first.slot = 99n;
    first.logs[0] = 'changed';
    first.bytes[0] = 77;
    assert.deepEqual(second, value);
    assert.deepEqual(decodeBlockTransactionPayload(payload), value);
  });
}

void test('nested non-null error values preserve the process-created V8 graph', () => {
  const withError = { ...value, error: { InstructionError: [0, { Custom: 6001 }] } };
  const { payload } = encodeBlockTransactionPayload(serialize(withError), MAX_BLOCK_COMPRESSION_INPUT_BYTES);
  assert.deepEqual(decodeBlockTransactionPayload(payload), withError);
});

const valid = tagged('d', compressed);
const body = compressed.toString('base64');
const malformed: readonly [string, string][] = [
  ['empty payload', ''],
  ['legacy untagged base64', serialized.toString('base64')],
  ['unknown version', valid.replace('b1:', 'b2:')],
  ['unknown mode', valid.replace(':d:', ':x:')],
  ['uppercase mode', valid.replace(':d:', ':D:')],
  ['extra field', `${valid}:extra`],
  ['missing field', `b1:d:${serialized.byteLength}:${hash}`],
  ['zero length', valid.replace(`:${serialized.byteLength}:`, ':0:')],
  ['negative length', valid.replace(`:${serialized.byteLength}:`, ':-1:')],
  ['leading zero length', valid.replace(`:${serialized.byteLength}:`, `:0${serialized.byteLength}:`)],
  ['plus-sign length', valid.replace(`:${serialized.byteLength}:`, `:+${serialized.byteLength}:`)],
  ['fractional length', valid.replace(`:${serialized.byteLength}:`, ':1.5:')],
  ['exponential length', valid.replace(`:${serialized.byteLength}:`, ':1e3:')],
  ['unsafe integer length', valid.replace(`:${serialized.byteLength}:`, ':9007199254740992:')],
  ['short hash', valid.replace(hash, hash.slice(1))],
  ['uppercase hash', valid.replace(hash, hash.toUpperCase())],
  ['nonhex hash', valid.replace(hash, 'g'.repeat(64))],
  ['empty base64', valid.slice(0, -body.length)],
  ['base64 whitespace', `${valid}\n`],
  ['base64 embedded whitespace', valid.replace(body, `${body.slice(0, 4)} ${body.slice(4)}`)],
  ['base64 illegal character', valid.replace(body, `!${body.slice(1)}`)],
  ['base64 redundant padding', `${valid}=`],
];
for (const [description, payload] of malformed) {
  void test(`decoder rejects ${description} with a fixed redacted error`, () => {
    rejectsRedacted(() => decodeBlockTransactionPayload(payload));
  });
}

void test('decoder rejects noncanonical base64 pad bits and missing padding', () => {
  const bytes = serialize(0);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const canonical = tagged('r', bytes, bytes.byteLength, digest);
  assert.ok(canonical.endsWith('A=='));
  assert.equal(decodeBlockTransactionPayload(canonical), 0);
  rejectsRedacted(() => decodeBlockTransactionPayload(canonical.replace(/A==$/, 'B==')));
  rejectsRedacted(() => decodeBlockTransactionPayload(canonical.slice(0, -2)));
});

void test('compressed declarations above the one MiB cap are rejected', () => {
  rejectsRedacted(() => decodeBlockTransactionPayload(tagged('d', compressed, MAX_COMPRESSED_TRANSACTION_BYTES + 1)));
});

void test('compressed base64 cannot exceed the raw canonical bound for the declaration', () => {
  rejectsRedacted(() => decodeBlockTransactionPayload(tagged('d', compressed, 1)));
});

void test('truncated deflate streams are rejected with a fixed error', () => {
  rejectsRedacted(() => decodeBlockTransactionPayload(tagged('d', compressed.subarray(0, -1))));
});

void test('compressed bytes after the end of a valid stream are rejected', () => {
  rejectsRedacted(() => decodeBlockTransactionPayload(tagged('d', Buffer.concat([compressed, Buffer.from([0])]))));
});

void test('a declared compressed output length larger than actual is rejected', () => {
  rejectsRedacted(() => decodeBlockTransactionPayload(tagged('d', compressed, serialized.byteLength + 1)));
});

void test('inflation exceeding the declared output length is rejected', () => {
  rejectsRedacted(() => decodeBlockTransactionPayload(tagged('d', compressed, serialized.byteLength - 1)));
});

void test('a changed valid deflate stream cannot retain the original hash', () => {
  const altered = serialize({ ...value, slot: 43n });
  assert.equal(altered.byteLength, serialized.byteLength);
  const stream = deflateRawSync(altered, { level: 1 });
  rejectsRedacted(() => decodeBlockTransactionPayload(tagged('d', stream)));
});

void test('raw data must match its exact declared length', () => {
  rejectsRedacted(() => decodeBlockTransactionPayload(tagged('r', serialized, serialized.byteLength + 1)));
  rejectsRedacted(() => decodeBlockTransactionPayload(tagged('r', serialized, serialized.byteLength - 1)));
});

void test('raw data must match its original hash', () => {
  rejectsRedacted(() => decodeBlockTransactionPayload(tagged('r', serialized, serialized.byteLength, '0'.repeat(64))));
});

void test('valid framing around invalid V8 bytes returns only the fixed error', () => {
  const bytes = Buffer.from('sensitive-invalid-v8-body');
  const digest = createHash('sha256').update(bytes).digest('hex');
  rejectsRedacted(() => decodeBlockTransactionPayload(tagged('r', bytes, bytes.byteLength, digest)));
});
