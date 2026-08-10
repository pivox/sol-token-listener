import { useInfiniteQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState, LoadingState } from '../../components/async-state.js';
import { Timestamp } from '../../components/format.js';
import { timelineInfiniteQuery } from '../../data/queries.js';
import { useApiClient } from '../../data/use-api-client.js';

export function TimelinePanel({ mint }: { readonly mint: string }): ReactNode {
  const query = useInfiniteQuery(timelineInfiniteQuery(useApiClient(), mint));
  if (query.isPending) return <LoadingState label="Chargement de la timeline…" />;
  if (query.isError) return <ErrorState>Timeline indisponible.</ErrorState>;
  const events = query.data.pages.flatMap((page) => page.items);
  if (events.length === 0) return <EmptyState>Aucun événement conservé.</EmptyState>;
  return (
    <section aria-labelledby="timeline-title">
      <h2 className="h5" id="timeline-title">Timeline métier</h2>
      <ol className="list-group list-group-numbered mb-3">{events.map((event) => (
        <li className={`list-group-item${event.confirmationStatus === 'orphaned' ? ' list-group-item-warning' : ''}`} key={event.id}>
          <div className="d-flex justify-content-between gap-2"><strong>{event.type}</strong><Timestamp value={event.occurredAt} /></div>
          <span className="badge text-bg-secondary">{event.confirmationStatus}</span>
          <details className="mt-2"><summary>Données diagnostiques</summary><pre className="small mb-0">{JSON.stringify(event.payload, null, 2)}</pre></details>
        </li>
      ))}</ol>
      {query.hasNextPage && <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => { void query.fetchNextPage(); }}>Charger plus</button>}
    </section>
  );
}
