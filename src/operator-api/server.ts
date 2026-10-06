import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodeLedgerCursor } from '../api/cursor.js';
import { success, writeJson } from '../interfaces/http/api-response.js';
import type { LiveOverviewReader, LiveOverviewRequest } from './repository.js';

export const OPERATOR_OVERVIEW_PATH = '/operator/v1/live/overview';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ALLOW = 'GET, OPTIONS';

export type OperatorApiErrorCode =
  | 'UNAUTHORIZED' | 'HOST_NOT_ALLOWED' | 'METHOD_NOT_ALLOWED' | 'ROUTE_NOT_FOUND'
  | 'INVALID_LIMIT' | 'INVALID_CURSOR' | 'INTERNAL_ERROR';

const MESSAGES: Readonly<Record<OperatorApiErrorCode, string>> = {
  UNAUTHORIZED: 'A valid operator token is required',
  HOST_NOT_ALLOWED: 'The request host is not allowed',
  METHOD_NOT_ALLOWED: 'The HTTP method is not allowed for this route',
  ROUTE_NOT_FOUND: 'The requested route was not found',
  INVALID_LIMIT: 'The limit is invalid',
  INVALID_CURSOR: 'The cursor is invalid',
  INTERNAL_ERROR: 'An internal error occurred',
};

export interface OperatorApiHandlerOptions {
  readonly token: string;
  readonly allowedHost: string;
  readonly allowedOrigin: string;
  readonly overview: LiveOverviewReader;
  readonly now: () => number;
  readonly logError?: (errorName: string) => void;
}

export type OperatorApiHandler = (request: IncomingMessage, response: ServerResponse) => void;

export function createOperatorApiHandler(options: OperatorApiHandlerOptions): OperatorApiHandler {
  const expectedDigest = digest(options.token);
  const corsHeaders = Object.freeze({
    'access-control-allow-origin': options.allowedOrigin,
    vary: 'Origin',
  });
  // The database wrapper allows one active client; requests wait for each other.
  let queue: Promise<unknown> = Promise.resolve();

  const fail = (
    response: ServerResponse, status: number, code: OperatorApiErrorCode,
    extra: Readonly<Record<string, string>> = {},
  ): void => {
    writeJson(response, status, {
      apiVersion: 'v1', error: { code, message: MESSAGES[code] },
    }, false, { ...corsHeaders, ...extra });
  };

  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.headers.host !== options.allowedHost) {
      fail(response, 421, 'HOST_NOT_ALLOWED');
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...corsHeaders,
        allow: ALLOW,
        'access-control-allow-methods': ALLOW,
        'access-control-allow-headers': 'Authorization',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
      });
      response.end();
      return;
    }
    if (request.method !== 'GET') {
      fail(response, 405, 'METHOD_NOT_ALLOWED', { allow: ALLOW });
      return;
    }
    if (!isAuthorized(request.headers.authorization, expectedDigest)) {
      fail(response, 401, 'UNAUTHORIZED', { 'www-authenticate': 'Bearer' });
      return;
    }
    // Origin-form targets only, matched on the raw path: no absolute-form, `//` or dot-segment aliases.
    const target = request.url;
    if (target === undefined || !target.startsWith('/') || target.startsWith('//')) {
      fail(response, 404, 'ROUTE_NOT_FOUND');
      return;
    }
    const queryStart = target.indexOf('?');
    const rawPath = queryStart === -1 ? target : target.slice(0, queryStart);
    if (rawPath !== OPERATOR_OVERVIEW_PATH) {
      fail(response, 404, 'ROUTE_NOT_FOUND');
      return;
    }
    const parsed = parseRequest(new URLSearchParams(queryStart === -1 ? '' : target.slice(queryStart + 1)));
    if (typeof parsed === 'string') {
      fail(response, 400, parsed);
      return;
    }
    const run = queue.then(() => options.overview.read(parsed));
    queue = run.catch(() => undefined);
    const page = await run;
    writeJson(response, 200, success(page.data, options.now(), page.nextCursor), false, corsHeaders);
  };

  return (request, response) => {
    serve(request, response).catch((error: unknown) => {
      try {
        options.logError?.(error instanceof Error ? error.name : 'UnknownError');
      } catch { /* diagnostics never change the response */ }
      if (!response.headersSent) fail(response, 500, 'INTERNAL_ERROR');
      else response.destroy();
    });
  };
}

function parseRequest(query: URLSearchParams): LiveOverviewRequest | 'INVALID_LIMIT' | 'INVALID_CURSOR' {
  const rawLimit = query.get('limit');
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^[1-9]\d{0,2}$/u.test(rawLimit)) return 'INVALID_LIMIT';
    limit = Number(rawLimit);
    if (limit > MAX_LIMIT) return 'INVALID_LIMIT';
  }
  const rawCursor = query.get('cursor');
  if (rawCursor === null) return { limit, cursor: null };
  try {
    return { limit, cursor: decodeLedgerCursor(rawCursor) };
  } catch {
    return 'INVALID_CURSOR';
  }
}

function isAuthorized(header: string | undefined, expectedDigest: Buffer): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice('Bearer '.length)), expectedDigest);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
