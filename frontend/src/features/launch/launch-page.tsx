import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ErrorState, LoadingState } from '../../components/async-state.js';
import { ApiHttpError } from '../../data/api-errors.js';
import { launchQuery } from '../../data/queries.js';
import { useApiClient } from '../../data/use-api-client.js';
import { isSolanaPublicKey } from '../../data/solana-address.js';
import { HoldersPanel } from './holders-panel.js';
import { OverviewPanel } from './overview-panel.js';
import { RiskPanel } from './risk-panel.js';
import { SocialPanel } from './social-panel.js';
import { TimelinePanel } from './timeline-panel.js';

const tabs = ['overview', 'timeline', 'risk', 'social', 'holders'] as const;
type Tab = (typeof tabs)[number];
const labels: Readonly<Record<Tab, string>> = {
  overview: 'Aperçu', timeline: 'Timeline', risk: 'Risque', social: 'Social', holders: 'Détenteurs',
};

export function LaunchPage(): ReactNode {
  const mint = useParams().mint ?? '';
  const validMint = isSolanaPublicKey(mint);
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
  const selectTab = (tab: Tab): void => {
    setSearchParams(tab === 'overview' ? {} : { tab });
  };
  const moveTab = (event: React.KeyboardEvent<HTMLButtonElement>, tab: Tab): void => {
    const current = tabs.indexOf(tab);
    const target = event.key === 'ArrowRight' ? tabs[(current + 1) % tabs.length]
      : event.key === 'ArrowLeft' ? tabs[(current - 1 + tabs.length) % tabs.length]
        : event.key === 'Home' ? tabs[0]
          : event.key === 'End' ? tabs[tabs.length - 1]
            : undefined;
    if (target === undefined) return;
    event.preventDefault();
    selectTab(target);
    document.getElementById(`launch-tab-${target}`)?.focus();
  };
  return (
    <article>
      <header className="mb-3">
        <h1 className="h3 mb-1">{launch.name ?? 'Sans nom'} {launch.symbol === null ? '' : `(${launch.symbol})`}</h1>
        <span className="badge text-bg-secondary">{launch.status}</span>
      </header>
      <nav className="nav nav-tabs mb-3" role="tablist" aria-label="Sections du lancement">
        {tabs.map((tab) => <button key={tab} id={`launch-tab-${tab}`} type="button" role="tab" aria-selected={tab === activeTab} aria-controls={`launch-panel-${tab}`} tabIndex={tab === activeTab ? 0 : -1} className={`nav-link${tab === activeTab ? ' active' : ''}`} onClick={() => { selectTab(tab); }} onKeyDown={(event) => { moveTab(event, tab); }}>{labels[tab]}</button>)}
      </nav>
      <section id={`launch-panel-${activeTab}`} role="tabpanel" aria-labelledby={`launch-tab-${activeTab}`} tabIndex={0}>
        {activeTab === 'overview' && <OverviewPanel launch={launch} />}
        {activeTab === 'timeline' && <TimelinePanel mint={mint} />}
        {activeTab === 'risk' && <RiskPanel mint={mint} />}
        {activeTab === 'social' && <SocialPanel mint={mint} />}
        {activeTab === 'holders' && <HoldersPanel mint={mint} />}
      </section>
    </article>
  );
}
