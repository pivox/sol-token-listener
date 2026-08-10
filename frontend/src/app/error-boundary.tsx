import { Component } from 'react';
import type { ReactNode } from 'react';

interface ErrorBoundaryProps { readonly children: ReactNode }
interface ErrorBoundaryState { readonly failed: boolean }

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { failed: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  public override render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="container py-5">
          <h1>Vue indisponible</h1>
          <p role="alert">Une erreur d’affichage isolée empêche cette vue de fonctionner.</p>
        </main>
      );
    }
    return this.props.children;
  }
}
