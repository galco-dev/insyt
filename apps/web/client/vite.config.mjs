// Insyt app client — Vite build. Output lands in apps/web/public/app so the
// existing node server (or Railway static serving) can mount it under /app.
// Tailwind v4 runs through @tailwindcss/vite (no postcss config). The "@"
// alias points INTO the vendored Untitled UI kit (src/uui) so kit files can
// keep their internal "@/..." imports unmodified.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  base: '/app/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/uui'),
    },
  },
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
  },
});
