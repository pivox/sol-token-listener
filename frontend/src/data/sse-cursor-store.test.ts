// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { createSseCursorStore } from './sse-cursor-store.js';

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('origin-scoped SSE cursor store', () => {
  it('uses a versioned normalized-origin key and isolates origins', () => {
    const storage = new MemoryStorage();
    const first = createSseCursorStore('https://api.example/path/', storage);
    const same = createSseCursorStore('https://api.example/other', storage);
    const other = createSseCursorStore('https://other.example', storage);

    first.save('cursor-a');
    expect([...storage.values.keys()][0]).toContain('v1');
    expect([...storage.values.keys()][0]).toContain(encodeURIComponent('https://api.example'));
    expect(same.read()).toBe('cursor-a');
    expect(other.read()).toBeNull();
  });

  it('rejects oversized/control values and deletes malformed stored cursors', () => {
    const storage = new MemoryStorage();
    const store = createSseCursorStore('https://api.example', storage);
    expect(() => { store.save('x'.repeat(513)); }).toThrow();
    expect(() => { store.save('bad\ncursor'); }).toThrow();
    storage.setItem(store.storageKey, 'bad\0cursor');
    expect(store.read()).toBeNull();
    expect(storage.getItem(store.storageKey)).toBeNull();
  });

  it('degrades to isolated in-memory storage when browser storage throws', () => {
    const storage = new MemoryStorage();
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(storage, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    const store = createSseCursorStore('https://api.example', storage);
    store.save('cursor-memory');
    expect(store.read()).toBe('cursor-memory');
    store.clear();
    expect(store.read()).toBeNull();
  });
});
