export interface SafeLiveStartupCause {
  readonly errorName: string;
  readonly code?: string;
  readonly message?: string;
}

export interface SafeLiveStartupDiagnostic {
  readonly phase: string;
  readonly stage: string;
  readonly errorName: string;
  readonly code?: string;
  readonly message?: string;
  readonly causes: readonly SafeLiveStartupCause[];
}

/** Produces bounded JSON-safe startup details; it never serializes Error objects or environment values. */
export function formatLiveStartupDiagnostics(error: unknown): readonly SafeLiveStartupDiagnostic[] {
  const diagnostics = readOwnData(error, 'diagnostics');
  if (Array.isArray(diagnostics)) {
    return Object.freeze(diagnostics.slice(0, 12).map((item) => {
      const cause = readOwnData(item, 'cause');
      const causes = cause === undefined ? [] : safeCauseChain(cause);
      const primary = causes[0];
      const code = safeCode(readOwnData(item, 'code')) ?? primary?.code;
      const message = safeMessage(readOwnData(item, 'message')) ?? primary?.message;
      return Object.freeze({
        phase: safeLabel(readOwnData(item, 'phase'), 'startup'),
        stage: safeLabel(readOwnData(item, 'stage'), 'live-startup'),
        errorName: safeName(readOwnData(item, 'errorName')),
        ...(code === undefined ? {} : { code }),
        ...(message === undefined ? {} : { message }),
        causes: Object.freeze(causes),
      });
    }));
  }
  const causes = safeCauseChain(error);
  const primary = causes[0];
  return Object.freeze([Object.freeze({
    phase: 'startup', stage: 'live-startup', errorName: primary?.errorName ?? 'UnknownError',
    ...(primary?.code === undefined ? {} : { code: primary.code }),
    ...(primary?.message === undefined ? {} : { message: primary.message }),
    causes: Object.freeze(causes.slice(1)),
  })]);
}

function safeCauseChain(error: unknown, depth = 0, seen = new Set<unknown>()): SafeLiveStartupCause[] {
  if (depth >= 5 || seen.has(error)) return [];
  seen.add(error);
  const result = [safeError(error)];
  const nestedErrors = readOwnData(error, 'errors');
  if (Array.isArray(nestedErrors)) {
    for (const nested of nestedErrors) {
      if (result.length >= 12) break;
      result.push(...safeCauseChain(nested, depth + 1, seen));
    }
  }
  const cause = readOwnData(error, 'cause');
  if (cause !== undefined && result.length < 12) result.push(...safeCauseChain(cause, depth + 1, seen));
  return result.slice(0, 12);
}

function safeError(error: unknown): SafeLiveStartupCause {
  const errorName = safeErrorName(error);
  const code = safeCode(readOwnData(error, 'code'));
  const message = safeMessage(readOwnData(error, 'message'));
  return Object.freeze({ errorName, ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) });
}

function safeErrorName(error: unknown): string {
  const ownName = readOwnData(error, 'name');
  if (typeof ownName === 'string') return safeName(ownName);
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return 'UnknownError';
  try {
    const prototype = Object.getPrototypeOf(error) as object | null;
    const descriptor = prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, 'name');
    return descriptor !== undefined && 'value' in descriptor ? safeName(descriptor.value) : 'UnknownError';
  } catch { return 'UnknownError'; }
}

function readOwnData(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function safeName(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value) ? value : 'UnknownError';
}

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value) ? value : fallback;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{1,63}$/u.test(value) ? value : undefined;
}

function safeMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, '[REDACTED_URL]')
    .replace(/\b(?:postgres(?:ql)?|mysql):\/\/[^\s"'<>]+/giu, '[REDACTED_DSN]')
    .replace(/["']?\b(password|passwd|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|private[_-]?key|credential|api[_-]?key|authorization)\b["']?\s*[:=]\s*["']?[^\s,"';}]+["']?/giu, '$1=[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED_TOKEN]')
    .slice(0, 400);
}
