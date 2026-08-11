import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ErrorState, LoadingState } from '../../components/async-state.js';
import { holdersQuery } from '../../data/queries.js';
import { useApiClient } from '../../data/use-api-client.js';

export function HoldersPanel({ mint }: { readonly mint: string }): ReactNode {
  const query = useQuery(holdersQuery(useApiClient(), mint));
  if (query.isPending) return <LoadingState label="Chargement des détenteurs observés…" />;
  if (query.isError) return <ErrorState>Analyse des détenteurs indisponible.</ErrorState>;
  if (query.data.status === 'NOT_AVAILABLE') return <p className="alert alert-secondary">Détenteurs observés indisponibles</p>;
  const holders = query.data;
  return (
    <section aria-labelledby="holders-title">
      <h2 className="h5" id="holders-title">Acheteurs et détenteurs observés</h2>
      <p className="alert alert-info small">Ces données observées sur la bonding curve ne constituent pas un historique complet des wallets.</p>
      <div className="row g-2 mb-3">
        <Metric label="Acheteurs externes uniques" value={String(holders.creatorProfile.uniqueExternalBuyers)} />
        <Metric label="Top 1 (bps)" value={holders.latestSnapshot.top1Bps} />
        <Metric label="Top 5 (bps)" value={holders.latestSnapshot.top5Bps} />
        <Metric label="Part créateur (bps)" value={holders.latestSnapshot.creatorBps} />
      </div>
      <p>Créateur : {holders.creatorProfile.hasSold ? 'vente observée' : 'aucune vente observée'}.</p>
      <p>Analyse de clusters : {holders.clusterAnalysisStatus}</p>
      {holders.clusterAnalysisStatus === 'AVAILABLE' && (
        <p>{holders.clusterCount} cluster(s), {holders.clustersTruncated ? 'liste tronquée' : 'liste complète'} ; {holders.clusterCoverage.evidenceCount} preuve(s) de relation.</p>
      )}
    </section>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return <div className="col-6 col-lg-3"><div className="border rounded p-2"><span className="small d-block">{label}</span><strong aria-label={`${label} : ${value}`}>{value}</strong></div></div>;
}
