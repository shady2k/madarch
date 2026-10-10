import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The wiki app is built to static files in dist/; the madarch server serves them
// (decision 0018). Tailwind v4 runs through @tailwindcss/vite; the theme reads
// the design tokens by name, so the token sheet (styles/tokens.css) stays the
// single source of the values. No dev-proxy is configured: the app reads
// madarch's own API when it is served, and `vite dev` is only a convenience.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
});
