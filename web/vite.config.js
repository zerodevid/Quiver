import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Build statis; Node server (src/server.js) yang menyajikan dist/ + API di origin yang sama.
//
// Dua entri:
//   index.html — dasbor (React + HeroUI), di balik gerbang token.
//   mini.html  — mini app Telegram (/mini), JS polos tanpa React. Ia dimuat SEBELUM
//                ada sesi, jadi server cuma membukakan gerbang untuk berkas bernama
//                mini-* (server.js: MINI_PUBLIC). Karena itu web/src/mini/ tidak boleh
//                mengimpor apa pun dari web/src/: modul bersama akan dipindahkan Rollup
//                ke potongan bernama lain, dan potongan itu tidak akan pernah terkirim.
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
