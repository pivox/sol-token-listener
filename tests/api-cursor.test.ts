import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeLaunchCursor,
  decodePaperPositionCursor,
  decodeStreamCursor,
  encodeLaunchCursor,
  encodePaperPositionCursor,
  encodeStreamCursor,
} from '../src/api/cursor.js';

void test('encodes canonical opaque cursors for each public route', () => {
  assert.equal(
    encodeLaunchCursor({ detectedAtMs: 1_720_000_000_000, mint: 'Mint111' }),
    'WyJsYXVuY2hlcyIsMSwxNzIwMDAwMDAwMDAwLCJNaW50MTExIl0',
  );
  assert.equal(
    encodePaperPositionCursor({ openedAtMs: 1_720_000_000_001, id: 'pos_1' }),
    'WyJwYXBlcl9wb3NpdGlvbnMiLDEsMTcyMDAwMDAwMDAwMSwicG9zXzEiXQ',
  );
  assert.equal(encodeStreamCursor(42n), 'WyJldmVudHMiLDEsIjQyIl0');
});

void test('decodes each cursor only for its matching route', () => {
  const launches = encodeLaunchCursor({ detectedAtMs: 1, mint: 'Mint111' });
  const positions = encodePaperPositionCursor({ openedAtMs: 2, id: 'pos_2' });
  const events = encodeStreamCursor(3n);

  assert.deepEqual(decodeLaunchCursor(launches), { detectedAtMs: 1, mint: 'Mint111' });
  assert.deepEqual(decodePaperPositionCursor(positions), { openedAtMs: 2, id: 'pos_2' });
  assert.equal(decodeStreamCursor(events), 3n);
  assert.throws(() => decodeLaunchCursor(positions), TypeError);
  assert.throws(() => decodePaperPositionCursor(events), TypeError);
  assert.throws(() => decodeStreamCursor(launches), TypeError);
});

void test('rejects non-canonical or invalid cursor inputs', () => {
  const invalid = [
    'WyJsYXVuY2hlcyIsMSwxLCJNaW50MTExIl0=',
    ' WyJsYXVuY2hlcyIsMSwxLCJNaW50MTExIl0',
    'WyJsYXVuY2hlcyIsMSwtMCwiTWludDExMSJd',
    'WyJsYXVuY2hlcyIsMSwtMSwiTWludDExMSJd',
    'WyJsYXVuY2hlcyIsMSw5MDA3MTk5MjU0NzQwOTkyLCJNaW50MTExIl0',
    'WyJldmVudHMiLDEsIjAiXQ',
    'WyJldmVudHMiLDEsIi0xIl0',
    'WyJldmVudHMiLDEsIjAxIl0',
  ];

  for (const cursor of invalid) {
    assert.throws(() => {
      decodeLaunchCursor(cursor);
      decodePaperPositionCursor(cursor);
      decodeStreamCursor(cursor);
    }, TypeError);
  }
});
