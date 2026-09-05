import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import sharp from 'sharp';
import { ColorColumnTracker } from '../../src/main/modules/automation/color-column-tracker';
import type { BgraImage } from '../../src/main/modules/automation/color-point-matcher';

const root = path.resolve(__dirname, '..', '..');
const framesDirectory = process.env.BAO_FISHING_HOOK_FRAMES || path.join(root, '.cache', 'probe', 'frames');
const expectedLastPresent = Math.max(1, Number(process.env.BAO_FISHING_HOOK_PRESENT_END || 86));
const expectedFirstAbsent = Math.max(expectedLastPresent + 1, Number(process.env.BAO_FISHING_HOOK_ABSENT_START || 89));

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
  const files = fs.readdirSync(framesDirectory).filter((file) => file.endsWith('.png'))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
  const tracker = new ColorColumnTracker({
    // BGR values from the three hook-only brown/yellow/orange groups.
    colors: [[0, 48, 80], [0, 224, 240], [0, 160, 240]],
    expectedX: 135,
    xRadius: 7,
    region: { x: 110, y: 35, width: 55, height: 135 },
    tolerance: 52,
    minimumPixels: 6,
    maximumRowGap: 2,
    maximumFrameJump: 18,
  });
  const results = [];
  for (const file of files) {
    const frameNumber = Number(file.match(/\d+/)?.[0] ?? 0);
    const frame = await load(path.join(framesDirectory, file));
    const startedAt = performance.now();
    const signal = tracker.match(frame);
    results.push({ frame: frameNumber, file, elapsedMs: performance.now() - startedAt, signal });
  }
  const positives = results.filter((result) => result.frame <= expectedLastPresent);
  const negatives = results.filter((result) => result.frame >= expectedFirstAbsent);
  const truePositives = positives.filter((result) => result.signal).length;
  const falsePositives = negatives.filter((result) => result.signal).length;
  const presentSignals = positives.flatMap((result) => result.signal ? [result.signal] : []);
  const summary = {
    frames: results.length,
    expectedPresentFrames: positives.length,
    detectedPresentFrames: truePositives,
    presentRecall: truePositives / Math.max(1, positives.length),
    expectedAbsentFrames: negatives.length,
    falsePositiveFrames: falsePositives,
    p50Ms: percentile(results.map((result) => result.elapsedMs), .5),
    p95Ms: percentile(results.map((result) => result.elapsedMs), .95),
    minimumCenterY: Math.min(...presentSignals.map((signal) => signal.centerY)),
    maximumCenterY: Math.max(...presentSignals.map((signal) => signal.centerY)),
  };
  const passed = summary.presentRecall >= .98 && summary.falsePositiveFrames === 0 && summary.p95Ms <= 5;
  const output = path.join(root, '.cache', 'vision-benchmark', `fishing-hook-gate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), framesDirectory, passed, summary, results }, null, 2)}\n`);
  console.log(JSON.stringify({ passed, summary }, null, 2));
  console.log(`Detailed result: ${output}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
