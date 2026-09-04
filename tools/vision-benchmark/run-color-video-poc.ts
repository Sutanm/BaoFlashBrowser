import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { performance } from 'perf_hooks';
import {
  extractColorPointSignature,
  matchColorPointSignature,
  type BgraImage,
} from '../../src/main/modules/automation/color-point-matcher';

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
  const templatePath = path.join(corpus, '鱼.png');
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
  const results = [];
  let previousAccepted: { x: number; y: number } | undefined;
  for (const file of selectedFiles) {
    const frame = await load(path.join(framesDirectory, file));
    const startedAt = performance.now();
    const matches = matchColorPointSignature(frame, signature, {
      scales: [.5, .6, .67, .75, 1],
      tolerance: 52,
      threshold,
      maxCandidates: 3,
      region: { x: 350, y: 280, width: 550, height: 380 },
    });
    const elapsedMs = performance.now() - startedAt;
    const margin = matches.length > 1 ? matches[0].score - matches[1].score : matches[0]?.score ?? 0;
    const accepted = Boolean(matches[0] && matches[0].score >= acceptanceScore && margin >= .08);
    const jump = accepted && previousAccepted
      ? Math.hypot(matches[0].x - previousAccepted.x, matches[0].y - previousAccepted.y)
      : undefined;
    if (accepted) previousAccepted = { x: matches[0].x, y: matches[0].y };
    results.push({ file, elapsedMs, accepted, margin, jump, matches });
    console.log(`${file}: ${accepted ? 'ACCEPT' : 'reject'} score=${matches[0]?.score.toFixed(3) ?? 'MISS'} margin=${margin.toFixed(3)} @ ${matches[0]?.x ?? '-'},${matches[0]?.y ?? '-'} ${elapsedMs.toFixed(1)}ms`);
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
    schemaVersion: 1, generatedAt: new Date().toISOString(), framesDirectory, every,
    threshold, acceptanceScore, summary, results,
  }, null, 2)}\n`);
  console.log(`Summary: ${JSON.stringify(summary)}`);
  console.log(`Detailed result: ${output}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
