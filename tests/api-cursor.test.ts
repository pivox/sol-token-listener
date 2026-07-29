import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CURSOR_ENCODED_LENGTH,
  MAX_CURSOR_SEQUENCE,
  MAX_CURSOR_TEXT_LENGTH,
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

void test('each decoder rejects its own non-canonical cursor inputs', () => {
  const invalidLaunches = [
    'WyJsYXVuY2hlcyIsMSwxLCJNaW50MTExIl0=',
    ' WyJsYXVuY2hlcyIsMSwxLCJNaW50MTExIl0',
    'WyJsYXVuY2hlcyIsMSwtMCwiTWludDExMSJd',
    'WyJsYXVuY2hlcyIsMSwtMSwiTWludDExMSJd',
    'WyJsYXVuY2hlcyIsMSw5MDA3MTk5MjU0NzQwOTkyLCJNaW50MTExIl0',
  ];
  const invalidStreams = [
    'WyJldmVudHMiLDEsIjAiXQ',
    'WyJldmVudHMiLDEsIi0xIl0',
    'WyJldmVudHMiLDEsIjAxIl0',
  ];
  const invalidPaperPositions = [
    'WyJwYXBlcl9wb3NpdGlvbnMiLDEsLTAsInBvc18xIl0',
    'WyJwYXBlcl9wb3NpdGlvbnMiLDEsLTEsInBvc18xIl0',
    'WyJwYXBlcl9wb3NpdGlvbnMiLDEsOTAwNzE5OTI1NDc0MDk5MiwicG9zXzEiXQ',
  ];

  for (const cursor of invalidLaunches) {
    assert.throws(() => decodeLaunchCursor(cursor), TypeError);
  }
  for (const cursor of invalidPaperPositions) {
    assert.throws(() => decodePaperPositionCursor(cursor), TypeError);
  }
  for (const cursor of invalidStreams) {
    assert.throws(() => decodeStreamCursor(cursor), TypeError);
  }
});

void test('cursor limits accept exact bounds and reject oversized values before parsing', () => {
  const textAtLimit = 'x'.repeat(MAX_CURSOR_TEXT_LENGTH);
  const launch = encodeLaunchCursor({ detectedAtMs: 0, mint: textAtLimit });
  const position = encodePaperPositionCursor({ openedAtMs: 0, id: textAtLimit });

  assert.equal(decodeLaunchCursor(launch).mint, textAtLimit);
  assert.equal(decodePaperPositionCursor(position).id, textAtLimit);
  assert.equal(decodeStreamCursor(encodeStreamCursor(MAX_CURSOR_SEQUENCE)), MAX_CURSOR_SEQUENCE);
  assert.throws(() => encodeLaunchCursor({ detectedAtMs: 0, mint: `${textAtLimit}x` }), TypeError);
  assert.throws(() => encodePaperPositionCursor({ openedAtMs: 0, id: `${textAtLimit}x` }), TypeError);
  assert.throws(() => encodeStreamCursor(MAX_CURSOR_SEQUENCE + 1n), TypeError);
  assert.throws(() => decodeLaunchCursor('A'.repeat(MAX_CURSOR_ENCODED_LENGTH + 1)), TypeError);
});
