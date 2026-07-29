import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CURSOR_ENCODED_LENGTH,
  MAX_CURSOR_SEQUENCE,
  MAX_CURSOR_TEXT_LENGTH,
  MAX_TIMELINE_INDEX,
  MAX_TIMELINE_SLOT,
  decodeLaunchCursor,
  decodePaperPositionCursor,
  decodeStreamCursor,
  decodeTimelineCursor,
  encodeLaunchCursor,
  encodePaperPositionCursor,
  encodeStreamCursor,
  encodeTimelineCursor,
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
  assert.deepEqual(decodeTimelineCursor(encodeTimelineCursor({ slot: '9007199254740993', transactionIndex: 1,
    instructionIndex: 2, innerInstructionIndex: null, id: 'evt' })), {
    slot: '9007199254740993', transactionIndex: 1, instructionIndex: 2, innerInstructionIndex: null, id: 'evt',
  });
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
  assert.throws(() => encodeTimelineCursor({ slot: '01', transactionIndex: 0, instructionIndex: 0,
    innerInstructionIndex: null, id: 'evt' }), TypeError);
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

void test('timeline cursors use PostgreSQL numeric and integer bounds independently from streams', () => {
  const highUint64Slot = '18446744073709551615';
  const maximum = {
    slot: MAX_TIMELINE_SLOT,
    transactionIndex: MAX_TIMELINE_INDEX,
    instructionIndex: MAX_TIMELINE_INDEX,
    innerInstructionIndex: MAX_TIMELINE_INDEX,
    id: 'event-max',
  };

  assert.equal(decodeTimelineCursor(encodeTimelineCursor({
    ...maximum, slot: highUint64Slot,
  })).slot, highUint64Slot);
  assert.deepEqual(decodeTimelineCursor(encodeTimelineCursor(maximum)), maximum);
  assert.throws(() => encodeTimelineCursor({
    ...maximum, slot: `1${'0'.repeat(MAX_TIMELINE_SLOT.length)}`,
  }), TypeError);
  assert.throws(() => encodeTimelineCursor({
    ...maximum, transactionIndex: MAX_TIMELINE_INDEX + 1,
  }), TypeError);
  assert.throws(() => encodeTimelineCursor({
    ...maximum, instructionIndex: MAX_TIMELINE_INDEX + 1,
  }), TypeError);
  assert.throws(() => encodeTimelineCursor({
    ...maximum, innerInstructionIndex: MAX_TIMELINE_INDEX + 1,
  }), TypeError);
});
