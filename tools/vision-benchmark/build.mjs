import path from 'path';
import fs from 'fs';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..', '..');
const outputDirectory = path.join(root, '.cache', 'vision-benchmark');
fs.mkdirSync(outputDirectory, { recursive: true });
await build({
  entryPoints: {
    runner: path.join(import.meta.dirname, 'run.ts'),
    'color-poc': path.join(import.meta.dirname, 'run-color-poc.ts'),
    'color-video-poc': path.join(import.meta.dirname, 'run-color-video-poc.ts'),
    'fishing-hook-gate': path.join(import.meta.dirname, 'run-fishing-hook-gate.ts'),
    'color-worker-gate': path.join(import.meta.dirname, 'run-color-worker-gate.ts'),
    'color-group-poc': path.join(import.meta.dirname, 'run-color-group-poc.ts'),
    'color-scale-gate': path.join(import.meta.dirname, 'run-color-scale-gate.ts'),
    'routing-poc': path.join(import.meta.dirname, 'run-routing-poc.ts'),
    'scale-estimation-poc': path.join(import.meta.dirname, 'run-scale-estimation-poc.ts'),
    'structure-poc': path.join(import.meta.dirname, 'run-structure-poc.ts'),
    'color-vision-worker': path.join(root, 'src', 'main', 'modules', 'automation', 'color-vision-worker.ts'),
  },
  outdir: outputDirectory,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node12',
  external: ['sharp'],
  sourcemap: false,
  logLevel: 'info',
});
