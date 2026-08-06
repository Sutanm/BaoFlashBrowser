import esbuild from 'esbuild';

// Bundle the userscript admin service (index.ts) so the Electron admin smoke
// can drive install/list/enable/uninstall directly.
await esbuild.build({
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node12',
  external: ['electron', 'electron-log', 'electron-store'],
  entryPoints: ['src/main/modules/userscripts/index.ts'],
  outfile: 'release/tests/userscripts-admin-module.cjs',
});
