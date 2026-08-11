import type { ReactNode } from 'react';
import type { ApiLaunchDetail } from '../../data/api-schemas.js';
import { ShortIdentifier, Timestamp } from '../../components/format.js';

export function OverviewPanel({ launch }: { readonly launch: ApiLaunchDetail }): ReactNode {
  return (
    <section className="card shadow-sm" aria-labelledby="overview-title">
      <div className="card-body">
        <h2 className="h5" id="overview-title">Aperçu on-chain</h2>
        <p className="alert alert-info small">Méthodologie : OBSERVED_BONDING_CURVE_TRADES. Les valeurs décrivent uniquement les événements observés.</p>
        <dl className="row mb-0">
          <dt className="col-sm-4">Mint</dt><dd className="col-sm-8"><ShortIdentifier value={launch.mint} /></dd>
          <dt className="col-sm-4">Créateur</dt><dd className="col-sm-8"><ShortIdentifier value={launch.creator} /></dd>
          <dt className="col-sm-4">Détecté</dt><dd className="col-sm-8"><Timestamp value={launch.detectedAt} /></dd>
          <dt className="col-sm-4">Programme token</dt><dd className="col-sm-8">{launch.tokenProgram}</dd>
          <dt className="col-sm-4">Quote mint</dt><dd className="col-sm-8">{launch.quoteMint === null ? 'Indisponible' : <ShortIdentifier value={launch.quoteMint} />}</dd>
          <dt className="col-sm-4">Réserve base brute</dt><dd className="col-sm-8">{launch.reserveBase ?? 'Indisponible'}</dd>
          <dt className="col-sm-4">Réserve quote brute</dt><dd className="col-sm-8">{launch.reserveQuote ?? 'Indisponible'}</dd>
          <dt className="col-sm-4">Frais (bps)</dt><dd className="col-sm-8">{launch.feeBps ?? 'Indisponible'}</dd>
        </dl>
      </div>
    </section>
  );
}
