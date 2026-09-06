import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import sharp from 'sharp';
import type { AutomationCapturedFrame } from '../../src/main/modules/automation/capability-contracts';
import { ColorPointWorkerMatcher } from '../../src/main/modules/automation/color-vision-worker-matcher';
import type { AutomationTemplatePixels } from '../../src/main/modules/automation/vision-worker-matcher';
import { createColorPointSceneIndex } from '../../src/main/modules/automation/color-point-matcher';

type Pixels = { readonly pixels: Buffer; readonly width: number; readonly height: number };
const root = path.resolve(__dirname, '..', '..');
const corpus = process.env.BAO_VISION_REAL_CORPUS_DIR
  || path.join(process.env.USERPROFILE || '', 'Desktop', '钓鱼素材包');
const assetNames = [
  '鱼钩.png', '鱼.png', '鱼-二次扣图.png', '拉杆.png',
  '收线-完整-日.png', '收线-完整-夜.png', '收线-仅线圈.png', '收线-仅字体.png',
] as const;
const scales = [.5, .6, 2 / 3, .75, .8, 1, 1.25, 1.5, 1.75, 2];

async function load(file: string): Promise<Pixels> {
  const decoded = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    const red = decoded.data[offset]; decoded.data[offset] = decoded.data[offset + 2]; decoded.data[offset + 2] = red;
  }
  return { pixels: decoded.data, width: decoded.info.width, height: decoded.info.height };
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

async function main() {
  const scenePath = path.join(corpus, '钓鱼场景-日.png');
  const missing = [scenePath, ...assetNames.map((asset) => path.join(corpus, asset))].filter((file) => !fs.existsSync(file));
  if (missing.length > 0) throw new Error(`color group corpus is incomplete: ${missing.join(', ')}`);
  const scene = await load(scenePath);
  const sceneIndexStarted = performance.now();
  createColorPointSceneIndex({ pixels: scene.pixels, width: scene.width, height: scene.height });
  const sceneIndexMs = performance.now() - sceneIndexStarted;
  const templates = new Map<string, Pixels>();
  for (const asset of assetNames) templates.set(asset, await load(path.join(corpus, asset)));
  const provider = {
    async load(asset: string): Promise<AutomationTemplatePixels> {
      const value = templates.get(asset);
      if (!value) throw new Error(`unknown benchmark asset: ${asset}`);
      return { cacheKey: asset, width: value.width, height: value.height, bgra: value.pixels };
    },
  };
  const matcher = new ColorPointWorkerMatcher(provider, {
    workerPath: path.join(root, '.cache', 'vision-benchmark', 'color-vision-worker.cjs'),
    requestTimeoutMs: 60_000,
    parallelGroupWorkers: Number(process.env.BAO_COLOR_GROUP_WORKERS ?? 4),
  });
  const signal = new AbortController().signal;
  try {
    await matcher.preload(assetNames, signal);
    const groupStarted = performance.now();
    const group = await matcher.findManyCandidatesWithSupport(
      [...assetNames], frame(scene, 1), { threshold: -1, scales, maxCandidates: assetNames.length }, signal,
    );
    const groupMs = performance.now() - groupStarted;

    let repeatedFrameMs = 0;
    const sequentialAssetMs: Array<{ asset: string; ms: number }> = [];
    const sequentialMatches = [];
    const sequentialUnsupported: string[] = [];
    for (const asset of assetNames) {
      const started = performance.now();
      const result = await matcher.findManyCandidatesWithSupport(
        [asset], frame(scene, 2), { threshold: -1, scales, maxCandidates: 1 }, signal,
      );
      const elapsed = performance.now() - started;
      repeatedFrameMs += elapsed;
      sequentialAssetMs.push({ asset, ms: elapsed });
      sequentialMatches.push(...result.matches);
      sequentialUnsupported.push(...result.unsupportedAssets);
    }

    let independentFrameMs = 0;
    for (const [index, asset] of assetNames.entries()) {
      const started = performance.now();
      await matcher.findManyCandidatesWithSupport([asset], frame(scene, 100 + index), { threshold: -1, scales, maxCandidates: 1 }, signal);
      independentFrameMs += performance.now() - started;
    }

    const expectedByAsset = new Map(sequentialMatches.map((match) => [match.asset, match]));
    const groupIsEquivalent = group.matches.every((match) => {
      const expected = expectedByAsset.get(match.asset);
      return expected !== undefined
        && expected.x === match.x && expected.y === match.y
        && expected.scale === match.scale && Math.abs(expected.score - match.score) < 1e-9;
    }) && group.matches.length === sequentialMatches.length
      && [...group.unsupportedAssets].sort().join('\0') === sequentialUnsupported.sort().join('\0');
    const result = {
      passed: group.matches.length > 0 && groupIsEquivalent,
      groupIsEquivalent,
      assets: assetNames.length,
      supported: assetNames.length - group.unsupportedAssets.length,
      groupMs,
      sceneIndexMs,
      repeatedFrameMs,
      sequentialAssetMs,
      independentFrameMs,
      groupMatches: group.matches.map((match) => ({
        asset: match.asset, score: match.score, x: match.x, y: match.y, scale: match.scale,
      })),
      unsupportedAssets: group.unsupportedAssets,
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } finally {
    await matcher.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
