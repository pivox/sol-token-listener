const TOKEN_KEY = 'operator-api-token';

// sessionStorage keeps the token for this tab only; every access tolerates a blocked store.
export function readOperatorToken(): string | null {
  try {
    const value = globalThis.sessionStorage.getItem(TOKEN_KEY);
    return value === null || value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

export function saveOperatorToken(token: string): void {
  try {
    globalThis.sessionStorage.setItem(TOKEN_KEY, token);
  } catch { /* the token then lives only in component state */ }
}

export function clearOperatorToken(): void {
  try {
    globalThis.sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* nothing was stored */ }
}
