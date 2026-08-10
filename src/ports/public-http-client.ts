export type PublicHttpFailureReason =
  | 'URL_INVALID'
  | 'SCHEME_UNSUPPORTED'
  | 'UNSAFE_DESTINATION'
  | 'DNS_FAILED'
  | 'TIMEOUT'
  | 'NETWORK_FAILED'
  | 'REDIRECT_INVALID'
  | 'REDIRECT_LIMIT_EXCEEDED'
  | 'HTTP_STATUS_INVALID'
  | 'CONTENT_TYPE_UNSUPPORTED'
  | 'CONTENT_TOO_LARGE'
  | 'UTF8_INVALID';

export type PublicHttpResult =
  | Readonly<{
      status: 'SUCCEEDED';
      finalUrl: string;
      httpStatus: number;
      contentType: string;
      redirectCount: number;
      body: Uint8Array;
    }>
  | Readonly<{
      status: 'FAILED';
      reason: PublicHttpFailureReason;
      retryable: boolean;
    }>;

export interface PublicHttpClient {
  get(url: string, acceptedContentTypes: readonly string[]): Promise<PublicHttpResult>;
}

