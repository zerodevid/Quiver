import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Build statis; Node server (src/server.js) yang menyajikan dist/ + API di origin yang sama.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: { proxy: { '/api': 'http://127.0.0.1:8799' } },
});
