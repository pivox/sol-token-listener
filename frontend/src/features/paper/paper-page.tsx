import { useInfiniteQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState, LoadingState } from '../../components/async-state.js';
import { ShortIdentifier, Timestamp } from '../../components/format.js';
import { formatInteger } from '../../data/decimal.js';
import { paperPositionsInfiniteQuery } from '../../data/queries.js';
import { useApiClient } from '../../data/use-api-client.js';
import type { ApiPaperPosition } from '../../data/api-schemas.js';

export function PaperPage(): ReactNode {
  const query = useInfiniteQuery(paperPositionsInfiniteQuery(useApiClient()));
  if (query.isPending) return <LoadingState label="Chargement des positions simulées…" />;
  if (query.isError) return <ErrorState>Positions paper indisponibles.</ErrorState>;
  const positions = query.data.pages.flatMap((page) => page.items);
  return (
    <section aria-labelledby="paper-title">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <div><h1 className="h3 mb-1" id="paper-title">Positions paper</h1><p className="text-secondary mb-0">PnL, frais et sorties sont des estimations.</p></div>
        <span className="badge text-bg-warning">Simulation uniquement</span>
      </div>
      {positions.length === 0 ? <EmptyState>Aucune position paper conservée.</EmptyState> : (
        <div className="d-grid gap-3">{positions.map((position) => <PositionCard key={position.id} position={position} />)}</div>
      )}
      {query.hasNextPage && <button type="button" className="btn btn-outline-secondary btn-sm mt-3" onClick={() => { void query.fetchNextPage(); }}>Charger plus</button>}
    </section>
  );
}

function PositionCard({ position }: { readonly position: ApiPaperPosition }): ReactNode {
  const pnl = position.realizedPnlQuote === null ? null : formatInteger(position.realizedPnlQuote);
  const signedPnl = pnl === null || pnl.startsWith('-') ? pnl : `+${pnl}`;
  return (
    <article className="card shadow-sm">
      <div className="card-header d-flex flex-wrap justify-content-between gap-2">
        <span><ShortIdentifier value={position.mint} /></span><span className="badge text-bg-secondary">{position.status}</span>
      </div>
      <div className="card-body">
        <dl className="row mb-3">
          <dt className="col-md-4">Venue d’entrée</dt><dd className="col-md-8">{position.entryVenue}</dd>
          <dt className="col-md-4">Ouverte</dt><dd className="col-md-8"><Timestamp value={position.openedAt} /></dd>
          <dt className="col-md-4">Fermée</dt><dd className="col-md-8"><Timestamp value={position.closedAt} /></dd>
          <dt className="col-md-4">Quantité brute</dt><dd className="col-md-8">{formatInteger(position.quantity)}</dd>
          <dt className="col-md-4">Entrée quote brute</dt><dd className="col-md-8">{formatInteger(position.entryQuoteAmount)}</dd>
          <dt className="col-md-4">Sortie quote brute</dt><dd className="col-md-8">{position.exitQuoteAmount === null ? 'Indisponible' : formatInteger(position.exitQuoteAmount)}</dd>
          <dt className="col-md-4">Frais estimés</dt><dd className="col-md-8">{formatInteger(position.estimatedFeesQuote)}</dd>
          <dt className="col-md-4">PnL net estimé</dt><dd className="col-md-8"><strong aria-label={`PnL net estimé : ${signedPnl ?? 'Indisponible'}`}>{signedPnl ?? 'Indisponible'}</strong></dd>
          <dt className="col-md-4">Achats externes observés</dt><dd className="col-md-8">{position.externalBuyCount === null || position.externalBuyTarget === null ? 'Indisponible' : `${String(position.externalBuyCount)} / ${String(position.externalBuyTarget)}`}</dd>
        </dl>
        <details><summary>Traçabilité de la décision</summary>
          <dl className="row small mt-2 mb-0">
            <dt className="col-md-4">Stratégie</dt><dd className="col-md-8">{position.strategyId} v{position.strategyVersion}</dd>
            <dt className="col-md-4">Candidat</dt><dd className="col-md-8">{position.candidateId ?? 'Indisponible'}</dd>
            <dt className="col-md-4">Rapport</dt><dd className="col-md-8">{position.qualificationReportId ?? 'Indisponible'}</dd>
            <dt className="col-md-4">Raisons</dt><dd className="col-md-8">{position.reasonCodes.join(', ') || 'Aucune'}</dd>
          </dl>
        </details>
      </div>
    </article>
  );
}
