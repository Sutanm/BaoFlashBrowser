import path from 'path';
import fs from 'fs';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..', '..');
const outputDirectory = path.join(root, '.cache', 'vision-benchmark');
fs.mkdirSync(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(import.meta.dirname, 'run.ts')],
  outfile: path.join(outputDirectory, 'runner.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node12',
  sourcemap: false,
  logLevel: 'info',
});
