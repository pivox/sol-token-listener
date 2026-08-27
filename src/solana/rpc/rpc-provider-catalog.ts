import type { AppConfig } from '../../config/env.js';

export type RpcProviderId = 'primary' | `fallback-${1 | 2 | 3}`;

export interface RpcProviderPair {
  readonly id: RpcProviderId;
  readonly httpUrl: string;
  readonly websocketUrl: string;
}

export interface RpcProviderCatalog {
  readonly ids: readonly RpcProviderId[];
  resolve(id: RpcProviderId): RpcProviderPair;
}

type RpcProviderCatalogConfig = Pick<
  AppConfig,
  'httpRpcUrl' | 'httpRpcFallbackUrls' | 'wsRpcUrl' | 'wsRpcFallbackUrls'
>;

export function createRpcProviderCatalog(
  config: RpcProviderCatalogConfig,
): RpcProviderCatalog {
  if (!validConfigShape(config)) throw invalidCatalog();
  const httpFallbacks = [...config.httpRpcFallbackUrls];
  const websocketFallbacks = [...config.wsRpcFallbackUrls];
  if (httpFallbacks.length > 3
    || websocketFallbacks.length > 3
    || (websocketFallbacks.length > 0 && websocketFallbacks.length !== httpFallbacks.length)
    || !validPrimary(config.httpRpcUrl, config.wsRpcUrl, websocketFallbacks.length > 0)
    || (websocketFallbacks.length > 0 && (
      !uniqueUrls([config.httpRpcUrl, ...httpFallbacks])
      || !uniqueUrls([config.wsRpcUrl, ...websocketFallbacks])
    ))) {
    throw invalidCatalog();
  }

  const pairs: RpcProviderPair[] = [pair('primary', config.httpRpcUrl, config.wsRpcUrl)];
  for (const [index, websocketUrl] of websocketFallbacks.entries()) {
    const httpUrl = httpFallbacks[index];
    if (httpUrl === undefined || !validStrictPair(httpUrl, websocketUrl)) throw invalidCatalog();
    pairs.push(pair(`fallback-${index + 1}` as RpcProviderId, httpUrl, websocketUrl));
  }
  const byId = new Map<RpcProviderId, RpcProviderPair>(pairs.map((value) => [value.id, value]));
  const ids = Object.freeze(pairs.map(({ id }) => id));
  return Object.freeze({
    ids,
    resolve(id: RpcProviderId): RpcProviderPair {
      const value = byId.get(id);
      if (value === undefined) throw invalidCatalog();
      return value;
    },
  });
}

function validConfigShape(value: unknown): value is RpcProviderCatalogConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const candidate = value as Partial<RpcProviderCatalogConfig>;
    return typeof candidate.httpRpcUrl === 'string'
      && Array.isArray(candidate.httpRpcFallbackUrls)
      && candidate.httpRpcFallbackUrls.every((entry: unknown) => typeof entry === 'string')
      && typeof candidate.wsRpcUrl === 'string'
      && Array.isArray(candidate.wsRpcFallbackUrls)
      && candidate.wsRpcFallbackUrls.every((entry: unknown) => typeof entry === 'string');
  } catch {
    return false;
  }
}

function validPrimary(httpUrl: string, websocketUrl: string, strict: boolean): boolean {
  try {
    const http = new URL(httpUrl);
    const websocket = new URL(websocketUrl);
    if (http.protocol !== 'http:' && http.protocol !== 'https:') return false;
    if (websocket.protocol !== 'ws:' && websocket.protocol !== 'wss:') return false;
    return !strict || validStrictPair(httpUrl, websocketUrl);
  } catch {
    return false;
  }
}

function validStrictPair(httpUrl: string, websocketUrl: string): boolean {
  try {
    const http = new URL(httpUrl);
    const websocket = new URL(websocketUrl);
    if (http.hash !== '' || websocket.hash !== '') return false;
    return (http.protocol === 'https:' && websocket.protocol === 'wss:')
      || (http.protocol === 'http:' && websocket.protocol === 'ws:');
  } catch {
    return false;
  }
}

function uniqueUrls(values: readonly string[]): boolean {
  try {
    return new Set(values.map((value) => new URL(value).toString())).size === values.length;
  } catch {
    return false;
  }
}

function pair(
  id: RpcProviderId,
  httpUrl: string,
  websocketUrl: string,
): RpcProviderPair {
  return Object.freeze({ id, httpUrl, websocketUrl });
}

function invalidCatalog(): TypeError {
  return new TypeError('RPC provider catalog is invalid.');
}
