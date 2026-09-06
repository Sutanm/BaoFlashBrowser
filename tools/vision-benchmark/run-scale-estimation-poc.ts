import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import sharp from 'sharp';
import type { AutomationCapturedFrame, ImageMatch } from '../../src/main/modules/automation/capability-contracts';
import { ColorPointWorkerMatcher } from '../../src/main/modules/automation/color-vision-worker-matcher';
import {
  OpenCvWorkerMatcher,
  type AutomationTemplatePixels,
} from '../../src/main/modules/automation/vision-worker-matcher';

type Pixels = { readonly pixels: Buffer; readonly width: number; readonly height: number };
type TimedMatch = { readonly match: ImageMatch; readonly elapsedMs: number; readonly workerMs: number };

const root = path.resolve(__dirname, '..', '..');
const corpus = process.env.BAO_VISION_REAL_CORPUS_DIR
  || path.join(process.env.USERPROFILE || '', 'Desktop', '钓鱼素材包');
const outputDirectory = path.join(root, '.cache', 'vision-benchmark');
// Keep the normal pass inside the useful browser-zoom range. Very small
// templates produce spuriously high normalized OpenCV peaks, so <0.5 and >2
// belong to an explicit miss-only recovery pass rather than scale discovery.
const coarseScales = geometricScales(0.5, 2, 1.15);
const refinementFactors = [0.88, 0.94, 0.97, 1, 1.03, 1.06, 1.12] as const;

const cases = [
  { id: 'hook', template: '鱼钩.png', expected: { x: 1410, y: 365, radius: 50 } },
  { id: 'fish', template: '鱼.png', expected: { x: 1319, y: 445, radius: 50 } },
  { id: 'pull', template: '拉杆.png', expected: { x: 1481, y: 409, radius: 65 } },
  { id: 'person', template: path.join('人物四方向图', '1.png'), expected: { x: 1381, y: 515, radius: 65 } },
] as const;

function geometricScales(minimum: number, maximum: number, ratio: number): number[] {
  const values: number[] = [];
  for (let value = minimum; value <= maximum * 1.0001; value *= ratio) values.push(value);
  return values.map((value) => Number(value.toFixed(5)));
}

function uniqueScales(values: readonly number[]): number[] {
  return [...new Set(values
    .filter((value) => Number.isFinite(value) && value >= 0.1 && value <= 4)
    .map((value) => Number(value.toFixed(5))))];
}

async function load(file: string): Promise<Pixels> {
  const decoded = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    const red = decoded.data[offset]; decoded.data[offset] = decoded.data[offset + 2]; decoded.data[offset + 2] = red;
  }
  return { pixels: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

async function resize(source: string, factor: number): Promise<Pixels> {
  const metadata = await sharp(source).metadata();
  const width = Math.max(1, Math.round((metadata.width || 1) * factor));
  const height = Math.max(1, Math.round((metadata.height || 1) * factor));
  const decoded = await sharp(source).resize(width, height, { kernel: 'nearest' }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    const red = decoded.data[offset]; decoded.data[offset] = decoded.data[offset + 2]; decoded.data[offset + 2] = red;
  }
  return { pixels: decoded.data, width, height };
}

function frame(image: Pixels, frameId: number): AutomationCapturedFrame {
  return {
    frameId,
    image: {
      isEmpty: () => false,
      getSize: () => ({ width: image.width, height: image.height }),
      toBitmap: () => Buffer.from(image.pixels),
      toPNG: () => Buffer.alloc(0),
    },
    bitmap: image.pixels,
    bitmapSize: { width: image.width, height: image.height },
    deviceSize: { width: image.width, height: image.height },
    cssSize: { width: image.width, height: image.height },
  };
}

async function atScale(
  matcher: OpenCvWorkerMatcher,
  asset: string,
  scene: AutomationCapturedFrame,
  scale: number,
): Promise<TimedMatch> {
  const startedAt = performance.now();
  const candidates = await matcher.findCandidates(asset, scene, {
    threshold: -1,
    scales: [scale],
    mask: 'auto',
    maxCandidates: 1,
  }, new AbortController().signal);
  const elapsedMs = performance.now() - startedAt;
  const match = candidates[0];
  if (!match) throw new Error(`scale ${scale} produced no candidate for ${asset}`);
  return { match, elapsedMs, workerMs: match.matchMs ?? 0 };
}

async function search(
  matcher: OpenCvWorkerMatcher,
  asset: string,
  scene: AutomationCapturedFrame,
  scales: readonly number[],
): Promise<{ readonly best: TimedMatch; readonly elapsedMs: number; readonly attempts: number }> {
  const startedAt = performance.now();
  const attempts: TimedMatch[] = [];
  for (const scale of uniqueScales(scales)) attempts.push(await atScale(matcher, asset, scene, scale));
  if (attempts.length === 0) throw new Error(`scale search has no usable attempts for ${asset}`);
  return {
    best: attempts.reduce((best, current) => current.match.score > best.match.score ? current : best),
    elapsedMs: performance.now() - startedAt,
    attempts: attempts.length,
  };
}

async function estimate(
  matcher: OpenCvWorkerMatcher,
  asset: string,
  scene: AutomationCapturedFrame,
) {
  const startedAt = performance.now();
  const coarse = await search(matcher, asset, scene, coarseScales);
  const rankedCenters = [coarse.best.match.scale || 1];
  const fineScales = uniqueScales(rankedCenters.flatMap((center) => refinementFactors.map((factor) => center * factor)))
    .filter((scale) => scale >= 0.5 && scale <= 2);
  const fine = await search(matcher, asset, scene, fineScales);
  const best = fine.best.match.score >= coarse.best.match.score ? fine.best : coarse.best;
  return {
    match: best.match,
    elapsedMs: performance.now() - startedAt,
    coarseMs: coarse.elapsedMs,
    fineMs: fine.elapsedMs,
    attempts: coarse.attempts + fine.attempts,
  };
}

function isCorrect(match: ImageMatch, expected: { x: number; y: number; radius: number }, zoom = 1): boolean {
  return Math.hypot(match.x - expected.x * zoom, match.y - expected.y * zoom) <= expected.radius * zoom;
}

async function main() {
  const scenePath = path.join(corpus, '钓鱼场景-日.png');
  if (!fs.existsSync(scenePath)) throw new Error(`scale corpus not found: ${scenePath}`);
  const templates = new Map<string, Pixels>();
  const provider = {
    async load(asset: string): Promise<AutomationTemplatePixels> {
      const value = templates.get(asset);
      if (!value) throw new Error(`unknown benchmark asset: ${asset}`);
      return { cacheKey: asset, width: value.width, height: value.height, bgra: value.pixels };
    },
  };
  const matcher = new OpenCvWorkerMatcher(provider, {
    workerPath: path.join(root, 'src', 'main', 'modules', 'automation', 'vision-worker.cjs'),
    requestTimeoutMs: 60_000,
  });
  const colorMatcher = new ColorPointWorkerMatcher(provider, {
    workerPath: path.join(outputDirectory, 'color-vision-worker.cjs'),
    requestTimeoutMs: 60_000,
  });
  const originalScene = await load(scenePath);
  await Promise.all([
    matcher.warmup(new AbortController().signal),
    colorMatcher.warmup(new AbortController().signal),
  ]);
  const authoredAtOnePointFive = [];
  const zoomSequence = [];
  let nextFrameId = 1;
  try {
    // External screenshots contain no authoring metadata. Enlarge each real
    // material by 1.5x and verify that content search can recover the inverse
    // runtime scale without being told the source zoom.
    for (const item of cases) {
      const templatePath = path.join(corpus, item.template);
      const asset = `${item.id}@author-1.5`;
      templates.set(asset, await resize(templatePath, 1.5));
      const currentFrame = frame(originalScene, nextFrameId++);
      const result = await estimate(matcher, asset, currentFrame);
      const colorStartedAt = performance.now();
      const colorMatches = await colorMatcher.findCandidates(asset, currentFrame, {
        threshold: 0,
        scales: coarseScales,
        maxCandidates: 1,
      }, new AbortController().signal);
      const colorElapsedMs = performance.now() - colorStartedAt;
      const colorMatch = colorMatches[0];
      authoredAtOnePointFive.push({
        id: item.id,
        expectedInverseFactor: 1 / 1.5,
        correctLocation: isCorrect(result.match, item.expected),
        colorProposal: colorMatch && {
          match: colorMatch,
          elapsedMs: colorElapsedMs,
          correctLocation: isCorrect(colorMatch, item.expected),
        },
        ...result,
      });
      console.log(`[author 1.5 -> runtime 1.0] ${item.id}: OpenCV scale=${result.match.scale?.toFixed(4)} score=${result.match.score.toFixed(4)} correct=${isCorrect(result.match, item.expected)} cold=${result.elapsedMs.toFixed(1)}ms; color scale=${colorMatch?.scale?.toFixed(4) ?? '-'} correct=${colorMatch ? isCorrect(colorMatch, item.expected) : false} ${colorElapsedMs.toFixed(1)}ms`);
    }

    // Once one content scale has been learned, a later page-zoom change has a
    // known relative ratio even though the original PNG has no metadata. This
    // sequence measures a 3-scale local refinement around that migrated value.
    const item = cases.find((value) => value.id === 'person')!;
    const asset = 'person@runtime-zoom-sequence';
    templates.set(asset, await load(path.join(corpus, item.template)));
    let previousZoom: number | undefined;
    let previousScale: number | undefined;
    for (const zoom of [1, 1.5, 1, 0.75, 1.25]) {
      const scenePixels = zoom === 1 ? originalScene : await resize(scenePath, zoom);
      const currentFrame = frame(scenePixels, nextFrameId++);
      const cold = await estimate(matcher, asset, currentFrame);
      const colorStartedAt = performance.now();
      const colorMatch = (await colorMatcher.findCandidates(asset, currentFrame, {
        threshold: 0,
        scales: coarseScales,
        maxCandidates: 1,
      }, new AbortController().signal))[0];
      const colorElapsedMs = performance.now() - colorStartedAt;
      const migratedCenter = previousScale === undefined || previousZoom === undefined
        ? cold.match.scale || 1
        : previousScale * zoom / previousZoom;
      const local = await search(matcher, asset, currentFrame, [migratedCenter * 0.97, migratedCenter, migratedCenter * 1.03]);
      zoomSequence.push({
        zoom,
        migratedCenter,
        cold: { ...cold, correctLocation: isCorrect(cold.match, item.expected, zoom) },
        local: { ...local, correctLocation: isCorrect(local.best.match, item.expected, zoom) },
        colorProposal: colorMatch && { match: colorMatch, elapsedMs: colorElapsedMs, correctLocation: isCorrect(colorMatch, item.expected, zoom) },
      });
      console.log(`[runtime zoom ${previousZoom ?? '-'} -> ${zoom}] cold scale=${cold.match.scale?.toFixed(4)} ${cold.elapsedMs.toFixed(1)}ms; migrated scale=${local.best.match.scale?.toFixed(4)} ${local.elapsedMs.toFixed(1)}ms correct=${isCorrect(local.best.match, item.expected, zoom)}; color scale=${colorMatch?.scale?.toFixed(4) ?? '-'} ${colorElapsedMs.toFixed(1)}ms correct=${colorMatch ? isCorrect(colorMatch, item.expected, zoom) : false}`);
      previousZoom = zoom;
      previousScale = local.best.match.scale;
    }
  } finally {
    await Promise.all([matcher.close(), colorMatcher.close()]);
  }

  const summary = {
    authoredCases: authoredAtOnePointFive.length,
    authoredCorrect: authoredAtOnePointFive.filter((item) => item.correctLocation).length,
    authoredColdMeanMs: authoredAtOnePointFive.reduce((sum, item) => sum + item.elapsedMs, 0) / authoredAtOnePointFive.length,
    authoredColorCorrect: authoredAtOnePointFive.filter((item) => item.colorProposal?.correctLocation).length,
    authoredColorMeanMs: authoredAtOnePointFive.reduce((sum, item) => sum + (item.colorProposal?.elapsedMs ?? 0), 0) / authoredAtOnePointFive.length,
    zoomCases: zoomSequence.length,
    zoomColdCorrect: zoomSequence.filter((item) => item.cold.correctLocation).length,
    zoomMigratedCorrect: zoomSequence.filter((item) => item.local.correctLocation).length,
    zoomColdMeanMs: zoomSequence.reduce((sum, item) => sum + item.cold.elapsedMs, 0) / zoomSequence.length,
    zoomMigratedMeanMs: zoomSequence.reduce((sum, item) => sum + item.local.elapsedMs, 0) / zoomSequence.length,
    zoomColorCorrect: zoomSequence.filter((item) => item.colorProposal?.correctLocation).length,
    zoomColorMeanMs: zoomSequence.reduce((sum, item) => sum + (item.colorProposal?.elapsedMs ?? 0), 0) / zoomSequence.length,
  };
  const output = path.join(outputDirectory, `scale-estimation-poc-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  fs.writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, corpus, coarseScales, refinementFactors, summary, authoredAtOnePointFive, zoomSequence }, null, 2)}\n`);
  console.log(`Summary: ${JSON.stringify(summary)}`);
  console.log(`Detailed result: ${output}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
