import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { performance } from 'perf_hooks';
import {
  extractColorPointSignature,
  type BgraImage,
} from '../../src/main/modules/automation/color-point-matcher';
import { ColorPointTracker } from '../../src/main/modules/automation/color-point-tracker';

const root = path.resolve(__dirname, '..', '..');
const corpus = process.env.BAO_VISION_REAL_CORPUS_DIR
  || path.join(process.env.USERPROFILE || '', 'Desktop', '钓鱼素材包');
const framesDirectory = process.env.BAO_COLOR_VIDEO_FRAMES
  || path.join(root, '.cache', 'probe', 'frames2');
const every = Math.max(1, Math.floor(Number(process.env.BAO_COLOR_VIDEO_EVERY || 8)));
const startFrame = Math.max(1, Math.floor(Number(process.env.BAO_COLOR_VIDEO_START || 1)));
const endFrame = Math.max(startFrame, Math.floor(Number(process.env.BAO_COLOR_VIDEO_END || Number.MAX_SAFE_INTEGER)));
const threshold = Math.min(1, Math.max(0, Number(process.env.BAO_COLOR_VIDEO_THRESHOLD || .15)));
const acceptanceScore = Math.min(1, Math.max(0, Number(process.env.BAO_COLOR_VIDEO_ACCEPTANCE || .28)));
const minimumMargin = Math.min(1, Math.max(0, Number(process.env.BAO_COLOR_VIDEO_MARGIN || .08)));
const templateName = process.env.BAO_COLOR_VIDEO_TEMPLATE || '鱼.png';

function numberList(value: string | undefined, fallback: readonly number[]): number[] {
  if (!value) return [...fallback];
  const parsed = value.split(',').map(Number).filter((entry) => Number.isFinite(entry) && entry > 0);
  if (parsed.length === 0) throw new Error(`invalid numeric list: ${value}`);
  return parsed;
}

function parseRegion(value: string | undefined) {
  if (!value) return { x: 350, y: 280, width: 550, height: 380 };
  const [x, y, width, height] = value.split(',').map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error(`invalid BAO_COLOR_VIDEO_REGION, expected x,y,width,height: ${value}`);
  }
  return { x, y, width, height };
}

const scales = numberList(process.env.BAO_COLOR_VIDEO_SCALES, [.5, .6, .67, .75, 1]);
const initialRegion = parseRegion(process.env.BAO_COLOR_VIDEO_REGION);
const trackingPadding = Math.max(1, Math.floor(Number(process.env.BAO_COLOR_VIDEO_TRACKING_PADDING || 18)));

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
  const templatePath = path.join(corpus, templateName);
  if (!fs.existsSync(templatePath)) throw new Error(`template not found: ${templatePath}`);
  if (!fs.existsSync(framesDirectory)) throw new Error(`video frames not found: ${framesDirectory}`);
  const files = fs.readdirSync(framesDirectory)
    .filter((file) => file.toLowerCase().endsWith('.png'))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
  const selectedFiles = files.filter((_file, index) => {
    const frameNumber = index + 1;
    return frameNumber >= startFrame && frameNumber <= endFrame && (frameNumber - startFrame) % every === 0;
  });
  const signature = extractColorPointSignature(await load(templatePath));
  const tracker = new ColorPointTracker(signature, {
    scales,
    tolerance: 52,
    threshold,
    maxCandidates: 3,
    initialRegion,
    trackingPadding,
    minimumScore: acceptanceScore,
    minimumMargin,
  });
  const results = [];
  let previousAccepted: { x: number; y: number } | undefined;
  for (const file of selectedFiles) {
    const frame = await load(path.join(framesDirectory, file));
    const startedAt = performance.now();
    const trackingResult = tracker.match(frame);
    const elapsedMs = performance.now() - startedAt;
    const matches = trackingResult.best ? [trackingResult.best] : [];
    const { margin, accepted } = trackingResult;
    const jump = accepted && previousAccepted
      ? Math.hypot(matches[0].x - previousAccepted.x, matches[0].y - previousAccepted.y)
      : undefined;
    if (accepted) previousAccepted = { x: matches[0].x, y: matches[0].y };
    results.push({ file, elapsedMs, accepted, margin, jump, matches, tracking: trackingResult.tracking, reacquired: trackingResult.reacquired });
    console.log(`${file}: ${accepted ? 'ACCEPT' : 'reject'} score=${matches[0]?.score.toFixed(3) ?? 'MISS'} margin=${margin.toFixed(3)} @ ${matches[0]?.x ?? '-'},${matches[0]?.y ?? '-'} ${trackingResult.tracking ? 'track' : trackingResult.reacquired ? 'reacquire' : 'initial'} ${elapsedMs.toFixed(1)}ms`);
  }
  const times = results.map((result) => result.elapsedMs);
  const accepted = results.filter((result) => result.accepted);
  const jumps = accepted.map((result) => result.jump).filter((jump): jump is number => jump !== undefined);
  const summary = {
    sampledFrames: results.length,
    acceptedFrames: accepted.length,
    p50Ms: percentile(times, .5),
    p95Ms: percentile(times, .95),
    maximumAcceptedJump: jumps.length ? Math.max(...jumps) : null,
  };
  const output = path.join(root, '.cache', 'vision-benchmark', `color-video-poc-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(output, `${JSON.stringify({
    schemaVersion: 2, generatedAt: new Date().toISOString(), framesDirectory, every,
    templateName, scales, initialRegion, trackingPadding, threshold, acceptanceScore, minimumMargin, summary, results,
  }, null, 2)}\n`);
  console.log(`Summary: ${JSON.stringify(summary)}`);
  console.log(`Detailed result: ${output}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
