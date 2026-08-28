import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { health, success } from '../../../tests/fixtures/api.js';
import type { ApiClient } from '../../data/api-client.js';
import { apiHealthEnvelopeSchema, type ApiHealth } from '../../data/api-schemas.js';
import { ApiClientProvider } from '../../data/api-provider.js';
import { HealthPage } from './health-page.js';

const degraded = apiHealthEnvelopeSchema.parse(success({
  ...health,
  internalRpcUrl: 'https://secret-rpc.invalid/key',
  stack: 'database password leaked',
  heartbeat: {
    ...health.heartbeat,
    websocket: {
      ...health.heartbeat.websocket,
      rpcUrl: 'https://websocket-secret.invalid/key',
      signature: 'websocket-secret-signature',
      remoteReason: 'remote detail must stay hidden',
      arbitrary: { nested: 'hostile websocket JSON' },
    },
  },
})).data;

function renderHealth(value: ApiHealth): ReturnType<typeof vi.fn<ApiClient['getHealth']>> {
  const getHealth = vi.fn<ApiClient['getHealth']>().mockResolvedValue(value);
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
  return getHealth;
}

describe('technical health page', () => {
  it('renders bounded public health and supports manual refresh without leaking additive internals', async () => {
    const user = userEvent.setup();
    const getHealth = renderHealth(degraded);
    expect(await screen.findByRole('heading', { name: 'Santé technique' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('DEGRADED');
    expect(screen.getByText('QUOTE_UNAVAILABLE')).toBeVisible();
    expect(screen.getByLabelText('Pump.fun : RUNNING')).toBeVisible();
    expect(screen.getByLabelText('Paper decision : DEGRADED')).toBeVisible();
    expect(screen.getByLabelText('Qualification : RUNNING')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Qualification' })).toBeVisible();
    expect(screen.getByText('Rapports courants : 2')).toBeVisible();
    expect(screen.getAllByText('Indisponible')).not.toHaveLength(0);
    expect(screen.getByText(/Backlog : 1/)).toBeVisible();
    const websocketHeading = screen.getByRole('heading', { name: 'WebSocket Solana' });
    const websocketCard = websocketHeading.closest('section');
    expect(websocketCard).not.toBeNull();
    const diagnostic = within(websocketCard!);
    expect(diagnostic.getByText(/État public : DEGRADED/)).toBeVisible();
    expect(diagnostic.getByText(/Phase détaillée : RECOVERING/)).toBeVisible();
    expect(diagnostic.getByText(/Fournisseur actif : primary/)).toBeVisible();
    expect(diagnostic.getByText(/Fournisseur candidat : fallback-1/)).toBeVisible();
    expect(diagnostic.getByText(/Heartbeat WebSocket/)).toBeVisible();
    expect(diagnostic.getByText(/ACK/)).toBeVisible();
    expect(diagnostic.getByText(/Watermark diagnostic — pas une preuve de continuité/)).toHaveTextContent('900719925474099312345');
    expect(diagnostic.getByText(/Déconnexion : REMOTE_CLOSE/)).toBeVisible();
    expect(diagnostic.getByText(/Récupération : IN_PROGRESS/)).toBeVisible();
    expect(diagnostic.getByText(/Motif de récupération : SESSION_FAILURE/)).toBeVisible();
    expect(websocketCard?.querySelectorAll(`time[datetime="${health.observedAt}"]`)).toHaveLength(6);
    expect(document.body).not.toHaveTextContent('secret-rpc');
    expect(document.body).not.toHaveTextContent('database password');
    expect(document.body).not.toHaveTextContent('websocket-secret-signature');
    expect(document.body).not.toHaveTextContent('remote detail must stay hidden');
    expect(document.body).not.toHaveTextContent('hostile websocket JSON');
    await user.click(screen.getByRole('button', { name: 'Actualiser' }));
    expect(getHealth).toHaveBeenCalledTimes(2);
  });

  it('shows a bounded rolling-deployment fallback for an older backend', async () => {
    const legacyHeartbeat: Record<string, unknown> = { ...health.heartbeat };
    delete legacyHeartbeat.websocket;
    legacyHeartbeat.lastSignature = 'legacy-secret-signature';
    const legacy = apiHealthEnvelopeSchema.parse(success({
      ...health,
      heartbeat: legacyHeartbeat,
    })).data;

    renderHealth(legacy);

    const heading = await screen.findByRole('heading', { name: 'WebSocket Solana' });
    const card = heading.closest('section');
    expect(card).not.toBeNull();
    expect(within(card!).getByText('Non disponible — backend antérieur')).toBeVisible();
    expect(document.body).not.toHaveTextContent('legacy-secret-signature');
  });
});
