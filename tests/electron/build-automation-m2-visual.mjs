import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['tests/electron/automation-m2-visual-smoke.ts'],
  outfile: 'release/tests/automation-m2-visual-smoke.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node12',
  external: ['electron', '@techstark/opencv-js'],
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: ['tests/electron/automation-m5-ruffle-visual-smoke.ts'],
  outfile: 'release/tests/automation-m5-ruffle-visual-smoke.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node12',
  external: ['electron', '@techstark/opencv-js'],
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: ['src/main/modules/automation/vision-worker.cjs'],
  outfile: 'release/tests/vision-worker.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node12',
  external: ['@techstark/opencv-js'],
  logLevel: 'info',
});
