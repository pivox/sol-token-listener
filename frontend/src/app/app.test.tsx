import { screen, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../data/api-client.js';
import type { RealtimeSnapshot, SseClient } from '../data/sse-client.js';
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
  return {
    listLaunches: async () => ({ items: [], nextCursor: null }),
    getLaunch: unavailable,
    listLaunchEvents: unavailable,
    getLaunchRisk: unavailable,
    getLaunchSocial: unavailable,
    getLaunchHolders: unavailable,
    listPaperPositions: unavailable,
    getHealth: unavailable,
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
    expect(screen.getByRole('heading', { name: 'Positions paper' })).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Santé' }));
    expect(screen.getByRole('heading', { name: 'Santé technique' })).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Radar' }));
    expect(screen.getByRole('heading', { name: 'Radar des lancements' })).toBeVisible();
  });

  it('renders a useful not-found route', () => {
    window.history.replaceState({}, '', '/unknown');
    render(<App apiBaseUrl="https://api.example" realtimeClient={fakeRealtimeClient('DISCONNECTED')} apiClient={fakeApiClient()} />);
    expect(screen.getByRole('heading', { name: 'Page introuvable' })).toBeVisible();
    expect(screen.getByText(/Temps réel : déconnecté/i)).toBeVisible();
  });
});
