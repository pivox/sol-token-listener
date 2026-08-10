import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ErrorState, LoadingState } from '../../components/async-state.js';
import { SafeExternalLink } from '../../components/safe-external-link.js';
import { socialQuery } from '../../data/queries.js';
import { useApiClient } from '../../data/use-api-client.js';

export function SocialPanel({ mint }: { readonly mint: string }): ReactNode {
  const query = useQuery(socialQuery(useApiClient(), mint));
  if (query.isPending) return <LoadingState label="Chargement des preuves sociales…" />;
  if (query.isError) return <ErrorState>Preuves sociales indisponibles.</ErrorState>;
  if (query.data.status === 'NOT_AVAILABLE') return <p className="alert alert-secondary">Preuves sociales indisponibles</p>;
  const social = query.data;
  return (
    <section aria-labelledby="social-title">
      <h2 className="h5" id="social-title">Preuves sociales</h2>
      <p className="alert alert-info small">Collecte {social.collectionStatus}. La présence d’un lien ne prouve pas son authenticité.</p>
      <p>{social.coverage.inspectedLinkCount} lien(s) inspecté(s) sur {social.coverage.declaredLinkCount} déclaré(s).</p>
      <ul className="list-group mb-3">{social.links.map((link) => (
        <li className="list-group-item" key={link.id}><strong>{link.kind}</strong> — <SafeExternalLink href={link.canonicalUrl}>{link.canonicalUrl ?? 'URL invalide'}</SafeExternalLink> ({link.syntaxStatus})</li>
      ))}</ul>
      <div className="table-responsive"><table className="table table-sm"><thead><tr><th>Preuve</th><th>Résultat</th><th>Raison</th></tr></thead>
        <tbody>{social.evidence.map((evidence) => <tr key={evidence.id}><td>{evidence.type}</td><td>{evidence.outcome}</td><td>{evidence.reasonCode}</td></tr>)}</tbody>
      </table></div>
    </section>
  );
}
