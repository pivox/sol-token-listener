import {
  normalizePublicTokenMetadata,
  type MetadataFailureReason,
  type MetadataResolution,
} from '../domain/pumpfun-observation.js';
import type { MetadataProvider } from '../ports/metadata-provider.js';
import type {
  PublicHttpClient,
  PublicHttpFailureReason,
} from '../ports/public-http-client.js';

const JSON_CONTENT_TYPES = Object.freeze(['application/json', 'text/json'] as const);

export class HttpMetadataProvider implements MetadataProvider {
  public constructor(private readonly http: PublicHttpClient) {}

  public readonly resolve = async (uri: string): Promise<MetadataResolution> => {
    const response = await this.http.get(uri, JSON_CONTENT_TYPES);
    if (response.status === 'FAILED') {
      const reason = metadataReason(response.reason);
      return failed(reason, response.retryable);
    }

    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
    } catch {
      return failed('JSON_INVALID', false);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return failed('JSON_SHAPE_INVALID', false);
    }
    try {
      return Object.freeze({
        status: 'RESOLVED' as const,
        metadata: normalizePublicTokenMetadata(value as Readonly<Record<string, unknown>>),
      });
    } catch {
      return failed('JSON_SHAPE_INVALID', false);
    }
  };
}

function metadataReason(reason: PublicHttpFailureReason): MetadataFailureReason {
  switch (reason) {
    case 'URL_INVALID':
    case 'UNSAFE_DESTINATION':
      return 'URI_INVALID';
    case 'SCHEME_UNSUPPORTED':
      return 'UNSUPPORTED_URI_SCHEME';
    case 'REDIRECT_INVALID':
    case 'REDIRECT_LIMIT_EXCEEDED':
      return 'REDIRECT_LIMIT_EXCEEDED';
    case 'HTTP_STATUS_INVALID':
      return 'HTTP_STATUS_INVALID';
    case 'CONTENT_TOO_LARGE':
      return 'CONTENT_TOO_LARGE';
    case 'UTF8_INVALID':
      return 'JSON_INVALID';
    case 'DNS_FAILED':
    case 'TIMEOUT':
    case 'NETWORK_FAILED':
    case 'CONTENT_TYPE_UNSUPPORTED':
      return 'FETCH_FAILED';
  }
}

function failed(reason: MetadataFailureReason, retryable: boolean): MetadataResolution {
  return Object.freeze({
    status: 'FAILED' as const,
    reason,
    message: failureMessage(reason),
    retryable,
  });
}

function failureMessage(reason: MetadataFailureReason): string {
  switch (reason) {
    case 'URI_INVALID': return 'URI de métadonnées invalide ou interdite.';
    case 'UNSUPPORTED_URI_SCHEME': return 'Schéma URI de métadonnées non pris en charge.';
    case 'FETCH_FAILED': return 'Récupération des métadonnées impossible.';
    case 'HTTP_STATUS_INVALID': return 'Statut HTTP des métadonnées invalide.';
    case 'REDIRECT_LIMIT_EXCEEDED': return 'Redirection de métadonnées invalide.';
    case 'CONTENT_TOO_LARGE': return 'Contenu de métadonnées trop grand.';
    case 'JSON_INVALID': return 'JSON de métadonnées invalide.';
    case 'JSON_SHAPE_INVALID': return 'Objet JSON de métadonnées invalide.';
  }
}
