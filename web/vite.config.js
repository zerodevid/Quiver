import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Static build; the Node server (src/server.js) serves dist/ + the API on the same origin.
// One entry: index.html is the dashboard at / and, unchanged, the Telegram mini app at /mini
// (main.jsx signs in with Telegram there — see src/telegram.js).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8799' } },
});
