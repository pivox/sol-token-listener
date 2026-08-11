import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { launchSummary, success } from '../../../tests/fixtures/api.js';
import type { ApiClient } from '../../data/api-client.js';
import { apiLaunchListEnvelopeSchema } from '../../data/api-schemas.js';
import { ApiClientProvider } from '../../data/api-provider.js';
import { RadarPage } from './radar-page.js';

const parsedLaunchSummary = apiLaunchListEnvelopeSchema.parse(success([launchSummary])).data[0]!;

function renderRadar(listLaunches: ApiClient['listLaunches']) {
  const client = { listLaunches } as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={client}>
        <MemoryRouter><RadarPage /></MemoryRouter>
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe('dense launch radar', () => {
  it('renders blocker before score from the list projection without detail requests', async () => {
    const listLaunches = vi.fn<ApiClient['listLaunches']>().mockResolvedValue({ items: [parsedLaunchSummary], nextCursor: null });
    renderRadar(listLaunches);

    expect(await screen.findByRole('heading', { name: 'Radar des lancements' })).toBeVisible();
    const blocker = screen.getByRole('alert', { name: /condition éliminatoire/i });
    const score = screen.getByText('72 / 100');
    expect(blocker).toBeVisible();
    expect(blocker.compareDocumentPosition(score) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(listLaunches).toHaveBeenCalledTimes(1);
  });

  it('filters only loaded rows and preserves explicit missing qualification', async () => {
    const user = userEvent.setup();
    const second = {
      ...parsedLaunchSummary, mint: '22222222222222222222222222222222', name: 'Other project', symbol: 'OTH',
      qualificationSummary: null, candidate: null, paperStrategy: null,
    };
    renderRadar(vi.fn<ApiClient['listLaunches']>().mockResolvedValue({ items: [parsedLaunchSummary, second], nextCursor: null }));
    await screen.findByRole('button', { name: /Synthetic token/i });
    await user.type(screen.getByRole('searchbox', { name: /rechercher/i }), 'Other');
    expect(screen.queryByRole('button', { name: /Synthetic token/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Other project/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Other project/i }));
    expect(screen.getByText('Qualification indisponible')).toBeVisible();
    expect(screen.getByText(/pages de rétention déjà chargées/i)).toBeVisible();
  });

  it('loads the next opaque page on demand', async () => {
    const user = userEvent.setup();
    const second = { ...parsedLaunchSummary, mint: '22222222222222222222222222222222', name: 'Second token' };
    const listLaunches = vi.fn<ApiClient['listLaunches']>()
      .mockResolvedValueOnce({ items: [parsedLaunchSummary], nextCursor: 'opaque-next' })
      .mockResolvedValueOnce({ items: [second], nextCursor: null });
    renderRadar(listLaunches);
    await screen.findByRole('button', { name: /Synthetic token/i });
    await user.click(screen.getByRole('button', { name: 'Charger plus' }));
    expect(await screen.findByRole('button', { name: /Second token/i })).toBeVisible();
    expect(listLaunches).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'opaque-next' }));
  });
});
