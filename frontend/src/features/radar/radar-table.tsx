import type { ReactNode } from 'react';
import type { ApiLaunchSummary } from '../../data/api-schemas.js';
import { ShortIdentifier, Timestamp } from '../../components/format.js';

export interface RadarTableProps {
  readonly launches: readonly ApiLaunchSummary[];
  readonly selectedMint: string | null;
  readonly onSelect: (mint: string) => void;
}

export function RadarTable({ launches, selectedMint, onSelect }: RadarTableProps): ReactNode {
  return (
    <div className="table-responsive">
      <table className="table table-sm table-hover align-middle mb-0">
        <thead className="table-light">
          <tr><th>Token</th><th>Détecté</th><th>Statut</th><th>Quote</th><th>Score</th><th>Paper</th></tr>
        </thead>
        <tbody>
          {launches.map((launch) => (
            <tr key={launch.mint} aria-selected={launch.mint === selectedMint}>
              <td>
                <button
                  type="button"
                  className="btn btn-link text-start p-0 text-decoration-none"
                  aria-label={`${launch.name ?? launch.symbol ?? launch.mint} — sélectionner`}
                  onClick={() => { onSelect(launch.mint); }}
                >
                  <span className="d-block fw-semibold">{launch.name ?? 'Sans nom'} {launch.symbol === null ? '' : `(${launch.symbol})`}</span>
                  <ShortIdentifier value={launch.mint} />
                </button>
              </td>
              <td><Timestamp value={launch.detectedAt} /></td>
              <td><span className="badge text-bg-secondary">{launch.status}</span></td>
              <td>{launch.quoteMint === null ? 'Inconnue' : <ShortIdentifier value={launch.quoteMint} />}</td>
              <td>{launch.qualificationSummary?.scores.total.score ?? '—'}</td>
              <td>{launch.paperStrategy?.state ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
