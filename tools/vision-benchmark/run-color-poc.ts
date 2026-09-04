import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { performance } from 'perf_hooks';
import {
  extractColorPointSignature,
  matchColorPointSignature,
  type BgraImage,
  type ColorPointMatchOptions,
} from '../../src/main/modules/automation/color-point-matcher';
import { CachingAutomationTemplateProvider, OpenCvWorkerMatcher, type AutomationTemplatePixels } from '../../src/main/modules/automation/vision-worker-matcher';

const root = path.resolve(__dirname, '..', '..');
const corpus = process.env.BAO_VISION_REAL_CORPUS_DIR
  || path.join(process.env.USERPROFILE || '', 'Desktop', '钓鱼素材包');
const rounds = Math.max(1, Number(process.env.BAO_COLOR_POC_ROUNDS || 5));
const colorThreshold = Math.min(1, Math.max(0, Number(process.env.BAO_COLOR_POC_THRESHOLD || .35)));

async function load(file: string): Promise<BgraImage> {
  const decoded = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    const red = decoded.data[offset]; decoded.data[offset] = decoded.data[offset + 2]; decoded.data[offset + 2] = red;
  }
  return { pixels: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

type BenchmarkCase = {
  readonly id: string;
  readonly scene: string;
  readonly template: string;
  readonly scales: readonly number[];
  readonly expected?: { readonly x: number; readonly y: number };
  readonly region?: ColorPointMatchOptions['region'];
};

const cases: BenchmarkCase[] = [
  {
    id: 'fish-full-2132', scene: '钓鱼场景.png', template: '鱼.png',
    scales: [.35, .4, .45, .5, .55, .6, .65, .67, .7, .75, 1],
    expected: { x: 1049, y: 679 },
  },
  {
    id: 'fish-game-1422', scene: 'PixPin_2026-09-03_20-28-46.png', template: '鱼.png',
    scales: [.35, .4, .45, .5, .55, .6, .65, .67, .7, .75, 1],
    expected: { x: 761, y: 438 },
  },
  {
    id: 'fish-game-roi', scene: 'PixPin_2026-09-03_20-28-46.png', template: '鱼.png',
    scales: [.35, .4, .45, .5, .55, .6, .65, .67, .7, .75, 1],
    expected: { x: 761, y: 438 }, region: { x: 700, y: 380, width: 180, height: 150 },
  },
  {
    id: 'fish-negative-1418', scene: 'PixPin_2026-08-29_14-22-25.png', template: '鱼.png',
    scales: [.35, .4, .45, .5, .55, .6, .65, .67, .7, .75, 1],
  },
  {
    id: 'hook-ambiguous-1422', scene: 'PixPin_2026-09-03_20-28-46.png', template: '鱼钩.png',
    scales: [.5, .6, .67, .75, 1],
  },
  {
    id: 'hook-roi-1422', scene: 'PixPin_2026-09-03_20-28-46.png', template: '鱼钩.png',
    scales: [.5, .6, .67, .75, 1], region: { x: 700, y: 300, width: 160, height: 150 },
  },
  {
    id: 'hook-negative-1418', scene: 'PixPin_2026-08-29_14-22-25.png', template: '鱼钩.png',
    scales: [.5, .6, .67, .75, 1],
  },
];

async function main() {
  if (!fs.existsSync(corpus)) throw new Error(`real vision corpus not found: ${corpus}`);
  const loadedTemplates = new Map<string, BgraImage>();
  const provider = new CachingAutomationTemplateProvider({
    async load(asset: string): Promise<AutomationTemplatePixels> {
      let image = loadedTemplates.get(asset);
      if (!image) { image = await load(path.join(corpus, asset)); loadedTemplates.set(asset, image); }
      return { cacheKey: asset, width: image.width, height: image.height, bgra: image.pixels };
    },
  });
  const openCv = new OpenCvWorkerMatcher(provider, {
    workerPath: path.join(root, 'src', 'main', 'modules', 'automation', 'vision-worker.cjs'),
    requestTimeoutMs: 60_000,
  });
  await openCv.warmup(new AbortController().signal);
  const results = [];
  try {
    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index];
      const scene = await load(path.join(corpus, item.scene));
      const template = await load(path.join(corpus, item.template));
      const signature = extractColorPointSignature(template);
      loadedTemplates.set(item.template, template);
      const colorTimes: number[] = []; let colorMatches = matchColorPointSignature(scene, signature, {
        scales: item.scales, tolerance: 52, threshold: colorThreshold, maxCandidates: 5, region: item.region,
      });
      for (let round = 0; round < rounds; round += 1) {
        const startedAt = performance.now();
        colorMatches = matchColorPointSignature(scene, signature, {
          scales: item.scales, tolerance: 52, threshold: colorThreshold, maxCandidates: 5, region: item.region,
        });
        colorTimes.push(performance.now() - startedAt);
      }
      const frame = {
        frameId: index + 1,
        image: { isEmpty: () => false, getSize: () => ({ width: scene.width, height: scene.height }), toBitmap: () => Buffer.from(scene.pixels), toPNG: () => Buffer.alloc(0) },
        bitmap: Buffer.from(scene.pixels), bitmapSize: { width: scene.width, height: scene.height },
        deviceSize: { width: scene.width, height: scene.height }, cssSize: { width: scene.width, height: scene.height },
      };
      const runOpenCv = async () => {
        const startedAt = performance.now();
        const matches = await openCv.findCandidates(item.template, frame, {
          threshold: -1, scales: [...item.scales], mask: 'auto', maxCandidates: 5, region: item.region,
        }, new AbortController().signal);
        return { matches, elapsedMs: performance.now() - startedAt };
      };
      await runOpenCv();
      const openCvRuns = [];
      for (let round = 0; round < rounds; round += 1) openCvRuns.push(await runOpenCv());
      const openCvMatches = openCvRuns[openCvRuns.length - 1].matches;
      const openCvTimes = openCvRuns.map((run) => run.elapsedMs);
      const result = {
        id: item.id, scene: item.scene, template: item.template, expected: item.expected, region: item.region,
        color: { p50Ms: percentile(colorTimes, .5), p95Ms: percentile(colorTimes, .95), matches: colorMatches },
        openCv: { p50Ms: percentile(openCvTimes, .5), p95Ms: percentile(openCvTimes, .95), matches: openCvMatches.map(({ x, y, width, height, score, scale, algorithm }) => ({ x, y, width, height, score, scale, algorithm })) },
      };
      results.push(result);
      const margin = colorMatches.length > 1 ? colorMatches[0].score - colorMatches[1].score : colorMatches[0]?.score ?? 0;
      const accepted = Boolean(colorMatches[0] && colorMatches[0].score >= .55 && margin >= .08);
      console.log(`${item.id}: color=${colorMatches[0]?.score.toFixed(3) ?? 'MISS'} margin=${margin.toFixed(3)} accepted=${accepted} @ ${colorMatches[0]?.x ?? '-'},${colorMatches[0]?.y ?? '-'} p95=${result.color.p95Ms.toFixed(1)}ms; OpenCV=${openCvMatches[0]?.score.toFixed(3) ?? 'MISS'} @ ${openCvMatches[0]?.x ?? '-'},${openCvMatches[0]?.y ?? '-'} p95=${result.openCv.p95Ms.toFixed(1)}ms`);
    }
  } finally {
    await openCv.close();
  }
  const output = path.join(root, '.cache', 'vision-benchmark', `color-poc-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), corpus, rounds, colorThreshold, results }, null, 2)}\n`);
  console.log(`Detailed result: ${output}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
