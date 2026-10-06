import { useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';

export interface TokenPromptProps {
  readonly refused: boolean;
  readonly onSubmit: (token: string) => void;
}

export function TokenPrompt({ refused, onSubmit }: TokenPromptProps): ReactNode {
  const [value, setValue] = useState('');
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const token = value.trim();
    if (token.length > 0) onSubmit(token);
  };
  return (
    <form className="card shadow-sm" onSubmit={submit}>
      <div className="card-body d-grid gap-3">
        <h1 className="h4 mb-0">Surface live opérateur</h1>
        {refused && <p className="alert alert-danger mb-0" role="alert">Token refusé</p>}
        <div>
          <label className="form-label" htmlFor="operator-token">Jeton opérateur</label>
          <input
            id="operator-token"
            className="form-control"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => { setValue(event.target.value); }}
          />
          <p className="form-text mb-0">Conservé uniquement pour cet onglet.</p>
        </div>
        <div><button type="submit" className="btn btn-primary">Valider</button></div>
      </div>
    </form>
  );
}
