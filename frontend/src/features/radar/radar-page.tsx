import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState, LoadingState } from '../../components/async-state.js';
import { launchesInfiniteQuery } from '../../data/queries.js';
import { useApiClient } from '../../data/use-api-client.js';
import { LaunchSummaryPanel } from './launch-summary-panel.js';
import { RadarTable } from './radar-table.js';

export function RadarPage(): ReactNode {
  const client = useApiClient();
  const query = useInfiniteQuery(launchesInfiniteQuery(client));
  const [search, setSearch] = useState('');
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const launches = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('fr');
    if (needle === '') return launches;
    return launches.filter((launch) => [launch.mint, launch.name, launch.symbol, launch.status]
      .some((value) => value?.toLocaleLowerCase('fr').includes(needle) === true));
  }, [launches, search]);

  const effectiveSelectedMint = launches.some((launch) => launch.mint === selectedMint)
    ? selectedMint
    : (launches[0]?.mint ?? null);
  const selected = launches.find((launch) => launch.mint === effectiveSelectedMint) ?? null;
  if (query.isPending) return <LoadingState label="Chargement du radar…" />;
  if (query.isError) return <ErrorState>Le radar est temporairement indisponible.</ErrorState>;

  return (
    <section aria-labelledby="radar-title">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-3">
        <div>
          <h1 className="h3 mb-1" id="radar-title">Radar des lancements</h1>
          <p className="text-secondary small mb-0">Les filtres portent sur les pages de rétention déjà chargées.</p>
        </div>
        <label className="form-label mb-0">
          <span className="visually-hidden">Rechercher un lancement</span>
          <input
            className="form-control form-control-sm"
            type="search"
            aria-label="Rechercher un lancement"
            placeholder="Nom, ticker, mint, statut"
            value={search}
            onChange={(event) => { setSearch(event.target.value); }}
          />
        </label>
      </div>
      {launches.length === 0 ? <EmptyState>Aucun lancement dans la rétention chargée.</EmptyState> : (
        <div className="row g-3">
          <div className="col-12 col-xl-8">
            <div className="card shadow-sm">
              <RadarTable launches={filtered} selectedMint={effectiveSelectedMint} onSelect={setSelectedMint} />
              {filtered.length === 0 && <div className="card-body"><EmptyState>Aucun résultat dans les pages chargées.</EmptyState></div>}
              {query.hasNextPage && (
                <div className="card-footer text-center">
                  <button className="btn btn-outline-secondary btn-sm" type="button" disabled={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage(); }}>
                    {query.isFetchingNextPage ? 'Chargement…' : 'Charger plus'}
                  </button>
                </div>
              )}
            </div>
          </div>
          <aside className="col-12 col-xl-4">
            <div className="card shadow-sm"><div className="card-body"><LaunchSummaryPanel launch={selected} /></div></div>
          </aside>
        </div>
      )}
    </section>
  );
}
