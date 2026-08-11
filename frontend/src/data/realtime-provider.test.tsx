import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRealtimeSnapshot } from './realtime-context.js';
import { RealtimeProvider } from './realtime-provider.js';
import type { RealtimeSnapshot, SseClient } from './sse-client.js';

function Probe(): React.ReactNode {
  const snapshot = useRealtimeSnapshot();
  return <output>{snapshot.state}</output>;
}

function fakeClient(): SseClient & { emit(snapshot: RealtimeSnapshot): void } {
  let snapshot: RealtimeSnapshot = { state: 'STOPPED', lastEventAt: null, retryAttempt: 0, errorCode: null };
  const listeners = new Set<() => void>();
  return {
    start: vi.fn(async () => undefined), stop: vi.fn(), reconnectNow: vi.fn(), setOnline: vi.fn(),
    getSnapshot: () => snapshot,
    subscribe(listener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit(next): void { snapshot = next; for (const listener of listeners) listener(); },
  };
}

describe('single realtime React provider', () => {
  it('starts once, exposes snapshots, forwards connectivity, and stops on unmount', async () => {
    const client = fakeClient();
    const queryClient = new QueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider apiBaseUrl="https://api.example" client={client}><Probe /></RealtimeProvider>
      </QueryClientProvider>,
    );
    expect(client.start).toHaveBeenCalledOnce();
    client.emit({ state: 'LIVE', lastEventAt: null, retryAttempt: 0, errorCode: null });
    expect(await screen.findByText('LIVE')).toBeInTheDocument();
    window.dispatchEvent(new Event('offline'));
    expect(client.setOnline).toHaveBeenCalledWith(false);
    window.dispatchEvent(new Event('online'));
    expect(client.setOnline).toHaveBeenCalledWith(true);
    view.unmount();
    expect(client.stop).toHaveBeenCalledOnce();
  });
});
