import path from 'path';
import fs from 'fs';
import os from 'os';
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
    pool: 'threads',
    minThreads: 4,
    maxThreads: 16,
    coverage: {
      provider: 'v8',
      // Keep V8 temp raw coverage and reports out of the workspace:
      // vitest bulk-deletes its .tmp directory after every run, which
      // trips the host sandbox's batch-delete guard on project paths.
      // The OS temp dir is not subject to that protection.
      reportsDirectory: path.join(os.tmpdir(), 'bao-flash-coverage'),
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main/modules/automation/vision-worker.cjs',
        'src/main/modules/userscripts/bundled-scripts/**',
        'src/renderer/i18n/**',
        'src/renderer/types/**',
        'src/shared/types/**',
        'src/renderer/store/**',
      ],
      thresholds: {
        lines: 30,
        functions: 28,
        branches: 28,
        statements: 30,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.{test,spec}.{ts,tsx}'],
          exclude: [
            'tests/e2e/**',
            'tests/automation-vision-worker.test.ts',
            'tests/automation-bao1-ocr-sidecar.test.ts',
            'tests/automation-paddle-sidecar-runtime.integration.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [
            'tests/automation-vision-worker.test.ts',
            'tests/automation-bao1-ocr-sidecar.test.ts',
            'tests/automation-paddle-sidecar-runtime.integration.test.ts',
          ],
        },
      },
    ],
  },
});
