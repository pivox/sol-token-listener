import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingState } from '../../components/async-state.js';
import { ShortIdentifier, Timestamp } from '../../components/format.js';
import { SafeExternalLink } from '../../components/safe-external-link.js';
import { ApiHttpError } from '../../data/api-errors.js';
import { formatInteger } from '../../data/decimal.js';
import { createOperatorClient } from '../../data/operator-client.js';
import type { OperatorClient } from '../../data/operator-client.js';
import type {
  OperatorClosedPosition,
  OperatorLiveOverview,
  OperatorOpenPosition,
} from '../../data/operator-schemas.js';
import { clearOperatorToken, readOperatorToken, saveOperatorToken } from '../../data/operator-token.js';
import { liveOverviewInfiniteQuery } from '../../data/queries.js';
import { queryKeys } from '../../data/query-keys.js';
import { formatPnlPercent, formatSol } from './format-sol.js';
import { TokenPrompt } from './token-prompt.js';

export interface LivePageProps {
  readonly operatorApiBaseUrl: string | null;
  readonly createClient?: (operatorApiBaseUrl: string, token: string) => OperatorClient;
}

function defaultCreateClient(operatorApiBaseUrl: string, token: string): OperatorClient {
  return createOperatorClient({ operatorApiBaseUrl, token });
}

export function LivePage({ operatorApiBaseUrl, createClient = defaultCreateClient }: LivePageProps): ReactNode {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(() => readOperatorToken());
  const [refused, setRefused] = useState(false);
  const forget = useCallback((wasRefused: boolean): void => {
    clearOperatorToken();
    queryClient.removeQueries({ queryKey: queryKeys.liveOverview });
    setToken(null);
    setRefused(wasRefused);
  }, [queryClient]);
  const client = useMemo(
    () => (operatorApiBaseUrl === null || token === null ? null : createClient(operatorApiBaseUrl, token)),
    [createClient, operatorApiBaseUrl, token],
  );

  if (operatorApiBaseUrl === null) return <EmptyState>Surface opérateur non configurée</EmptyState>;
  if (client === null) {
    return (
      <TokenPrompt
        refused={refused}
        onSubmit={(value) => { saveOperatorToken(value); setRefused(false); setToken(value); }}
      />
    );
  }
  return <LiveDashboard client={client} onForget={forget} />;
}

function LiveDashboard({ client, onForget }: {
  readonly client: OperatorClient;
  readonly onForget: (refused: boolean) => void;
}): ReactNode {
  const query = useInfiniteQuery(liveOverviewInfiniteQuery(client));
  const unauthorized = query.error instanceof ApiHttpError && query.error.status === 401;
  useEffect(() => {
    if (unauthorized) onForget(true);
  }, [unauthorized, onForget]);

  if (unauthorized) return null;
  if (query.isPending) return <LoadingState label="Chargement de la surface live…" />;
  const first = query.data?.pages[0];
  if (first === undefined) return <ErrorState>Surface opérateur indisponible.</ErrorState>;
  const { overview } = first;
  const history = query.data?.pages.flatMap((page) => page.overview.history) ?? [];
  return (
    <section aria-labelledby="live-title" className="d-grid gap-3">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2">
        <h1 className="h3 mb-0" id="live-title">Live</h1>
        <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => { onForget(false); }}>
          Oublier le token
        </button>
      </div>
      {query.isError && <ErrorState>Actualisation indisponible : dernières données conservées.</ErrorState>}
      {overview.availability === 'NOT_AVAILABLE' ? <EmptyState>Aucun wallet live actif</EmptyState> : (
        <>
          <KpiRow overview={overview} />
          <OpenPositionsTable positions={overview.open} />
          <HistoryTable positions={history} />
          {query.hasNextPage && (
            <div>
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm"
                disabled={query.isFetchingNextPage}
                onClick={() => { void query.fetchNextPage(); }}
              >
                Charger plus
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function KpiRow({ overview }: { readonly overview: OperatorLiveOverview }): ReactNode {
  const { balance, totals } = overview;
  const excluded = totals.positionsWithoutPnl;
  return (
    <div className="row g-3">
      <Kpi label="Solde du wallet">
        {balance === null ? 'indisponible' : (
          <>{formatSol(balance.lamports)} <small className="text-secondary d-block">observé <Timestamp value={balance.observedAt} /></small></>
        )}
      </Kpi>
      <Kpi label="PnL réalisé">{formatSol(totals.realizedLamports, true)}</Kpi>
      <Kpi label="PnL non réalisé">
        {formatSol(totals.unrealizedLamports, true)}
        <small className="text-secondary d-block">indicatif, prix spot</small>
        {excluded > 0 && (
          <small className="text-secondary d-block">
            {excluded === 1 ? '1 position exclue' : `${String(excluded)} positions exclues`}
          </small>
        )}
      </Kpi>
      <Kpi label="Positions ouvertes">{String(totals.openCount)}</Kpi>
    </div>
  );
}

function Kpi({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <div className="col-6 col-lg-3">
      <div className="card shadow-sm h-100"><div className="card-body">
        <div className="text-secondary small">{label}</div>
        <div className="fs-5 fw-semibold">{children}</div>
      </div></div>
    </div>
  );
}

function OpenPositionsTable({ positions }: { readonly positions: readonly OperatorOpenPosition[] }): ReactNode {
  return (
    <div>
      <h2 className="h5">Positions ouvertes</h2>
      {positions.length === 0 ? <EmptyState>Aucune position ouverte.</EmptyState> : (
        <div className="table-responsive"><table className="table table-sm align-middle">
          <thead><tr>
            <th scope="col">Token</th><th scope="col">État</th><th scope="col">Quantité restante (brut)</th>
            <th scope="col">Coût</th><th scope="col">Valeur spot</th><th scope="col">PnL non réalisé</th>
            <th scope="col">Sortie avant</th>
          </tr></thead>
          <tbody>{positions.map((position) => (
            <tr key={position.positionId}>
              <td><Link to={`/launches/${position.mint}`}><ShortIdentifier value={position.mint} /></Link></td>
              <td>{position.state}</td>
              <td>{formatInteger(position.remainingRaw)}</td>
              <td>{formatSol(position.costLamports)}</td>
              <td>{position.spotValueLamports === null ? 'non disponible' : formatSol(position.spotValueLamports)}</td>
              <td>
                {position.unrealizedLamports === null ? 'non disponible' : (
                  <>{formatSol(position.unrealizedLamports, true)} ({formatPnlPercent(position.unrealizedLamports, position.costLamports)})</>
                )}
              </td>
              <td><Timestamp value={position.exitDeadlineAt} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

function HistoryTable({ positions }: { readonly positions: readonly OperatorClosedPosition[] }): ReactNode {
  return (
    <div>
      <h2 className="h5">Historique</h2>
      {positions.length === 0 ? <EmptyState>Aucune position fermée enregistrée.</EmptyState> : (
        <div className="table-responsive"><table className="table table-sm align-middle">
          <thead><tr>
            <th scope="col">Token</th><th scope="col">Ouverte</th><th scope="col">Fermée</th>
            <th scope="col">PnL réalisé</th><th scope="col">Transactions</th>
          </tr></thead>
          <tbody>{positions.map((position) => (
            <tr key={position.positionId}>
              <td><Link to={`/launches/${position.mint}`}><ShortIdentifier value={position.mint} /></Link></td>
              <td><Timestamp value={position.openedAt} /></td>
              <td><Timestamp value={position.closedAt} /></td>
              <td>{formatSol(position.realizedLamports, true)}</td>
              <td className="d-flex gap-2">
                <SafeExternalLink href={`https://solscan.io/tx/${position.entrySignature}`}>Entrée</SafeExternalLink>
                <SafeExternalLink href={`https://solscan.io/tx/${position.exitSignature}`}>Sortie</SafeExternalLink>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}
