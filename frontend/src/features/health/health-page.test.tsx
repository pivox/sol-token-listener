import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { health, success } from '../../../tests/fixtures/api.js';
import type { ApiClient } from '../../data/api-client.js';
import { apiHealthEnvelopeSchema } from '../../data/api-schemas.js';
import { ApiClientProvider } from '../../data/api-provider.js';
import { HealthPage } from './health-page.js';

const degraded = apiHealthEnvelopeSchema.parse(success({
  ...health,
  internalRpcUrl: 'https://secret-rpc.invalid/key',
  stack: 'database password leaked',
})).data;

describe('technical health page', () => {
  it('renders bounded public health and supports manual refresh without leaking additive internals', async () => {
    const user = userEvent.setup();
    const getHealth = vi.fn<ApiClient['getHealth']>().mockResolvedValue(degraded);
    const unavailable = async (): Promise<never> => { throw new Error('not used'); };
    const apiClient: ApiClient = {
      listLaunches: unavailable,
      getLaunch: unavailable,
      listLaunchEvents: unavailable,
      getLaunchRisk: unavailable,
      getLaunchSocial: unavailable,
      getLaunchHolders: unavailable,
      listPaperPositions: unavailable,
      getHealth,
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><ApiClientProvider client={apiClient}><HealthPage /></ApiClientProvider></QueryClientProvider>);
    expect(await screen.findByRole('heading', { name: 'Santé technique' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('DEGRADED');
    expect(screen.getByText('QUOTE_UNAVAILABLE')).toBeVisible();
    expect(screen.getByLabelText('Pump.fun : RUNNING')).toBeVisible();
    expect(screen.getByLabelText('Paper decision : DEGRADED')).toBeVisible();
    expect(screen.getByLabelText('Qualification : RUNNING')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Qualification' })).toBeVisible();
    expect(screen.getByText('Rapports courants : 2')).toBeVisible();
    expect(screen.getByText('Indisponible')).toBeVisible();
    expect(screen.getByText(/Backlog : 1/)).toBeVisible();
    expect(document.body).not.toHaveTextContent('secret-rpc');
    expect(document.body).not.toHaveTextContent('database password');
    await user.click(screen.getByRole('button', { name: 'Actualiser' }));
    expect(getHealth).toHaveBeenCalledTimes(2);
  });
});
