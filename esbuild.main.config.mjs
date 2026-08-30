import esbuild from 'esbuild';
import { copy } from 'esbuild-plugin-copy';
import fs from 'fs';

const isWatch = process.argv.includes('--watch');
const provenance = JSON.parse(fs.readFileSync(new URL('./provenance.json', import.meta.url), 'utf8'));
const provenanceShortId = `bfb:${provenance.fingerprint.slice(7, 23)}`;
const provenanceBanner = `/*! ${provenance.project} | Copyright (c) ${provenance.year} ${provenance.author} | ${provenanceShortId} | ${provenance.origin} */`;

/** @type {esbuild.BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node12',
  external: ['electron', 'electron-log', 'electron-store', 'esbuild', '@techstark/opencv-js'],
  alias: {
    '@shared': './src/shared',
    '@main': './src/main',
  },
  loader: {
    // Built-in userscript sources are embedded as text into the main bundle
    '.user.js': 'text',
  },
  logLevel: 'info',
  banner: { js: provenanceBanner },
};

const builds = [
  {
    ...shared,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main.js',
    plugins: [
      copy({
        assets: [
          {
            from: 'node_modules/@ruffle-rs/ruffle/**/*',
            to: 'lib/ruffle',
          },
          {
            from: 'assets/SourceHanSansCN-Regular.otf',
            to: 'lib/ruffle/SourceHanSansCN-Regular.otf',
          },
          {
            from: 'assets/SourceHanSans-LICENSE.txt',
            to: 'lib/ruffle/SourceHanSans-LICENSE.txt',
          },
        ],
      }),
    ],
  },
  {
    ...shared,
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload.js',
  },
  {
    ...shared,
    entryPoints: ['src/webview-preload/index.ts'],
    outfile: 'dist/webview-preload.js',
  },
  {
    ...shared,
    entryPoints: ['src/javascript-sandbox-preload/index.ts'],
    outfile: 'dist/javascript-sandbox-preload.js',
  },
  {
    ...shared,
    entryPoints: ['src/main/modules/automation/vision-worker.cjs'],
    outfile: 'dist/vision-worker.cjs',
  },
];

async function run() {
  try {
    if (isWatch) {
      const ctxs = await Promise.all(builds.map((opts) => esbuild.context(opts)));
      await Promise.all(ctxs.map((ctx) => ctx.watch()));
      console.log('[esbuild] watching...');
    } else {
      for (const opts of builds) {
        await esbuild.build(opts);
      }
      console.log('[esbuild] build complete');
    }
  } catch (e) {
    console.error('[esbuild] build failed:', e);
    if (!isWatch) process.exitCode = 1;
  }
}

run();
