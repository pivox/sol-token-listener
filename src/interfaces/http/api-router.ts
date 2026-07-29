import type { IncomingMessage, ServerResponse } from 'node:http';
import bs58 from 'bs58';
import { decodeLaunchCursor, decodePaperPositionCursor, decodeTimelineCursor } from '../../api/cursor.js';
import { ApiError } from '../../api/errors.js';
import type { ApiLaunchDetail } from '../../api/contracts.js';
import type { ApiProjectionRepository, PageRequest } from '../../ports/api-projection-repository.js';
import { failure, success, writeJson } from './api-response.js';

const ALLOW = 'GET, HEAD, OPTIONS';

type LogContext = Readonly<{
  route: string;
  method: string;
  correlationId: string;
}>;

export interface ApiRouterDependencies {
  readonly projections: ApiProjectionRepository;
  readonly now: () => number;
  readonly defaultLimit: number;
  readonly maximumLimit: number;
  readonly correlationId: () => string;
  readonly logError: (context: LogContext, error: unknown) => void;
}

export type ApiRouter = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

type Route =
  | Readonly<{ name: 'launches' }>
  | Readonly<{ name: 'launch'; mint: string }>
  | Readonly<{ name: 'events'; mint: string }>
  | Readonly<{ name: 'risk'; mint: string }>
  | Readonly<{ name: 'social'; mint: string }>
  | Readonly<{ name: 'holders'; mint: string }>
  | Readonly<{ name: 'paperPositions' }>
  | Readonly<{ name: 'health' }>;

type Query = ReadonlyMap<string, string>;

class ApiRequestError extends ApiError {}

export function createApiRouter(deps: ApiRouterDependencies): ApiRouter {
  assertLimits(deps.defaultLimit, deps.maximumLimit);

  return async (request, response): Promise<void> => {
    const method = request.method ?? 'GET';
    let routeLabel = 'unknown';
    try {
      const parsed = parseTarget(request.url);
      const route = matchRoute(parsed.pathname);
      routeLabel = route.name;
      const headOnly = method === 'HEAD';

      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        writeFailure(response, new ApiError({ code: 'METHOD_NOT_ALLOWED', httpStatus: 405 }));
        return;
      }
      if (hasRequestBody(request)) {
        writeFailure(response, new ApiError({ code: 'METHOD_NOT_ALLOWED', httpStatus: 405 }), headOnly);
        return;
      }
      if (method === 'OPTIONS') {
        writeOptions(response);
        return;
      }

      const query = parseQuery(parsed.query);
      const result = await dispatch(route, query, deps);
      writeJson(response, 200, success(result.data, deps.now(), result.nextCursor), headOnly);
    } catch (error) {
      if (error instanceof ApiRequestError || (
        error instanceof ApiError && error.code === 'DEPENDENCY_UNAVAILABLE'
      )) {
        writeFailure(response, error, method === 'HEAD');
        return;
      }
      const correlationId = safeCorrelationId(deps.correlationId);
      safeLog(deps.logError, { route: routeLabel, method: safeMethod(method), correlationId }, error);
      writeFailure(response, new ApiError({
        code: 'INTERNAL_ERROR', httpStatus: 500, correlationId,
      }), method === 'HEAD');
    }
  };
}

async function dispatch(
  route: Route,
  query: Query,
  deps: ApiRouterDependencies,
): Promise<Readonly<{ data: unknown; nextCursor: string | null }>> {
  switch (route.name) {
    case 'launches': {
      const page = await deps.projections.listLaunches(pageRequest(query, deps, decodeLaunchCursor));
      return { data: page.items, nextCursor: page.nextCursor };
    }
    case 'launch':
      requireNoQuery(query);
      return { data: await requireLaunch(deps.projections, route.mint), nextCursor: null };
    case 'events': {
      const request = pageRequest(query, deps, decodeTimelineCursor);
      const launch = await requireLaunch(deps.projections, route.mint);
      void launch;
      const page = await deps.projections.listLaunchEvents(
        route.mint,
        request,
      );
      return { data: page.items, nextCursor: page.nextCursor };
    }
    case 'risk': {
      requireNoQuery(query);
      const launch = await requireLaunch(deps.projections, route.mint);
      void launch;
      return { data: await deps.projections.getLaunchRisk(route.mint), nextCursor: null };
    }
    case 'social': {
      requireNoQuery(query);
      const launch = await requireLaunch(deps.projections, route.mint);
      void launch;
      return { data: await deps.projections.getLaunchSocial(route.mint), nextCursor: null };
    }
    case 'holders': {
      requireNoQuery(query);
      const launch = await requireLaunch(deps.projections, route.mint);
      void launch;
      return { data: await deps.projections.getLaunchHolders(route.mint), nextCursor: null };
    }
    case 'paperPositions': {
      const page = await deps.projections.listPaperPositions(
        pageRequest(query, deps, decodePaperPositionCursor),
      );
      return { data: page.items, nextCursor: page.nextCursor };
    }
    case 'health':
      requireNoQuery(query);
      return { data: await deps.projections.getHealth(), nextCursor: null };
  }
}

async function requireLaunch(repository: ApiProjectionRepository, mint: string): Promise<ApiLaunchDetail> {
  const launch = await repository.getLaunch(mint);
  if (launch === null) throw new ApiRequestError({ code: 'LAUNCH_NOT_FOUND', httpStatus: 404 });
  return launch;
}

function pageRequest<T>(
  query: Query,
  deps: ApiRouterDependencies,
  decodeCursor: (cursor: string) => T,
): PageRequest<T> {
  for (const key of query.keys()) {
    if (key !== 'limit' && key !== 'cursor') throw invalidLimit();
  }
  const limitValue = query.get('limit');
  const cursorValue = query.get('cursor');
  const limit = limitValue === undefined ? deps.defaultLimit : parseLimit(limitValue, deps.maximumLimit);
  let after: T | null = null;
  if (cursorValue !== undefined) {
    try {
      after = decodeCursor(cursorValue);
    } catch {
      throw new ApiRequestError({ code: 'INVALID_CURSOR', httpStatus: 400 });
    }
  }
  return { limit, after };
}

function parseTarget(target: string | undefined): Readonly<{ pathname: string; query: string }> {
  if (target === undefined || !target.startsWith('/') || target.includes('#')) {
    throw new ApiRequestError({ code: 'ROUTE_NOT_FOUND', httpStatus: 404 });
  }
  const questionMark = target.indexOf('?');
  const pathname = questionMark === -1 ? target : target.slice(0, questionMark);
  const query = questionMark === -1 ? '' : target.slice(questionMark + 1);
  if (pathname.includes('?')) {
    throw new ApiRequestError({ code: 'ROUTE_NOT_FOUND', httpStatus: 404 });
  }
  return { pathname, query };
}

function matchRoute(pathname: string): Route {
  if (pathname === '/api/v1/launches') return { name: 'launches' };
  if (pathname === '/api/v1/paper-positions') return { name: 'paperPositions' };
  if (pathname === '/api/v1/health') return { name: 'health' };
  const match = /^\/api\/v1\/launches\/([^/]+)(?:\/(events|risk|social|holders))?$/u.exec(pathname);
  if (match === null) throw new ApiRequestError({ code: 'ROUTE_NOT_FOUND', httpStatus: 404 });
  const mint = parseMint(match[1]);
  switch (match[2]) {
    case undefined: return { name: 'launch', mint };
    case 'events': return { name: 'events', mint };
    case 'risk': return { name: 'risk', mint };
    case 'social': return { name: 'social', mint };
    case 'holders': return { name: 'holders', mint };
    default: throw new ApiRequestError({ code: 'ROUTE_NOT_FOUND', httpStatus: 404 });
  }
}

function parseMint(rawMint: string | undefined): string {
  if (rawMint === undefined) throw new ApiRequestError({ code: 'INVALID_MINT', httpStatus: 400 });
  let mint: string;
  try {
    mint = decodeURIComponent(rawMint);
  } catch {
    throw new ApiRequestError({ code: 'INVALID_MINT', httpStatus: 400 });
  }
  if (
    rawMint !== mint
    || mint.length === 0
    || mint.includes('/')
    || !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(mint)
  ) {
    throw new ApiRequestError({ code: 'INVALID_MINT', httpStatus: 400 });
  }
  try {
    const decoded = bs58.decode(mint);
    if (decoded.length !== 32 || bs58.encode(decoded) !== mint) throw new TypeError('Non-canonical mint');
  } catch {
    throw new ApiRequestError({ code: 'INVALID_MINT', httpStatus: 400 });
  }
  return mint;
}

function parseQuery(rawQuery: string): Query {
  if (rawQuery === '') return new Map<string, string>();
  const values = new Map<string, string>();
  for (const pair of rawQuery.split('&')) {
    const separator = pair.indexOf('=');
    const rawKey = separator === -1 ? pair : pair.slice(0, separator);
    const rawValue = separator === -1 ? '' : pair.slice(separator + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey.replaceAll('+', ' '));
      value = decodeURIComponent(rawValue.replaceAll('+', ' '));
    } catch {
      throw invalidLimit();
    }
    if (key.length === 0 || values.has(key)) throw invalidLimit();
    values.set(key, value);
  }
  return values;
}

function parseLimit(value: string, maximum: number): number {
  if (!/^[1-9]\d*$/u.test(value)) throw invalidLimit();
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > maximum) throw invalidLimit();
  return limit;
}

function requireNoQuery(query: Query): void {
  if (query.size !== 0) throw invalidLimit();
}

function invalidLimit(): ApiRequestError {
  return new ApiRequestError({ code: 'INVALID_LIMIT', httpStatus: 400 });
}

function hasRequestBody(request: IncomingMessage): boolean {
  const contentLength = request.headers['content-length'];
  const transferEncoding = request.headers['transfer-encoding'];
  return transferEncoding !== undefined || (contentLength !== undefined && contentLength !== '0');
}

function writeOptions(response: ServerResponse): void {
  response.writeHead(204, {
    allow: ALLOW,
    'content-length': 0,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': ALLOW,
  });
  response.end();
}

function writeFailure(response: ServerResponse, error: ApiError, headOnly = false): void {
  writeJson(
    response,
    error.httpStatus,
    failure(error),
    headOnly,
    error.code === 'METHOD_NOT_ALLOWED' ? { allow: ALLOW } : {},
  );
}

function assertLimits(defaultLimit: number, maximumLimit: number): void {
  if (
    !Number.isSafeInteger(defaultLimit)
    || !Number.isSafeInteger(maximumLimit)
    || defaultLimit <= 0
    || maximumLimit <= 0
    || defaultLimit > maximumLimit
  ) throw new TypeError('API pagination limits must be positive safe integers');
}

function safeCorrelationId(nextCorrelationId: () => string): string {
  try {
    const value = nextCorrelationId();
    if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)) return value;
  } catch {
    // A failure to generate a diagnostic token must not prevent a redacted response.
  }
  return 'unavailable';
}

function safeLog(logError: ApiRouterDependencies['logError'], context: LogContext, error: unknown): void {
  try {
    logError(context, error);
  } catch {
    // Logging must never turn an otherwise safe HTTP response into a transport failure.
  }
}

function safeMethod(method: string): string {
  return /^[A-Z]+$/u.test(method) ? method : 'UNKNOWN';
}
