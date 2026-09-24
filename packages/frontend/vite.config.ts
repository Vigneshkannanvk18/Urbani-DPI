import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API base is read at runtime from window config / env; in dev we proxy
// /api to the backend so the frontend never needs the AWS SDK or direct URLs.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
