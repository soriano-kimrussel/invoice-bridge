import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    // In dev, Vite serves the UI and forwards API + OAuth routes to Fastify.
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
    },
  },
});
