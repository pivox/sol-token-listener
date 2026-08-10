import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ApiLaunchSummary } from '../../data/api-schemas.js';
import { ShortIdentifier } from '../../components/format.js';

export function LaunchSummaryPanel({ launch }: { readonly launch: ApiLaunchSummary | null }): ReactNode {
  if (launch === null) return <p className="text-secondary mb-0">Sélectionnez un lancement.</p>;
  const qualification = launch.qualificationSummary;
  return (
    <article aria-label="Résumé du lancement">
      <h2 className="h5 mb-1">{launch.name ?? 'Sans nom'} {launch.symbol === null ? '' : `(${launch.symbol})`}</h2>
      <p><ShortIdentifier value={launch.mint} /></p>
      {qualification === null ? (
        <p className="alert alert-secondary">Qualification indisponible</p>
      ) : (
        <>
          {qualification.blockerCodes.length > 0 && (
            <div className="alert alert-danger" role="alert" aria-label="Condition éliminatoire active">
              <strong>Condition éliminatoire</strong>
              <ul className="mb-0">{qualification.blockerCodes.map((code) => <li key={code}>{code}</li>)}</ul>
            </div>
          )}
          <div className="border rounded p-3 mb-3">
            <span className="text-secondary d-block">Score total indicatif</span>
            <strong className="fs-4">{qualification.scores.total.score} / {qualification.scores.total.maximum}</strong>
            <span className="d-block small">Verdict : {qualification.verdict}</span>
          </div>
        </>
      )}
      <dl className="row small">
        <dt className="col-6">Liquidité quote</dt><dd className="col-6">{launch.liquidityQuote ?? 'Indisponible'}</dd>
        <dt className="col-6">Candidat paper</dt><dd className="col-6">{launch.candidate?.state ?? 'Non disponible'}</dd>
        <dt className="col-6">Progression</dt>
        <dd className="col-6">{launch.paperStrategy === null ? 'Non disponible' : `${String(launch.paperStrategy.externalBuyCount)} / ${String(launch.paperStrategy.externalBuyTarget)} achats externes`}</dd>
      </dl>
      <Link className="btn btn-outline-primary btn-sm" to={`/launches/${launch.mint}`}>Ouvrir la fiche</Link>
    </article>
  );
}
