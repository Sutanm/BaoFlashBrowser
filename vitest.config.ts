import path from 'path';
import fs from 'fs';
import os from 'os';
import { defineConfig } from 'vitest/config';
import { moduleDefines, parseModules } from './build/module-flags.mjs';

export default defineConfig({
  // Unit tests exercise the historical full product unless a test invokes a
  // build explicitly with a different BAO_MODULES selection.
  define: moduleDefines(parseModules('all')),
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
    // 单测不得写真实应用日志（electron-log 在纯 Node 下指向 %APPDATA%\<name>\logs\main.log，
    // 会让 mock 路径的告警混进真机日志，2026-09-21 排查时被它误导过）。
    setupFiles: [path.resolve(__dirname, 'tests/setup/quiet-electron-log.ts')],
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
