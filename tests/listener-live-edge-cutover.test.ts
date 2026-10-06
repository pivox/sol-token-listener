import assert from 'node:assert/strict';
import test from 'node:test';
import { isDemonstratedOutOfWindow } from '../src/application/recorded-live-edge-cutover.js';
import type { CatchUpWindowDiagnostic } from '../src/application/catch-up-scanner.js';

const provenWindow: CatchUpWindowDiagnostic = Object.freeze({
  program: 'launchpad',
  checkpointSlot: '453623653',
  checkpointSignature: '5fPkTBH4…p6EVdqmE',
  frontierSlot: '453700000',
  frontierSignature: '5fPkTBH4…p6EVdqmE',
  pageSize: 1_000,
  maxPages: 20,
  pageCount: 20,
  signaturesRead: 20_000,
  newestSlot: '453699999',
  oldestSlot: '453690001',
  checkpointSignatureFound: false,
  frontierSignatureFound: true,
  exhaustion: 'page-budget-exhausted',
});

void test('allows a cutover only when the bounded scan proves the checkpoint is outside its window', () => {
  assert.equal(isDemonstratedOutOfWindow(provenWindow, { pageSize: 1_000, maxPages: 20 }), true);
});

void test('does not approve a cutover for reachable, ambiguous, or differently bounded scans', () => {
  assert.equal(isDemonstratedOutOfWindow({
    ...provenWindow, checkpointSignatureFound: true,
  }, { pageSize: 1_000, maxPages: 20 }), false);
  assert.equal(isDemonstratedOutOfWindow({
    ...provenWindow, oldestSlot: '453600000',
  }, { pageSize: 1_000, maxPages: 20 }), false);
  assert.equal(isDemonstratedOutOfWindow({
    ...provenWindow, signaturesRead: 19_999,
  }, { pageSize: 1_000, maxPages: 20 }), false);
  assert.equal(isDemonstratedOutOfWindow(provenWindow, { pageSize: 100, maxPages: 20 }), false);
});
