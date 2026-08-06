import path from 'path';
import fs from 'fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@main': path.resolve(__dirname, 'src/main'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
  plugins: [
    {
      // Match the esbuild main-bundle loader: built-in userscript artifacts
      // are embedded as TEXT, never executed as JS (the artifact contains the
      // container-query-polyfill whose top level touches the DOM/CSS).
      name: 'user-js-as-text',
      enforce: 'pre',
      load(id: string) {
        if (id.endsWith('.user.js')) {
          return `export default ${JSON.stringify(fs.readFileSync(id, 'utf8'))}`;
        }
      },
    },
  ],
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
  },
});
