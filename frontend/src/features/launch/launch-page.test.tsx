import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  holdersAvailable,
  launchDetail,
  qualification,
  socialUnavailable,
  success,
  timelineEntry,
} from '../../../tests/fixtures/api.js';
import type { ApiClient } from '../../data/api-client.js';
import {
  apiHoldersEnvelopeSchema,
  apiLaunchDetailEnvelopeSchema,
  apiQualificationEnvelopeSchema,
  apiSocialEnvelopeSchema,
  apiTimelineEnvelopeSchema,
} from '../../data/api-schemas.js';
import { ApiClientProvider } from '../../data/api-provider.js';
import { LaunchPage } from './launch-page.js';

const detail = apiLaunchDetailEnvelopeSchema.parse(success(launchDetail)).data;
const risk = apiQualificationEnvelopeSchema.parse(success(qualification)).data;
const socialMissing = apiSocialEnvelopeSchema.parse(success(socialUnavailable)).data;
const holders = apiHoldersEnvelopeSchema.parse(success(holdersAvailable)).data;
const orphanedEvent = apiTimelineEnvelopeSchema.parse(success([{
  ...timelineEntry,
  confirmationStatus: 'orphaned',
  payload: { diagnostic: '<script>alert(1)</script>' },
}])).data[0]!;

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  const unavailable = async (): Promise<never> => { throw new Error('not configured'); };
  return {
    listLaunches: unavailable,
    getLaunch: async () => detail,
    listLaunchEvents: async () => ({ items: [orphanedEvent], nextCursor: null }),
    getLaunchRisk: async () => risk,
    getLaunchSocial: async () => socialMissing,
    getLaunchHolders: async () => holders,
    listPaperPositions: unavailable,
    getHealth: unavailable,
    ...overrides,
  };
}

function renderPage(apiClient: ApiClient, entry: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes><Route path="/launches/:mint" element={<LaunchPage />} /></Routes>
        </MemoryRouter>
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe('launch detail route', () => {
  it('rejects a malformed mint before network access', () => {
    const getLaunch = vi.fn<ApiClient['getLaunch']>();
    renderPage(client({ getLaunch }), '/launches/not-a-mint');
    expect(screen.getByRole('alert')).toHaveTextContent(/mint invalide/i);
    expect(getLaunch).not.toHaveBeenCalled();
  });

  it('renders overview and shareable risk tab with blockers before scores', async () => {
    const user = userEvent.setup();
    renderPage(client(), `/launches/${detail.mint}`);
    expect(await screen.findByRole('heading', { name: /Synthetic token/i })).toBeVisible();
    expect(screen.getByText(/OBSERVED_BONDING_CURVE_TRADES/)).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Risque' }));
    const blocker = await screen.findByRole('alert', { name: /condition éliminatoire/i });
    const score = screen.getByText('72 / 100');
    expect(blocker.compareDocumentPosition(score) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('12 / 15')).toBeVisible();
    expect(screen.getByText('17 / 25')).toBeVisible();
  });

  it('renders unavailable social evidence, observed holder methodology, and escaped orphan diagnostics', async () => {
    const user = userEvent.setup();
    renderPage(client(), `/launches/${detail.mint}?tab=social`);
    expect(await screen.findByText('Preuves sociales indisponibles')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Détenteurs' }));
    expect(await screen.findByText(/données observées sur la bonding curve/i)).toBeVisible();
    expect(screen.getByLabelText('Acheteurs externes uniques : 8')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(await screen.findByText('orphaned')).toBeVisible();
    const diagnostic = screen.getByText(/<script>alert/);
    expect(diagnostic.tagName).toBe('PRE');
    expect(document.querySelector('script')).toBeNull();
  });
});
