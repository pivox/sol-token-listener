import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { firstProcessingCanary, health, success } from '../../../tests/fixtures/api.js';
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
  it('renders fixed first-processing evidence, overflow and completed drain without identifiers', async () => {
    renderHealth(apiHealthEnvelopeSchema.parse(success({
      ...health,
      heartbeat: {
        ...health.heartbeat,
        signature: 'secret-signature',
        mint: 'secret-mint',
        firstProcessingCanary,
      },
    })).data);

    const card = (await screen.findByRole('heading', { name: 'Premier traitement' })).closest('section');
    const diagnostic = within(card!);
    const verdict = diagnostic.getByText('PASS');
    expect(verdict.tagName).toBe('STRONG');
    expect(verdict.closest('p')).toHaveTextContent('Verdict : PASS');
    expect(diagnostic.getByText('p95 : 44999 ms')).toBeVisible();
    expect(diagnostic.getByText('Sous 45 s : 3 ; à partir de 45 s : 0')).toBeVisible();
    expect(diagnostic.getByText('Éligibles : 3 ; terminés : 3 ; en attente : 0')).toBeVisible();
    expect(diagnostic.getByText('Censure droite : 0 ; censure de queue : 0')).toBeVisible();
    expect(diagnostic.getByText('Terminaux : 0 ; indisponibles : 0 ; durées invalides : 0')).toBeVisible();
    expect(diagnostic.getByText('Overflow : Non')).toBeVisible();
    expect(diagnostic.getByText('Drain : Terminé')).toBeVisible();
    expect(document.body).not.toHaveTextContent('secret-signature');
    expect(document.body).not.toHaveTextContent('secret-mint');
  });

  it.each([
    [undefined, 'Non disponible — backend antérieur'],
    [null, 'Non disponible — heartbeat antérieur ou invalide'],
  ] as const)('renders the explicit first-processing unavailable state for %s', async (value, message) => {
    const heartbeat: Record<string, unknown> = {
      ...health.heartbeat,
      firstProcessingCanary: value,
    };
    if (value === undefined) delete heartbeat.firstProcessingCanary;
    renderHealth(apiHealthEnvelopeSchema.parse(success({ ...health, heartbeat })).data);

    const card = (await screen.findByRole('heading', { name: 'Premier traitement' })).closest('section');
    expect(within(card!).getByText(message)).toBeVisible();
  });

  it('renders bounded RPC HTTP evidence without endpoint information', async () => {
    const rpcHttpEvidence = {
      version: 1,
      overflowed: true,
      providers: [
        { providerId: 'primary', configured: true, attempts: 3, http429Responses: 1 },
        { providerId: 'fallback-1', configured: true, attempts: 1, http429Responses: 0 },
        { providerId: 'fallback-2', configured: false, attempts: 0, http429Responses: 0 },
        { providerId: 'fallback-3', configured: false, attempts: 0, http429Responses: 0 },
      ],
    };
    renderHealth(apiHealthEnvelopeSchema.parse(success({
      ...health,
      heartbeat: { ...health.heartbeat, rpcHttpEvidence },
    })).data);
    const card = (await screen.findByRole('heading', { name: 'HTTP RPC' })).closest('section');
    const diagnostic = within(card!);
    expect(diagnostic.getByText('Disponible')).toBeVisible();
    expect(diagnostic.getByText('Overflow : Oui')).toBeVisible();
    expect(diagnostic.getByText('primary — configuré : Oui ; tentatives : 3 ; 429 : 1')).toBeVisible();
    expect(diagnostic.getByText('fallback-1 — configuré : Oui ; tentatives : 1 ; 429 : 0')).toBeVisible();
    expect(diagnostic.getByText('fallback-2 — configuré : Non ; tentatives : 0 ; 429 : 0')).toBeVisible();
    expect(diagnostic.getByText('fallback-3 — configuré : Non ; tentatives : 0 ; 429 : 0')).toBeVisible();
    expect(document.body).not.toHaveTextContent('https://');
    expect(document.body).not.toHaveTextContent('signature');
    expect(document.body).not.toHaveTextContent('mint');
  });

  it('strictly rejects malformed RPC HTTP evidence while accepting an explicit null', () => {
    const valid = success({ ...health, heartbeat: { ...health.heartbeat, rpcHttpEvidence: null } });
    expect(apiHealthEnvelopeSchema.safeParse(valid).success).toBe(true);
    const malformed = success({
      ...health,
      heartbeat: {
        ...health.heartbeat,
        rpcHttpEvidence: {
          version: 1, overflowed: false,
          providers: [
            { providerId: 'fallback-1', configured: true, attempts: 1, http429Responses: 0 },
            { providerId: 'primary', configured: true, attempts: 1, http429Responses: 0 },
            { providerId: 'fallback-2', configured: false, attempts: 0, http429Responses: 0 },
            { providerId: 'fallback-3', configured: false, attempts: 0, http429Responses: 0 },
          ],
        },
      },
    });
    expect(apiHealthEnvelopeSchema.safeParse(malformed).success).toBe(false);
  });

  it('renders catch-up admission states and every disjoint count', async () => {
    renderHealth(apiHealthEnvelopeSchema.parse(success({
      ...health,
      heartbeat: {
        ...health.heartbeat, backlogCount: 6,
        catchUpAdmission: {
          version: 1, enabled: true, providerId: 'fallback-2', scanActive: true, workerClaimReady: false,
          actionableBacklogBySource: { websocketOnly: 1, catchUpOnly: 2, websocketAndCatchUp: 3 },
          actionableBacklogByPriority: { normal: 3, launchCandidate: 2, trackedTrade: 1 },
          deferredCount: 4, ignoredCount: 5, quarantinedCount: 6,
        },
      },
    })).data);
    const card = (await screen.findByRole('heading', { name: 'Admission catch-up' })).closest('section');
    const diagnostic = within(card!);
    for (const text of [
      'Activé', 'Fournisseur : fallback-2', 'Scan actif : Oui', 'Worker prêt à réclamer : Non',
      'WebSocket seul : 1 ; catch-up seul : 2 ; WebSocket et catch-up : 3',
      'Normale : 3 ; lancement candidat : 2 ; trade suivi : 1',
      'Différés : 4 ; ignorés : 5 ; en quarantaine : 6',
    ]) expect(diagnostic.getByText(text)).toBeVisible();
  });

  it.each([undefined, null])('does not infer catch-up admission from enabled block hydration (%s)', async (catchUpAdmission) => {
    renderHealth(apiHealthEnvelopeSchema.parse(success({
      ...health, heartbeat: { ...health.heartbeat, catchUpAdmission },
    })).data);
    const card = (await screen.findByRole('heading', { name: 'Admission catch-up' })).closest('section');
    expect(within(card!).getByText('Non activé')).toBeVisible();
    expect(within(card!).queryByText(/Fournisseur/)).not.toBeInTheDocument();
  });

  it('renders disabled catch-up admission and unavailable provider without inferring readiness', async () => {
    renderHealth(apiHealthEnvelopeSchema.parse(success({
      ...health,
      heartbeat: {
        ...health.heartbeat, backlogCount: 0,
        catchUpAdmission: {
          version: 1, enabled: false, providerId: null, scanActive: false, workerClaimReady: false,
          actionableBacklogBySource: { websocketOnly: 0, catchUpOnly: 0, websocketAndCatchUp: 0 },
          actionableBacklogByPriority: { normal: 0, launchCandidate: 0, trackedTrade: 0 },
          deferredCount: 0, ignoredCount: 0, quarantinedCount: 0,
        },
      },
    })).data);
    const card = (await screen.findByRole('heading', { name: 'Admission catch-up' })).closest('section');
    const diagnostic = within(card!);
    expect(diagnostic.getByText('Non activé')).toBeVisible();
    expect(diagnostic.getByText('Fournisseur : Indisponible')).toBeVisible();
    expect(diagnostic.getByText('Scan actif : Non')).toBeVisible();
    expect(diagnostic.getByText('Worker prêt à réclamer : Non')).toBeVisible();
  });

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
    const hydration = screen.getByRole('heading', { name: 'Hydratation des blocs' }).closest('section');
    expect(hydration).not.toBeNull();
    expect(within(hydration!).getByText(/Activée/)).toBeVisible();
    expect(within(hydration!).getByText(/Hits : 6 ; misses : 4/)).toBeVisible();
    expect(within(hydration!).getByText(/Queue : 1/)).toBeVisible();
    const websocketHeading = screen.getByRole('heading', { name: 'WebSocket Solana' });
    const websocketCard = websocketHeading.closest('section');
    expect(websocketCard).not.toBeNull();
    const diagnostic = within(websocketCard!);
    expect(diagnostic.getByText(/État public : DEGRADED/)).toBeVisible();
    expect(diagnostic.getByText(/Phase détaillée : RECOVERING/)).toBeVisible();
    expect(diagnostic.getByText(/Fournisseur actif : primary/)).toBeVisible();
    expect(diagnostic.getByText(/Fournisseur candidat : fallback-1/)).toBeVisible();
    expect(diagnostic.getByText(/Mis à jour :/).querySelector('time')).toHaveAttribute(
      'datetime', health.heartbeat.websocket.updatedAt,
    );
    expect(diagnostic.getByText(/Heartbeat WebSocket :/).querySelector('time')).toHaveAttribute(
      'datetime', health.heartbeat.websocket.heartbeatAt,
    );
    expect(diagnostic.getByText(/^ACK :/).querySelector('time')).toHaveAttribute(
      'datetime', health.heartbeat.websocket.acknowledgedAt,
    );
    const watermark = diagnostic.getByText(/Watermark diagnostic — pas une preuve de continuité/);
    expect(watermark.querySelector('time')).toHaveAttribute(
      'datetime', health.heartbeat.websocket.lastObservation.observedAt,
    );
    const slot = within(watermark).getByText(health.heartbeat.websocket.lastObservation.slot);
    expect(slot).toHaveClass('text-break');
    expect(slot.tagName).toBe('CODE');
    expect(slot).toHaveTextContent(health.heartbeat.websocket.lastObservation.slot);
    const disconnect = diagnostic.getByText(/Déconnexion : REMOTE_CLOSE/);
    expect(disconnect.querySelector('time')).toHaveAttribute(
      'datetime', health.heartbeat.websocket.disconnect.occurredAt,
    );
    expect(diagnostic.getByText(/Récupération : IN_PROGRESS/)).toBeVisible();
    expect(diagnostic.getByText(/Motif de récupération : SESSION_FAILURE/)).toBeVisible();
    expect(diagnostic.getByText(/Début de récupération :/).querySelector('time')).toHaveAttribute(
      'datetime', health.heartbeat.websocket.recovery.startedAt,
    );
    const recoveryCompleted = diagnostic.getByText(/Fin de récupération :/);
    expect(recoveryCompleted).toHaveTextContent('Indisponible');
    expect(recoveryCompleted.querySelector('time')).toBeNull();
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
    delete legacyHeartbeat.blockHydration;
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
