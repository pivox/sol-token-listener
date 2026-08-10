import { useContext } from 'react';
import type { ApiClient } from './api-client.js';
import { ApiClientContext } from './api-context.js';

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === null) throw new Error('useApiClient must be used inside ApiClientProvider');
  return client;
}
