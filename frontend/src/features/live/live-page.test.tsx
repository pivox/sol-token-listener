import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveOverview, SIGNATURE, success } from '../../../tests/fixtures/api.js';
import { ApiHttpError } from '../../data/api-errors.js';
import type { OperatorClient } from '../../data/operator-client.js';
import { operatorLiveOverviewEnvelopeSchema } from '../../data/operator-schemas.js';
import { LivePage } from './live-page.js';
import type { LivePageProps } from './live-page.js';

const overview = operatorLiveOverviewEnvelopeSchema.parse(success(liveOverview)).data;

afterEach(() => {
  window.sessionStorage.clear();
});

function renderPage(
  getLiveOverview: OperatorClient['getLiveOverview'],
  operatorApiBaseUrl: string | null = 'http://127.0.0.1:3100',
): ReturnType<typeof vi.fn> {
  const createClient = vi.fn<NonNullable<LivePageProps['createClient']>>(() => ({ getLiveOverview }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><LivePage operatorApiBaseUrl={operatorApiBaseUrl} createClient={createClient} /></MemoryRouter>
    </QueryClientProvider>,
  );
  return createClient;
}

async function enterToken(token = 'secret-token'): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Jeton opérateur'), token);
  await user.click(screen.getByRole('button', { name: 'Valider' }));
}

describe('live page', () => {
  it('explains that the operator surface is not configured', () => {
    renderPage(vi.fn(), null);
    expect(screen.getByText('Surface opérateur non configurée')).toBeVisible();
    expect(screen.queryByLabelText('Jeton opérateur')).toBeNull();
  });

  it('asks for the token once, keeps it in sessionStorage and then shows the dashboard', async () => {
    const getLiveOverview = vi.fn<OperatorClient['getLiveOverview']>()
      .mockResolvedValue({ overview, nextCursor: null });
    const createClient = renderPage(getLiveOverview);
    expect(createClient).not.toHaveBeenCalled();

    await enterToken();

    expect(await screen.findByRole('heading', { name: 'Live' })).toBeVisible();
    expect(createClient).toHaveBeenCalledWith('http://127.0.0.1:3100', 'secret-token');
    expect(window.sessionStorage.getItem('operator-api-token')).toBe('secret-token');
  });

  it('shows balance, PnL, the open position with its spot value and the closed history with Solscan links', async () => {
    window.sessionStorage.setItem('operator-api-token', 'secret-token');
    renderPage(vi.fn<OperatorClient['getLiveOverview']>().mockResolvedValue({ overview, nextCursor: null }));

    expect(await screen.findByText('2.500000000 SOL')).toBeVisible();
    // Once as the realized KPI and once in the closed history row.
    expect(screen.getAllByText('-0.000004205 SOL')).toHaveLength(2);
    expect(screen.getAllByText('+0.000195000 SOL').length).toBeGreaterThan(0);
    expect(screen.getByText('indicatif, prix spot')).toBeVisible();
    const openRow = within(screen.getByRole('heading', { name: 'Positions ouvertes' }).parentElement!)
      .getAllByRole('row')[1]!;
    expect(within(openRow).getByText('0.001200000 SOL')).toBeVisible();
    expect(within(openRow).getByText(/\+19\.40%/u)).toBeVisible();
    expect(within(openRow).getByRole('link')).toHaveAttribute('href', `/launches/${overview.open[0]?.mint ?? ''}`);
    const links = screen.getAllByRole('link', { name: /Entrée|Sortie/u });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `https://solscan.io/tx/${SIGNATURE}`, `https://solscan.io/tx/${SIGNATURE}`,
    ]);
    expect(screen.queryByText('Actualisation indisponible', { exact: false })).toBeNull();
  });

  it('forgets a rejected token and prompts again with an error', async () => {
    window.sessionStorage.setItem('operator-api-token', 'wrong-token');
    renderPage(vi.fn<OperatorClient['getLiveOverview']>()
      .mockRejectedValue(new ApiHttpError(401, 'UNAUTHORIZED', 'A valid operator token is required')));

    expect(await screen.findByText('Token refusé')).toBeVisible();
    expect(screen.getByLabelText('Jeton opérateur')).toBeVisible();
    expect(window.sessionStorage.getItem('operator-api-token')).toBeNull();
  });

  it('forgets the token on demand', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem('operator-api-token', 'secret-token');
    renderPage(vi.fn<OperatorClient['getLiveOverview']>().mockResolvedValue({ overview, nextCursor: null }));

    await user.click(await screen.findByRole('button', { name: 'Oublier le token' }));

    expect(screen.getByLabelText('Jeton opérateur')).toBeVisible();
    expect(screen.queryByText('Token refusé')).toBeNull();
    expect(window.sessionStorage.getItem('operator-api-token')).toBeNull();
  });

  it('reports a missing wallet generation', async () => {
    window.sessionStorage.setItem('operator-api-token', 'secret-token');
    const empty = { ...overview, availability: 'NOT_AVAILABLE' as const, wallet: null, balance: null, open: [], history: [] };
    renderPage(vi.fn<OperatorClient['getLiveOverview']>().mockResolvedValue({ overview: empty, nextCursor: null }));

    expect(await screen.findByText('Aucun wallet live actif')).toBeVisible();
  });

  it('keeps the page usable when the balance and a spot price are unknown', async () => {
    window.sessionStorage.setItem('operator-api-token', 'secret-token');
    const open = { ...overview.open[0]!, spotValueLamports: null, unrealizedLamports: null };
    const degraded = {
      ...overview, balance: null, open: [open],
      totals: { ...overview.totals, unrealizedLamports: '0', positionsWithoutPnl: 1 },
    };
    renderPage(vi.fn<OperatorClient['getLiveOverview']>().mockResolvedValue({ overview: degraded, nextCursor: null }));

    expect(await screen.findByText('indisponible')).toBeVisible();
    expect(screen.getAllByText('non disponible')).toHaveLength(2);
    expect(screen.getByText('1 position exclue')).toBeVisible();
  });

  it('loads another history page with the opaque cursor', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem('operator-api-token', 'secret-token');
    const older = {
      ...overview.history[0]!, positionId: 'execution_live_position_older',
      closedAt: '2026-08-10T21:05:00.000Z', realizedLamports: '900',
    };
    const getLiveOverview = vi.fn<OperatorClient['getLiveOverview']>()
      .mockResolvedValueOnce({ overview, nextCursor: 'ledger-next' })
      .mockResolvedValueOnce({ overview: { ...overview, history: [older] }, nextCursor: null })
      .mockResolvedValue({ overview, nextCursor: 'ledger-next' });
    renderPage(getLiveOverview);

    await user.click(await screen.findByRole('button', { name: 'Charger plus' }));

    expect(await screen.findByText('+0.000000900 SOL')).toBeVisible();
    expect(getLiveOverview).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'ledger-next' }));
    expect(screen.queryByRole('button', { name: 'Charger plus' })).toBeNull();
  });
});
