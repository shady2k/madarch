import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The wiki app is built to static files in dist/; the madarch server serves them
// (decision 0018). No dev-proxy is configured: the app reads madarch's own API
// when it is served, and `vite dev` is only a convenience for its own work.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
