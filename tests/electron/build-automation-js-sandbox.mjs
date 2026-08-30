import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['tests/electron/fixtures/automation-js-sandbox-entry.ts'],
  outfile: 'release/tests/automation-js-sandbox-host.cjs',
  bundle: true,
  platform: 'node',
  target: 'node12',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'info',
});
