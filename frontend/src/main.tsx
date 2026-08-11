import 'bootstrap/dist/css/bootstrap.min.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app.js';
import { ConfigurationError } from './app/configuration-error.js';
import { loadRuntimeConfig } from './data/runtime-config.js';

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root');
  if (container === null) throw new Error('Missing application root');
  const root = createRoot(container);
  try {
    const config = await loadRuntimeConfig(fetch);
    root.render(<StrictMode><App apiBaseUrl={config.apiBaseUrl} /></StrictMode>);
  } catch {
    root.render(<StrictMode><ConfigurationError /></StrictMode>);
  }
}

void bootstrap();
