import esbuild from 'esbuild';
import { copy } from 'esbuild-plugin-copy';
import fs from 'fs';
import path from 'path';
import { moduleDefines, moduleSummary, parseModules } from './build/module-flags.mjs';
import { nativeAssistantModule } from './build/native-assistant-i18n.mjs';

const isWatch = process.argv.includes('--watch');
const modules = parseModules();
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
  plugins: [{
    name: 'native-automation-ui',
    setup(build) {
      build.onResolve({ filter: /\.user\.js\?native$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?native$/, '')), namespace: 'native-automation-ui' }));
      build.onLoad({ filter: /.*/, namespace: 'native-automation-ui' }, args => ({
        contents: nativeAssistantModule(fs.readFileSync(args.path, 'utf8')),
        loader: 'js', watchFiles: [args.path],
      }));
    },
  }],
  logLevel: 'info',
  define: moduleDefines(modules),
  // Compile-time module guards only become removable branches when syntax
  // folding is enabled. Identifier/tree shaking alone keeps guarded IIFEs and
  // their dependency graphs in the bundle.
  minifySyntax: true,
  banner: { js: provenanceBanner },
};

const builds = [
  {
    ...shared,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main.js',
    plugins: [
      ...shared.plugins,
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
    // DevTools 前端专用：只暴露 CDP 桥（不含 electronAPI）。见 src/preload/devtools.ts。
    ...shared,
    entryPoints: ['src/preload/devtools.ts'],
    outfile: 'dist/devtools-preload.js',
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
  ...(modules.has('automation') ? [{
    ...shared,
    entryPoints: ['src/main/modules/automation/vision-worker.cjs'],
    outfile: 'dist/vision-worker.cjs',
  }, {
    ...shared,
    entryPoints: ['src/main/modules/automation/color-vision-worker.ts'],
    outfile: 'dist/color-vision-worker.cjs',
  }] : []),
];

async function run() {
  try {
    if (!isWatch && !modules.has('automation')) {
      fs.rmSync('dist/vision-worker.cjs', { force: true });
      fs.rmSync('dist/color-vision-worker.cjs', { force: true });
    }
    if (isWatch) {
      const ctxs = await Promise.all(builds.map((opts) => esbuild.context(opts)));
      await Promise.all(ctxs.map((ctx) => ctx.watch()));
      console.log('[esbuild] watching...');
    } else {
      for (const opts of builds) {
        await esbuild.build(opts);
      }
      console.log(`[esbuild] build complete (modules: ${moduleSummary(modules)})`);
    }
  } catch (e) {
    console.error('[esbuild] build failed:', e);
    if (!isWatch) process.exitCode = 1;
  }
}

run();
