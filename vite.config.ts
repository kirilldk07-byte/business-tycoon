import { defineConfig } from 'vite';

// Dev: client on :5180, websocket proxied to the game server on :3040.
export default defineConfig({
  root: 'client',
  base: './',
  build: { outDir: '../dist/client', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    host: true,
    port: 5180,
    proxy: { '/ws': { target: 'ws://localhost:3040', ws: true }, '/api': 'http://localhost:3040' },
  },
});
