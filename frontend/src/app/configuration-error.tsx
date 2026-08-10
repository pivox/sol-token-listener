import type { ReactNode } from 'react';

export function ConfigurationError(): ReactNode {
  return (
    <main className="container py-5">
      <div className="alert alert-danger" role="alert">
        <h1 className="h4 alert-heading">Configuration indisponible</h1>
        <p className="mb-0">La console ne peut pas démarrer sans une URL d’API publique valide.</p>
      </div>
    </main>
  );
}
