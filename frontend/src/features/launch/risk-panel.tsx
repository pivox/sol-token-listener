import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState, LoadingState } from '../../components/async-state.js';
import { riskQuery } from '../../data/queries.js';
import { useApiClient } from '../../data/use-api-client.js';

export function RiskPanel({ mint }: { readonly mint: string }): ReactNode {
  const query = useQuery(riskQuery(useApiClient(), mint));
  if (query.isPending) return <LoadingState label="Chargement de la qualification…" />;
  if (query.isError) return <ErrorState>Qualification indisponible.</ErrorState>;
  const report = query.data;
  if (report === null) return <EmptyState>Aucun rapport de qualification.</EmptyState>;
  return (
    <section aria-labelledby="risk-title">
      <h2 className="h5" id="risk-title">Qualification expliquée</h2>
      <p className="small text-secondary">Règles {report.ruleSet.id} v{report.ruleSet.version} — {report.ruleSet.status}</p>
      {report.blockers.length > 0 && (
        <div className="alert alert-danger" role="alert" aria-label="Condition éliminatoire active">
          <strong>Conditions éliminatoires</strong>
          <ul className="mb-0">{report.blockers.map((blocker) => <li key={blocker.code}><code>{blocker.code}</code> — {blocker.message}</li>)}</ul>
        </div>
      )}
      <div className="row g-2 mb-3">
        <Score label="Préparation" score={report.scores.preparation.score} maximum={report.scores.preparation.maximum} />
        <Score label="Authenticité sociale" score={report.scores.socialAuthenticity.score} maximum={report.scores.socialAuthenticity.maximum} />
        <Score label="Santé on-chain" score={report.scores.onchainHealth.score} maximum={report.scores.onchainHealth.maximum} />
        <Score label="Total" score={report.scores.total.score} maximum={report.scores.total.maximum} />
      </div>
      <div className="table-responsive">
        <table className="table table-sm"><thead><tr><th>Condition</th><th>Mode</th><th>État</th><th>Explication</th></tr></thead>
          <tbody>{report.conditions.map((condition) => <tr key={condition.code}><td><code>{condition.code}</code></td><td>{condition.mode}</td><td>{condition.status}</td><td>{condition.message}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function Score({ label, score, maximum }: { readonly label: string; readonly score: number; readonly maximum: number }): ReactNode {
  return <div className="col-6 col-lg-3"><div className="border rounded p-2 h-100"><span className="small d-block">{label}</span><strong>{score} / {maximum}</strong></div></div>;
}
