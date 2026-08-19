// Insyt app client — Vite build. Output lands in apps/web/public/app so the
// existing node server (or Railway static serving) can mount it under /app.
const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

module.exports = defineConfig({
  root: __dirname,
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
  },
});
