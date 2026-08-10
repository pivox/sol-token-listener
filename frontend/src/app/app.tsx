import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { RealtimeProvider } from '../data/realtime-provider.js';
import type { SseClient } from '../data/sse-client.js';
import { AppShell } from './app-shell.js';
import { ErrorBoundary } from './error-boundary.js';

export interface AppProps {
  readonly apiBaseUrl: string;
  readonly realtimeClient?: SseClient;
}

export function App({ apiBaseUrl, realtimeClient }: AppProps): ReactNode {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, gcTime: 5 * 60_000 } },
  }));
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider apiBaseUrl={apiBaseUrl} {...(realtimeClient === undefined ? {} : { client: realtimeClient })}>
          <BrowserRouter>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<PlaceholderPage title="Radar des lancements" />} />
                <Route path="launches/:mint" element={<PlaceholderPage title="Fiche du lancement" />} />
                <Route path="paper-positions" element={<PlaceholderPage title="Positions paper" />} />
                <Route path="health" element={<PlaceholderPage title="Santé technique" />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </RealtimeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

function PlaceholderPage({ title }: { readonly title: string }): ReactNode {
  return (
    <section className="card shadow-sm">
      <div className="card-body">
        <h1 className="h3">{title}</h1>
        <p className="text-secondary mb-0">Cette vue publique en lecture seule sera alimentée par l’API v1.</p>
      </div>
    </section>
  );
}

function NotFoundPage(): ReactNode {
  return (
    <section className="card shadow-sm">
      <div className="card-body">
        <h1 className="h3">Page introuvable</h1>
        <Link to="/">Retour au radar</Link>
      </div>
    </section>
  );
}
