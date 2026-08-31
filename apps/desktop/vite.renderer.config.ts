import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

export function applyDevelopmentCsp(html: string): string {
  return html
    .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
    .replace("connect-src 'none'", "connect-src 'self' ws://localhost:*");
}

const developmentCsp = {
  name: 'dagent-development-csp',
  transformIndexHtml: applyDevelopmentCsp,
} satisfies Plugin;

export default defineConfig(({ command }) => ({
  root: resolve(import.meta.dirname, 'src/renderer'),
  plugins: [react(), ...(command === 'serve' ? [developmentCsp] : [])],
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, '.vite/renderer/main_window'),
    sourcemap: true,
  },
}));
