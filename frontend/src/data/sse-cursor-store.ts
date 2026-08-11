const MAXIMUM_CURSOR_LENGTH = 512;

export interface SseCursorStore {
  readonly storageKey: string;
  read(): string | null;
  save(cursor: string): void;
  clear(): void;
}

export function createSseCursorStore(apiBaseUrl: string, storage?: Storage): SseCursorStore {
  const origin = new URL(apiBaseUrl).origin;
  const storageKey = `sol-token-listener:v1:sse-cursor:${encodeURIComponent(origin)}`;
  let memoryValue: string | null = null;

  return Object.freeze({
    storageKey,
    read(): string | null {
      if (storage === undefined) return memoryValue;
      let stored: string | null;
      try {
        stored = storage.getItem(storageKey);
      } catch {
        return memoryValue;
      }
      if (stored === null) return memoryValue;
      if (!isValidCursor(stored)) {
        memoryValue = null;
        try {
          storage.removeItem(storageKey);
        } catch {
          // The in-memory fallback is already cleared.
        }
        return null;
      }
      memoryValue = stored;
      return stored;
    },
    save(cursor: string): void {
      if (!isValidCursor(cursor)) throw new TypeError('Invalid SSE cursor');
      memoryValue = cursor;
      try {
        storage?.setItem(storageKey, cursor);
      } catch {
        // Keep operating with the isolated in-memory value.
      }
    },
    clear(): void {
      memoryValue = null;
      try {
        storage?.removeItem(storageKey);
      } catch {
        // The in-memory fallback is already cleared.
      }
    },
  });
}

function isValidCursor(value: string): boolean {
  if (value.length === 0 || value.length > MAXIMUM_CURSOR_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}
