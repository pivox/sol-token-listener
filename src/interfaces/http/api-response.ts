import type { ServerResponse } from 'node:http';
import {
  API_VERSION,
  toApiJson,
  type ApiFailure,
  type ApiSuccess,
} from '../../api/contracts.js';
import { type ApiError } from '../../api/errors.js';

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
});

export function success<T>(data: T, nowMs: number, nextCursor: string | null = null): ApiSuccess<T> {
  return {
    apiVersion: API_VERSION,
    meta: { generatedAt: toIsoTimestamp(nowMs), nextCursor },
    data,
  };
}

export function failure(error: ApiError): ApiFailure {
  const correlationId = error.correlationId;
  return {
    apiVersion: API_VERSION,
    error: {
      code: error.code,
      message: error.message,
      ...(correlationId === undefined ? {} : { correlationId }),
    },
  };
}

export function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headOnly = false,
  extraHeaders: Readonly<Record<string, string | number>> = {},
): void {
  const payload = JSON.stringify(toApiJson(body));
  response.writeHead(status, {
    ...JSON_HEADERS,
    ...extraHeaders,
    'content-length': Buffer.byteLength(payload, 'utf8'),
  });
  response.end(headOnly ? undefined : payload);
}

function toIsoTimestamp(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs)) throw new TypeError('Response timestamp must be a safe integer');
  const date = new Date(nowMs);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Response timestamp must be finite');
  return date.toISOString();
}
