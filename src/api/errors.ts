export const API_ERROR_CODES = [
  'ROUTE_NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'NOT_ACCEPTABLE',
  'INVALID_MINT',
  'INVALID_LIMIT',
  'INVALID_CURSOR',
  'LAUNCH_NOT_FOUND',
  'EVENT_CURSOR_EXPIRED',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const API_ERROR_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  ROUTE_NOT_FOUND: 'The requested route was not found',
  METHOD_NOT_ALLOWED: 'The HTTP method is not allowed for this route',
  NOT_ACCEPTABLE: 'The requested representation is not acceptable',
  INVALID_MINT: 'The mint is invalid',
  INVALID_LIMIT: 'The limit is invalid',
  INVALID_CURSOR: 'The cursor is invalid',
  LAUNCH_NOT_FOUND: 'The launch was not found',
  EVENT_CURSOR_EXPIRED: 'The event cursor has expired',
  DEPENDENCY_UNAVAILABLE: 'A required service is temporarily unavailable',
  INTERNAL_ERROR: 'An internal error occurred',
};

export interface ApiErrorOptions extends Omit<ErrorOptions, 'cause'> {
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  readonly cause?: unknown;
  readonly correlationId?: string;
}

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly httpStatus: number;
  public readonly correlationId?: string;

  public constructor(options: ApiErrorOptions) {
    super(API_ERROR_MESSAGES[options.code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    if (options.correlationId !== undefined) this.correlationId = options.correlationId;
  }
}
