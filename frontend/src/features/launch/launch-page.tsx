import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ErrorState, LoadingState } from '../../components/async-state.js';
import { ApiHttpError } from '../../data/api-errors.js';
import { launchQuery } from '../../data/queries.js';
import { useApiClient } from '../../data/use-api-client.js';
import { HoldersPanel } from './holders-panel.js';
import { OverviewPanel } from './overview-panel.js';
import { RiskPanel } from './risk-panel.js';
import { SocialPanel } from './social-panel.js';
import { TimelinePanel } from './timeline-panel.js';

const mintPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const tabs = ['overview', 'timeline', 'risk', 'social', 'holders'] as const;
type Tab = (typeof tabs)[number];
const labels: Readonly<Record<Tab, string>> = {
  overview: 'Aperçu', timeline: 'Timeline', risk: 'Risque', social: 'Social', holders: 'Détenteurs',
};

export function LaunchPage(): ReactNode {
  const mint = useParams().mint ?? '';
  const validMint = mintPattern.test(mint);
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const activeTab: Tab = tabs.includes(requestedTab as Tab) ? requestedTab as Tab : 'overview';
  const query = useQuery({ ...launchQuery(useApiClient(), mint), enabled: validMint });
  if (!validMint) return <ErrorState>Mint invalide : aucune requête n’a été envoyée.</ErrorState>;
  if (query.isPending) return <LoadingState label="Chargement du lancement…" />;
  if (query.isError) {
    if (query.error instanceof ApiHttpError && query.error.status === 404) return <ErrorState>Lancement introuvable.</ErrorState>;
    return <ErrorState>Fiche du lancement indisponible.</ErrorState>;
  }
  const launch = query.data;
  return (
    <article>
      <header className="mb-3">
        <h1 className="h3 mb-1">{launch.name ?? 'Sans nom'} {launch.symbol === null ? '' : `(${launch.symbol})`}</h1>
        <span className="badge text-bg-secondary">{launch.status}</span>
      </header>
      <nav className="nav nav-tabs mb-3" role="tablist" aria-label="Sections du lancement">
        {tabs.map((tab) => <button key={tab} type="button" role="tab" aria-selected={tab === activeTab} className={`nav-link${tab === activeTab ? ' active' : ''}`} onClick={() => { setSearchParams(tab === 'overview' ? {} : { tab }); }}>{labels[tab]}</button>)}
      </nav>
      {activeTab === 'overview' && <OverviewPanel launch={launch} />}
      {activeTab === 'timeline' && <TimelinePanel mint={mint} />}
      {activeTab === 'risk' && <RiskPanel mint={mint} />}
      {activeTab === 'social' && <SocialPanel mint={mint} />}
      {activeTab === 'holders' && <HoldersPanel mint={mint} />}
    </article>
  );
}
