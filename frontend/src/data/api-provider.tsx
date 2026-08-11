import type { ReactNode } from 'react';
import type { ApiClient } from './api-client.js';
import { ApiClientContext } from './api-context.js';

export function ApiClientProvider({
  client,
  children,
}: { readonly client: ApiClient; readonly children: ReactNode }): ReactNode {
  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}
