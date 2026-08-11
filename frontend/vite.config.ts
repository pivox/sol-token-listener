/// <reference types="vitest/config" />

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { rejectNonReadOnlyApiMethod } from './vite-read-only-api-proxy.js';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'read-only-api-proxy',
      configureServer(server) {
        server.middlewares.use('/api/v1', (request, response, next) => {
          if (!rejectNonReadOnlyApiMethod(request, response)) next();
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api/v1': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
        ws: false,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'vite-read-only-api-proxy.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
