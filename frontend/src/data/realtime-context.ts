import { createContext, useContext, useSyncExternalStore } from 'react';
import type { RealtimeSnapshot, SseClient } from './sse-client.js';

export const RealtimeContext = createContext<SseClient | null>(null);

export function useRealtimeSnapshot(): RealtimeSnapshot {
  const client = useContext(RealtimeContext);
  if (client === null) throw new Error('useRealtimeSnapshot must be used inside RealtimeProvider');
  return useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getSnapshot(),
    () => client.getSnapshot(),
  );
}
