import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    sourcemap: true,
    rollupOptions: {
      external: ['node:sqlite'],
      output: { entryFileNames: 'main.cjs', format: 'cjs' },
    },
  },
});
