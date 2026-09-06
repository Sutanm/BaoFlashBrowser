import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import sharp from 'sharp';
import type { BgraImage } from '../../src/main/modules/automation/color-point-matcher';
import { ColorPointWorkerMatcher } from '../../src/main/modules/automation/color-vision-worker-matcher';
import type { AutomationCapturedFrame } from '../../src/main/modules/automation/capability-contracts';
import type { AutomationTemplatePixels } from '../../src/main/modules/automation/vision-worker-matcher';

const root = path.resolve(__dirname, '..', '..');
const corpus = process.env.BAO_VISION_REAL_CORPUS_DIR || path.join(process.env.USERPROFILE || '', 'Desktop', '钓鱼素材包');
const framesDirectory = process.env.BAO_FISHING_HOOK_FRAMES || path.join(root, '.cache', 'probe', 'frames');
const expectedLastPresent = Math.max(1, Number(process.env.BAO_FISHING_HOOK_PRESENT_END || 86));
const expectedFirstAbsent = Math.max(expectedLastPresent + 1, Number(process.env.BAO_FISHING_HOOK_ABSENT_START || 89));
const scales = [.5, .6, 1 / 1.5, .75, 1];

async function load(file: string): Promise<BgraImage> {
  const decoded = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    const red = decoded.data[offset]; decoded.data[offset] = decoded.data[offset + 2]; decoded.data[offset + 2] = red;
  }
  return { pixels: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function main() {
  if (!fs.existsSync(framesDirectory)) throw new Error(`fishing frames not found: ${framesDirectory}`);
  const templatePath = path.join(corpus, '鱼钩.png');
  if (!fs.existsSync(templatePath)) throw new Error(`fishing hook template not found: ${templatePath}`);
  const template = await load(templatePath);
  const provider = { async load(): Promise<AutomationTemplatePixels> {
    return { cacheKey: templatePath, width: template.width, height: template.height, bgra: template.pixels };
  } };
  const matcher = new ColorPointWorkerMatcher(provider, {
    workerPath: path.join(__dirname, 'color-vision-worker.cjs'), requestTimeoutMs: 60_000,
  });
  const files = fs.readdirSync(framesDirectory).filter((file) => file.endsWith('.png'))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
  const results = [];
  try {
    for (const file of files) {
      const frameNumber = Number(file.match(/\d+/)?.[0] ?? 0);
      const image = await load(path.join(framesDirectory, file));
      const frame: AutomationCapturedFrame = {
        frameId: frameNumber,
        image: { isEmpty: () => false, getSize: () => ({ width: image.width, height: image.height }), toPNG: () => Buffer.alloc(0), toBitmap: () => Buffer.from(image.pixels) },
        bitmap: Buffer.from(image.pixels), bitmapSize: { width: image.width, height: image.height },
        deviceSize: { width: image.width, height: image.height }, cssSize: { width: image.width, height: image.height },
      };
      const startedAt = performance.now();
      const match = await matcher.find('hook.png', frame, { threshold: .9, scales }, new AbortController().signal);
      results.push({ frame: frameNumber, file, elapsedMs: performance.now() - startedAt, match });
    }
  } finally { await matcher.close(); }
  const positives = results.filter((result) => result.frame <= expectedLastPresent);
  const negatives = results.filter((result) => result.frame >= expectedFirstAbsent);
  const detectedPresentFrames = positives.filter((result) => result.match).length;
  const summary = {
    frames: results.length,
    expectedPresentFrames: positives.length,
    detectedPresentFrames,
    presentRecall: detectedPresentFrames / Math.max(1, positives.length),
    expectedAbsentFrames: negatives.length,
    falsePositiveFrames: negatives.filter((result) => result.match).length,
    p50Ms: percentile(results.map((result) => result.elapsedMs), .5),
    p95Ms: percentile(results.map((result) => result.elapsedMs), .95),
  };
  const passed = summary.presentRecall >= .95 && summary.falsePositiveFrames === 0 && summary.p95Ms <= 100;
  const output = path.join(root, '.cache', 'vision-benchmark', `fishing-hook-gate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(output, `${JSON.stringify({ schemaVersion: 4, generatedAt: new Date().toISOString(), framesDirectory, templatePath, scales, passed, summary, results }, null, 2)}\n`);
  console.log(JSON.stringify({ passed, summary }, null, 2));
  console.log(`Detailed result: ${output}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
