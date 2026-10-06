import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../data/api-client.js';
import { apiHealthEnvelopeSchema } from '../data/api-schemas.js';
import type { RealtimeSnapshot, SseClient } from '../data/sse-client.js';
import { health, success } from '../../tests/fixtures/api.js';
import { App } from './app.js';

function fakeRealtimeClient(state: RealtimeSnapshot['state'] = 'LIVE'): SseClient {
  const snapshot: RealtimeSnapshot = { state, lastEventAt: null, retryAttempt: 0, errorCode: null };
  return {
    start: vi.fn(async () => undefined), stop: vi.fn(), reconnectNow: vi.fn(), setOnline: vi.fn(),
    getSnapshot: () => snapshot, subscribe: () => () => undefined,
  };
}

function fakeApiClient(): ApiClient {
  const unavailable = async (): Promise<never> => { throw new Error('not used'); };
  const healthProjection = apiHealthEnvelopeSchema.parse(success(health)).data;
  return {
    listLaunches: async () => ({ items: [], nextCursor: null }),
    getLaunch: unavailable,
    listLaunchEvents: unavailable,
    getLaunchRisk: unavailable,
    listPaperPositions: async () => ({ items: [], nextCursor: null }),
    getHealth: async () => healthProjection,
  };
}

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('read-only operator shell', () => {
  it('navigates between public views and keeps the safety/status labels visible', async () => {
    const user = userEvent.setup();
    render(<App apiBaseUrl="https://api.example" realtimeClient={fakeRealtimeClient()} apiClient={fakeApiClient()} />);
    expect(screen.getByText('Simulation uniquement')).toBeVisible();
    expect(screen.getByText(/Temps réel : connecté/i)).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Radar des lancements' })).toBeVisible();

    await user.click(screen.getByRole('link', { name: 'Positions paper' }));
    expect(await screen.findByRole('heading', { name: 'Positions paper' })).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Santé' }));
    expect(await screen.findByRole('heading', { name: 'Santé technique' })).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Radar' }));
    expect(screen.getByRole('heading', { name: 'Radar des lancements' })).toBeVisible();
  });

  it('adds a Live link whose page swaps the simulation badge for the read-only live badge', async () => {
    const user = userEvent.setup();
    render(<App apiBaseUrl="https://api.example" realtimeClient={fakeRealtimeClient()} apiClient={fakeApiClient()} />);
    const links = screen.getAllByRole('link').map((link) => link.textContent);
    expect(links.indexOf('Live')).toBe(links.indexOf('Radar') + 1);
    expect(links.indexOf('Positions paper')).toBe(links.indexOf('Live') + 1);
    expect(screen.getByText('Simulation uniquement')).toBeVisible();
    expect(screen.queryByText('Live · lecture seule')).toBeNull();

    await user.click(screen.getByRole('link', { name: 'Live' }));

    expect(await screen.findByText('Surface opérateur non configurée')).toBeVisible();
    expect(screen.getByText('Live · lecture seule')).toBeVisible();
    expect(screen.queryByText('Simulation uniquement')).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Radar' }));
    expect(screen.getByText('Simulation uniquement')).toBeVisible();
  });

  it('renders a useful not-found route', () => {
    window.history.replaceState({}, '', '/unknown');
    render(<App apiBaseUrl="https://api.example" realtimeClient={fakeRealtimeClient('DISCONNECTED')} apiClient={fakeApiClient()} />);
    expect(screen.getByRole('heading', { name: 'Page introuvable' })).toBeVisible();
    expect(screen.getByText(/Temps réel : déconnecté/i)).toBeVisible();
  });
});
