import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['tests/electron/session-compatibility-smoke.ts'],
  outfile: 'release/tests/session-compatibility-smoke.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node12',
  external: ['electron', 'electron-log', 'electron-store'],
  alias: {
    '@shared': './src/shared',
    '@main': './src/main',
  },
  plugins: [{
    name: 'stub-download-manager',
    setup(build) {
      build.onResolve({ filter: /^\.\/download$/ }, () => ({ path: 'download-stub', namespace: 'compat-smoke' }));
      build.onLoad({ filter: /.*/, namespace: 'compat-smoke' }, () => ({
        contents: 'export function setupDownloadHandlers() {}',
        loader: 'js',
      }));
    },
  }],
});
