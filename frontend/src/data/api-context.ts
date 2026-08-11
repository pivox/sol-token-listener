import { createContext } from 'react';
import type { ApiClient } from './api-client.js';

export const ApiClientContext = createContext<ApiClient | null>(null);
