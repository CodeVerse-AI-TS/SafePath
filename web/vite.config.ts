import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // The SafePath API stays on the Express server; proxy so the SPA can call it
    // without CORS changes to the existing backend.
    proxy: {
      '/api': {
        target: process.env.SAFEPATH_API_URL || 'http://localhost:12000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
