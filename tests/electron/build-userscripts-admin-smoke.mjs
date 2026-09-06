import esbuild from 'esbuild';
import { moduleDefines, parseModules } from '../../build/module-flags.mjs';

// Bundle the userscript admin service (index.ts) so the Electron admin smoke
// can drive install/list/enable/uninstall directly.
await esbuild.build({
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node12',
  define: moduleDefines(parseModules('all')),
  external: ['electron', 'electron-log', 'electron-store'],
  loader: {
    '.user.js': 'text',
  },
  entryPoints: ['src/main/modules/userscripts/index.ts'],
  outfile: 'release/tests/userscripts-admin-module.cjs',
});
