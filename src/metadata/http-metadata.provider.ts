import {
  normalizePublicTokenMetadata,
  type MetadataFailureReason,
  type MetadataResolution,
} from '../domain/pumpfun-observation.js';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { MetadataProvider } from '../ports/metadata-provider.js';

type MetadataFetch = (input: string, init?: RequestInit) => Promise<Response>;
type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface HttpMetadataProviderOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
}

export class HttpMetadataProvider implements MetadataProvider {
  public constructor(
    private readonly request: MetadataFetch = safeMetadataFetch,
    private readonly options: HttpMetadataProviderOptions = {
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      maxRedirects: 3,
    },
    private readonly resolveHost: HostResolver = resolvePublicHost,
  ) {
    validateOptions(options);
  }

  public readonly resolve = async (uri: string): Promise<MetadataResolution> => {
    let current: URL;
    try {
      current = new URL(uri);
    } catch {
      return failed('URI_INVALID', 'URI de métadonnées invalide.');
    }
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      return failed('UNSUPPORTED_URI_SCHEME', 'Schéma URI non pris en charge.');
    }

    for (let redirects = 0; redirects <= this.options.maxRedirects; redirects += 1) {
      let response: Response;
      try {
        if (!(await isPublicUrl(current, this.resolveHost))) {
          return failed('URI_INVALID', 'Hôte de métadonnées interdit.');
        }
        response = await this.request(current.toString(), {
          redirect: 'manual',
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch {
        return failed('FETCH_FAILED', 'Récupération des métadonnées impossible.');
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null || redirects === this.options.maxRedirects) {
          return failed('REDIRECT_LIMIT_EXCEEDED', 'Redirection de métadonnées invalide.');
        }
        try {
          current = new URL(location, current);
        } catch {
          return failed('REDIRECT_LIMIT_EXCEEDED', 'Redirection de métadonnées invalide.');
        }
        if (current.protocol !== 'http:' && current.protocol !== 'https:') {
          return failed('UNSUPPORTED_URI_SCHEME', 'Redirection vers un schéma non pris en charge.');
        }
        continue;
      }
      if (!response.ok) return failed('HTTP_STATUS_INVALID', `HTTP ${response.status}.`);
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > this.options.maxBytes) {
        return failed('CONTENT_TOO_LARGE', 'Contenu de métadonnées trop grand.');
      }
      let bytes: Uint8Array | null;
      try {
        bytes = await readBounded(response, this.options.maxBytes);
      } catch {
        return failed('FETCH_FAILED', 'Lecture des métadonnées impossible.');
      }
      if (bytes === null) return failed('CONTENT_TOO_LARGE', 'Contenu de métadonnées trop grand.');
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        return failed('JSON_INVALID', 'JSON de métadonnées invalide.');
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return failed('JSON_SHAPE_INVALID', 'Objet JSON de métadonnées attendu.');
      }
      try {
        return Object.freeze({
          status: 'RESOLVED' as const,
          metadata: normalizePublicTokenMetadata(value as Record<string, unknown>),
        });
      } catch {
        return failed('JSON_SHAPE_INVALID', 'Champs JSON de métadonnées invalides.');
      }
    }
    return failed('REDIRECT_LIMIT_EXCEEDED', 'Limite de redirections atteinte.');
  };
}

function safeMetadataFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const options: RequestOptions = {
    method: 'GET',
    signal: init?.signal ?? undefined,
    lookup(hostname, _options, callback) {
      void resolvePublicHost(hostname).then(
        (addresses) => {
          const address = addresses.find(isPublicIp);
          if (address === undefined) {
            callback(new Error('Hôte de métadonnées interdit.'), '', 0);
            return;
          }
          callback(null, address, isIP(address));
        },
        (error: unknown) => {
          callback(
            error instanceof Error ? error : new Error('Résolution DNS impossible.'),
            '',
            0,
          );
        },
      );
    },
  };
  return new Promise<Response>((resolve, reject) => {
    const outbound = request(url, options, (response) => {
      resolve(toResponse(response));
    });
    outbound.once('error', reject);
    outbound.end();
  });
}

function toResponse(response: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const part of value) headers.append(name, part);
      continue;
    }
    headers.set(name, value);
  }
  const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
  return new Response(body, { status: response.statusCode ?? 500, headers });
}

async function resolvePublicHost(hostname: string): Promise<readonly string[]> {
  const entries = await lookup(hostname, { all: true });
  return entries.map((entry) => entry.address);
}

async function isPublicUrl(url: URL, resolveHost: HostResolver): Promise<boolean> {
  if (url.username !== '' || url.password !== '' || url.hostname === 'localhost') return false;
  try {
    const addresses = await resolveHost(url.hostname);
    return addresses.length > 0 && addresses.every(isPublicIp);
  } catch {
    return false;
  }
}

function isPublicIp(address: string): boolean {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized !== '::' && normalized !== '::1'
      && !normalized.startsWith('::ffff:')
      && !normalized.startsWith('fc')
      && !normalized.startsWith('fd')
      && !normalized.startsWith('fe80');
  }
  if (isIP(address) !== 4) return false;
  const octets = address.split('.').map(Number);
  const first = octets[0];
  const second = octets[1];
  if (first === undefined) return false;
  return first !== 0
    && first !== 10
    && first !== 127
    && first < 224
    && !(first === 100 && second !== undefined && second >= 64 && second <= 127)
    && !(first === 169 && second === 254)
    && !(first === 172 && second !== undefined && second >= 16 && second <= 31)
    && !(first === 192 && second !== undefined && (second === 0 || second === 168))
    && !(first === 198 && second !== undefined && (second === 18 || second === 19));
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null) return new Uint8Array();
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read() as
      | { readonly done: true; readonly value?: undefined }
      | { readonly done: false; readonly value: Uint8Array };
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(result.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function validateOptions(options: HttpMetadataProviderOptions): void {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('timeoutMs doit être un entier positif sûr.');
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new RangeError('maxBytes doit être un entier positif sûr.');
  }
  if (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0) {
    throw new RangeError('maxRedirects doit être un entier positif sûr ou nul.');
  }
}

function failed(reason: MetadataFailureReason, message: string): MetadataResolution {
  return Object.freeze({ status: 'FAILED', reason, message });
}
