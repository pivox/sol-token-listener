import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ErrorState, LoadingState } from '../../components/async-state.js';
import { Timestamp } from '../../components/format.js';
import { healthQuery } from '../../data/queries.js';
import { useApiClient } from '../../data/use-api-client.js';
import type { ApiHealth } from '../../data/api-schemas.js';

export function HealthPage(): ReactNode {
  const query = useQuery(healthQuery(useApiClient()));
  if (query.isPending) return <LoadingState label="Chargement de la santé technique…" />;
  if (query.isError) return <ErrorState>État technique indisponible.</ErrorState>;
  const health = query.data;
  return (
    <section aria-labelledby="health-title">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <div><h1 className="h3 mb-1" id="health-title">Santé technique</h1><p className="text-secondary mb-0">Observation : <Timestamp value={health.observedAt} /></p></div>
        <button type="button" className="btn btn-outline-primary btn-sm" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>Actualiser</button>
      </div>
      <div className={`alert ${health.status === 'OK' ? 'alert-success' : 'alert-warning'}`} role="alert"><strong>{health.status}</strong> — état public agrégé du listener.</div>
      <div className="row g-3">
        <HealthCard title="Dépendances"><p>PostgreSQL : <strong>{health.postgresql.status}</strong></p><p>HTTP : <strong>{health.http.status}</strong></p></HealthCard>
        <HealthCard title="Pipelines"><PipelineRows health={health} /></HealthCard>
        <HealthCard title="Jobs sociaux"><JobCounts value={health.socialJobs} /></HealthCard>
        <HealthCard title="Décisions paper"><JobCounts value={health.paperDecisionJobs} /><p>Dernier succès : <Timestamp value={health.paperDecisionJobs.lastSuccessAt} /></p><p>Dernière erreur : <code>{health.paperDecisionJobs.lastErrorCode ?? 'Aucune'}</code></p></HealthCard>
        <HealthCard title="Qualification"><p>Rapports courants : {health.qualification.currentCount}</p><p>Dernier succès : <Timestamp value={health.qualification.lastSuccessAt} /></p></HealthCard>
        <HealthCard title="Heartbeat"><p>Runtime : {health.heartbeat.runtimeState ?? 'Indisponible'}</p><p>Backlog : {health.heartbeat.backlogCount ?? 'Indisponible'} ; épuisés : {health.heartbeat.exhaustedCount ?? 'Indisponible'}</p><p>Dernier slot finalisé : {health.heartbeat.lastFinalizedSlot ?? 'Indisponible'}</p></HealthCard>
        <HealthCard title="Checkpoints"><p>Launchpad : {health.checkpoints.launchpad ?? 'Indisponible'}</p><p>Marché : {health.checkpoints.market ?? 'Indisponible'}</p><p>Retard : {health.lagSlots ?? 'Indisponible'} slot(s)</p></HealthCard>
      </div>
    </section>
  );
}

function HealthCard({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactNode {
  return <div className="col-12 col-lg-6"><section className="card h-100 shadow-sm"><div className="card-body"><h2 className="h5">{title}</h2>{children}</div></section></div>;
}

function PipelineRows({ health }: { readonly health: ApiHealth }): ReactNode {
  return <><p>Pompe Pump.fun : <span aria-label={`Pump.fun : ${health.pipeline.pumpfun}`}>{health.pipeline.pumpfun}</span></p><p>Pool PumpSwap : {health.pipeline.pumpswap}</p><p>Paper decision : <span aria-label={`Paper decision : ${health.pipeline.paperDecision}`}>{health.pipeline.paperDecision}</span></p><p>Qualification : <span aria-label={`Qualification : ${health.pipeline.qualification}`}>{health.pipeline.qualification}</span></p><p>Social : {health.pipeline.social}</p></>;
}

function JobCounts({ value }: { readonly value: { readonly pendingCount: number; readonly leasedCount: number; readonly retryableFailedCount: number; readonly exhaustedCount: number } }): ReactNode {
  return <p>En attente : {value.pendingCount} ; loués : {value.leasedCount} ; échecs rejouables : {value.retryableFailedCount} ; épuisés : {value.exhaustedCount}</p>;
}
