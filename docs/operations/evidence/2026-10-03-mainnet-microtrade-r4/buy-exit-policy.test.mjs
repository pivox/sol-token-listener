import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifiesExternalBuy } from './buy-exit-policy.mjs';
const buy = { isBuy: true, user: 'external', slot: 101, solAmountLamports: '9000000' };
test('counts an external buy strictly larger than our executed buy', () => assert.equal(qualifiesExternalBuy(buy, 100, 'our-wallet', 8000000n), true));
test('rejects equal amount', () => assert.equal(qualifiesExternalBuy({ ...buy, solAmountLamports: '8000000' }, 100, 'our-wallet', 8000000n), false));
test('rejects own buy, earlier slot, and external sale', () => { assert.equal(qualifiesExternalBuy({ ...buy, user: 'our-wallet' }, 100, 'our-wallet', 8000000n), false); assert.equal(qualifiesExternalBuy({ ...buy, slot: 100 }, 100, 'our-wallet', 8000000n), false); assert.equal(qualifiesExternalBuy({ ...buy, isBuy: false }, 100, 'our-wallet', 8000000n), false); });
