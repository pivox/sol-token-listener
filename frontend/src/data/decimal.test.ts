// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  DecimalFormatError,
  formatBasisPoints,
  formatInteger,
  formatRawAmount,
} from './decimal.js';

describe('integer financial formatting', () => {
  it('groups arbitrarily large signed integers without number coercion', () => {
    expect(formatInteger('12345678901234567890')).toBe('12\u202f345\u202f678\u202f901\u202f234\u202f567\u202f890');
    expect(formatInteger('-1000')).toBe('-1\u202f000');
    expect(formatInteger('0')).toBe('0');
  });

  it('formats basis points exactly from bigint division and remainder', () => {
    expect(formatBasisPoints('1234')).toBe('12.34%');
    expect(formatBasisPoints('-5')).toBe('-0.05%');
    expect(formatBasisPoints('10000')).toBe('100.00%');
  });

  it('formats raw token amounts using decimal string slicing', () => {
    expect(formatRawAmount('123456789', 6)).toBe('123.456789');
    expect(formatRawAmount('-5', 2)).toBe('-0.05');
    expect(formatRawAmount('100', 2)).toBe('1.00');
    expect(formatRawAmount('42', 0)).toBe('42');
  });

  it.each(['', ' 1', '+1', '1.2', '1e3', '--1'])('rejects malformed decimal integer %j', (value) => {
    expect(() => formatInteger(value)).toThrow(DecimalFormatError);
    expect(() => formatBasisPoints(value)).toThrow(DecimalFormatError);
  });

  it('rejects unsafe decimal counts', () => {
    expect(() => formatRawAmount('1', -1)).toThrow(DecimalFormatError);
    expect(() => formatRawAmount('1', 256)).toThrow(DecimalFormatError);
    expect(() => formatRawAmount('1', 1.5)).toThrow(DecimalFormatError);
  });
});
