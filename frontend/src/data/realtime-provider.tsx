import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { invalidationKeysForEvent } from './query-keys.js';
import { createSseClient } from './sse-client.js';
import type { SseClient } from './sse-client.js';
import { createSseCursorStore } from './sse-cursor-store.js';
import { RealtimeContext } from './realtime-context.js';

export interface RealtimeProviderProps {
  readonly apiBaseUrl: string;
  readonly children: ReactNode;
  readonly client?: SseClient;
  readonly fetchFn?: typeof fetch;
  readonly storage?: Storage;
}

export function RealtimeProvider({
  apiBaseUrl,
  children,
  client: providedClient,
  fetchFn,
  storage,
}: RealtimeProviderProps): ReactNode {
  const queryClient = useQueryClient();
  const client = useMemo(() => {
    if (providedClient !== undefined) return providedClient;
    return createSseClient({
      apiBaseUrl,
      cursorStore: createSseCursorStore(apiBaseUrl, storage ?? window.localStorage),
      acceptEvent: async (event) => {
        await Promise.all(invalidationKeysForEvent(event).map(async (queryKey) => {
          await queryClient.invalidateQueries(
            { queryKey, exact: true },
            { throwOnError: true },
          );
        }));
      },
      resync: async () => {
        await queryClient.invalidateQueries(
          { type: 'active', refetchType: 'active' },
          { throwOnError: true },
        );
      },
      ...(fetchFn === undefined ? {} : { fetchFn }),
      isOnline: () => window.navigator.onLine,
    });
  }, [apiBaseUrl, fetchFn, providedClient, queryClient, storage]);

  useEffect(() => {
    void client.start();
    const online = (): void => { client.setOnline(true); };
    const offline = (): void => { client.setOnline(false); };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return (): void => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      client.stop();
    };
  }, [client]);

  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}
