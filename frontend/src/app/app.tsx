import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { RealtimeProvider } from '../data/realtime-provider.js';
import { createApiClient } from '../data/api-client.js';
import type { ApiClient } from '../data/api-client.js';
import { ApiClientProvider } from '../data/api-provider.js';
import type { SseClient } from '../data/sse-client.js';
import { RadarPage } from '../features/radar/radar-page.js';
import { LaunchPage } from '../features/launch/launch-page.js';
import { PaperPage } from '../features/paper/paper-page.js';
import { HealthPage } from '../features/health/health-page.js';
import { AppShell } from './app-shell.js';
import { ErrorBoundary } from './error-boundary.js';

export interface AppProps {
  readonly apiBaseUrl: string;
  readonly realtimeClient?: SseClient;
  readonly apiClient?: ApiClient;
}

export function App({ apiBaseUrl, realtimeClient, apiClient: providedApiClient }: AppProps): ReactNode {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, gcTime: 5 * 60_000 } },
  }));
  const apiClient = useMemo(() => providedApiClient ?? createApiClient({ apiBaseUrl }), [apiBaseUrl, providedApiClient]);
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider apiBaseUrl={apiBaseUrl} {...(realtimeClient === undefined ? {} : { client: realtimeClient })}>
          <ApiClientProvider client={apiClient}><BrowserRouter>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<RadarPage />} />
                <Route path="launches/:mint" element={<LaunchPage />} />
                <Route path="paper-positions" element={<PaperPage />} />
                <Route path="health" element={<HealthPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </BrowserRouter></ApiClientProvider>
        </RealtimeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
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
