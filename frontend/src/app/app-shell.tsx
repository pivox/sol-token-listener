import { NavLink, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useRealtimeSnapshot } from '../data/realtime-context.js';
import type { RealtimeState } from '../data/sse-client.js';
import { ErrorBoundary } from './error-boundary.js';

const realtimeLabels: Readonly<Record<RealtimeState, string>> = {
  CONNECTING: 'connexion',
  LIVE: 'connecté',
  RECONNECTING: 'reconnexion',
  RESYNCING: 'resynchronisation',
  DISCONNECTED: 'déconnecté',
  STOPPED: 'arrêté',
};

export function AppShell(): ReactNode {
  const realtime = useRealtimeSnapshot();
  return (
    <div className="min-vh-100 d-flex flex-column bg-body-tertiary">
      <header className="navbar navbar-expand-md navbar-dark bg-dark border-bottom border-secondary sticky-top">
        <div className="container-fluid gap-3">
          <NavLink className="navbar-brand fw-semibold" to="/">Pump Radar</NavLink>
          <nav className="navbar-nav flex-row gap-2" aria-label="Navigation principale">
            <NavItem to="/">Radar</NavItem>
            <NavItem to="/paper-positions">Positions paper</NavItem>
            <NavItem to="/health">Santé</NavItem>
          </nav>
          <div className="ms-auto d-flex flex-wrap align-items-center justify-content-end gap-2 small">
            <span className="badge text-bg-warning">Simulation uniquement</span>
            <span className="text-light" role="status" aria-live="polite">
              Temps réel : {realtimeLabels[realtime.state]}
            </span>
          </div>
        </div>
      </header>
      <main className="container-fluid flex-grow-1 py-3">
        <ErrorBoundaryOutlet />
      </main>
    </div>
  );
}

function NavItem({ to, children }: { readonly to: string; readonly children: ReactNode }): ReactNode {
  return (
    <NavLink
      className={({ isActive }) => `nav-link px-2${isActive ? ' active' : ''}`}
      end={to === '/'}
      to={to}
    >
      {children}
    </NavLink>
  );
}

function ErrorBoundaryOutlet(): ReactNode {
  return <ErrorBoundary><Outlet /></ErrorBoundary>;
}
