import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { paperPosition, success } from '../../../tests/fixtures/api.js';
import type { ApiClient } from '../../data/api-client.js';
import { apiPaperPositionListEnvelopeSchema } from '../../data/api-schemas.js';
import { ApiClientProvider } from '../../data/api-provider.js';
import { PaperPage } from './paper-page.js';

const position = apiPaperPositionListEnvelopeSchema.parse(success([paperPosition])).data[0]!;

function renderPage(listPaperPositions: ApiClient['listPaperPositions']): void {
  const apiClient = { listPaperPositions } as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><ApiClientProvider client={apiClient}><MemoryRouter><PaperPage /></MemoryRouter></ApiClientProvider></QueryClientProvider>);
}

describe('paper positions page', () => {
  it('shows estimated lineage, costs, progress and signed PnL without trading actions', async () => {
    const user = userEvent.setup();
    renderPage(vi.fn<ApiClient['listPaperPositions']>().mockResolvedValue({ items: [position], nextCursor: null }));
    expect(await screen.findByRole('heading', { name: 'Positions paper' })).toBeVisible();
    expect(screen.getByText('Simulation uniquement')).toBeVisible();
    expect(screen.getByText('PAPER_CLOSED')).toBeVisible();
    expect(screen.getByText('PUMP_FUN_BONDING_CURVE')).toBeVisible();
    expect(screen.getByLabelText('PnL net estimé : +19 000 000')).toBeVisible();
    expect(screen.getByText('10 / 10')).toBeVisible();
    await user.click(screen.getByText('Traçabilité de la décision'));
    expect(screen.getByText(position.candidateId!)).toBeVisible();
    for (const button of screen.queryAllByRole('button')) {
      expect(button).not.toHaveAccessibleName(/buy|sell|acheter|vendre/i);
    }
  });

  it('loads another opaque page and renders retracted/missing exits explicitly', async () => {
    const user = userEvent.setup();
    const retracted = { ...position, id: 'position-b', status: 'PAPER_RETRACTED' as const, exitQuoteAmount: null, realizedPnlQuote: null };
    const list = vi.fn<ApiClient['listPaperPositions']>()
      .mockResolvedValueOnce({ items: [position], nextCursor: 'paper-next' })
      .mockResolvedValueOnce({ items: [retracted], nextCursor: null });
    renderPage(list);
    await screen.findByText('PAPER_CLOSED');
    await user.click(screen.getByRole('button', { name: 'Charger plus' }));
    expect(await screen.findByText('PAPER_RETRACTED')).toBeVisible();
    expect(screen.getAllByText('Indisponible').length).toBeGreaterThan(0);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'paper-next' }));
  });
});
