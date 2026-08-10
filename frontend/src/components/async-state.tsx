import type { ReactNode } from 'react';

export function LoadingState({ label = 'Chargement…' }: { readonly label?: string }): ReactNode {
  return <p className="text-secondary" role="status">{label}</p>;
}

export function EmptyState({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className="alert alert-secondary mb-0">{children}</p>;
}

export function ErrorState({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className="alert alert-danger mb-0" role="alert">{children}</p>;
}
