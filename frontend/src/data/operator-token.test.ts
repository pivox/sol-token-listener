import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearOperatorToken, readOperatorToken, saveOperatorToken } from './operator-token.js';

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('operator token storage', () => {
  it('keeps the token in sessionStorage only and forgets it on demand', () => {
    expect(readOperatorToken()).toBeNull();
    saveOperatorToken('secret-token');
    expect(readOperatorToken()).toBe('secret-token');
    expect(window.sessionStorage.getItem('operator-api-token')).toBe('secret-token');
    clearOperatorToken();
    expect(readOperatorToken()).toBeNull();
  });

  it('tolerates a blocked storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readOperatorToken()).toBeNull();
    expect(() => { saveOperatorToken('secret-token'); }).not.toThrow();
    expect(() => { clearOperatorToken(); }).not.toThrow();
  });
});
