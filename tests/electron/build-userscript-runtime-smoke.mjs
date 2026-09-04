import esbuild from 'esbuild';
import { moduleDefines, parseModules } from '../../build/module-flags.mjs';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node12',
  external: ['electron', 'electron-log', 'electron-store'],
  loader: {
    '.user.js': 'text',
  },
  // Standalone smoke bundles do not pass through esbuild.main.config.mjs.
  // Exercise the historical/full preload unless a smoke explicitly tests a
  // reduced module set.
  define: moduleDefines(parseModules('all')),
};

await Promise.all([
  esbuild.build({
    ...shared,
    // The FULL production preload (Ruffle/PPAPI shims + userscript runtime),
    // not the demo bootstrap, so the smoke exercises the real integration.
    entryPoints: ['src/webview-preload/index.ts'],
    outfile: 'release/tests/userscript-runtime-preload.cjs',
  }),
  esbuild.build({
    ...shared,
    entryPoints: ['tests/electron/userscript-runtime-smoke-entry.ts'],
    outfile: 'release/tests/userscript-runtime-smoke.cjs',
    alias: {
      '@shared': './src/shared',
      '@main': './src/main',
    },
  }),
]);
