/** Only an errno code reaches the log, never a message (it may quote a path or a value). */
export function errnoCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return typeof code === 'string' && /^E[A-Z0-9]+$/u.test(code) ? code : 'unknown';
}
