import {
  normalizePublicTokenMetadata,
  type MetadataFailureReason,
  type MetadataResolution,
} from '../domain/pumpfun-observation.js';
import type { MetadataProvider } from '../ports/metadata-provider.js';

type MetadataFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpMetadataProviderOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
}

export class HttpMetadataProvider implements MetadataProvider {
  public constructor(
    private readonly request: MetadataFetch = fetch,
    private readonly options: HttpMetadataProviderOptions = {
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      maxRedirects: 3,
    },
  ) {}

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
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.options.maxBytes) {
        return failed('CONTENT_TOO_LARGE', 'Contenu de métadonnées trop grand.');
      }
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

function failed(reason: MetadataFailureReason, message: string): MetadataResolution {
  return Object.freeze({ status: 'FAILED', reason, message });
}
