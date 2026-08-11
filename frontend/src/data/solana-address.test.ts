// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { MINT } from '../../tests/fixtures/api.js';
import { isSolanaPublicKey } from './solana-address.js';

describe('canonical Solana public keys', () => {
  it('requires Base58 data decoding to exactly 32 bytes', () => {
    expect(isSolanaPublicKey(MINT)).toBe(true);
    expect(isSolanaPublicKey('z'.repeat(32))).toBe(false);
    expect(isSolanaPublicKey(`1${MINT}`)).toBe(false);
    expect(isSolanaPublicKey('0'.repeat(32))).toBe(false);
  });
});
