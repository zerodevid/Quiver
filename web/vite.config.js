import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Static build; the Node server (src/server.js) serves dist/ + the API on the same origin.
//
// Two entries:
//   index.html — the dashboard (React + HeroUI), behind the token gate.
//   mini.html  — Telegram mini app (/mini), plain JS without React. It is loaded BEFORE
//                there is a session, so the server only opens the gate for files named
//                mini-* (server.js: MINI_PUBLIC). Because of that web/src/mini/ must not
//                import anything from web/src/: a shared module would be moved by Rollup
//                into a chunk with another name, and that chunk would never be shipped.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: { index: resolve(import.meta.dirname, 'index.html'), mini: resolve(import.meta.dirname, 'mini.html') } },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8799' } },
});
