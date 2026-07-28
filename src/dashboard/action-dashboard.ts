import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DashboardActionService } from './dashboard-action.service.js';
import { stringifyJson } from '../utils/json.js';

export function handleDashboardAction(
  request: IncomingMessage,
  response: ServerResponse,
  actions: DashboardActionService,
): boolean {
  if (request.url?.startsWith('/api/actions/') !== true) return false;
  const result = actions.execute(request.url, null);
  writeJson(response, 403, result);
  return true;
}

export function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(stringifyJson(value));
}
