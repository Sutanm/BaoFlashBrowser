import esbuild from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node12',
  external: ['electron', 'electron-log', 'electron-store'],
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
    entryPoints: ['tests/electron/userscript-runtime-smoke.ts'],
    outfile: 'release/tests/userscript-runtime-smoke.cjs',
    alias: {
      '@shared': './src/shared',
      '@main': './src/main',
    },
  }),
]);
