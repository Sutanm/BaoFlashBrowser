import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['tests/electron/fixtures/automation-authoring-entry.ts'],
  outfile: 'release/tests/automation-authoring-core.cjs',
  bundle: true,
  platform: 'node',
  target: 'node12',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'info',
});
