import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  extractColorPointSignature,
  matchColorPointSignature,
  type BgraImage,
} from '../../src/main/modules/automation/color-point-matcher';
import { calibrateColorPointConfidence } from '../../src/main/modules/automation/color-point-tracker';

const root = path.resolve(__dirname, '..', '..');
const corpus = process.env.BAO_VISION_REAL_CORPUS_DIR
  || path.join(process.env.USERPROFILE || '', 'Desktop', '钓鱼素材包');
const sceneName = process.env.BAO_COLOR_SCALE_SCENE || 'PixPin_2026-09-03_20-28-46.png';
const templateName = process.env.BAO_COLOR_SCALE_TEMPLATE || '鱼.png';
const negativeName = process.env.BAO_COLOR_SCALE_NEGATIVE || 'PixPin_2026-08-29_14-22-25.png';
const tolerance = Math.max(0, Number(process.env.BAO_COLOR_SCALE_TOLERANCE || 70));
const sourceExpected = { x: 761, y: 438 };
const factors = [.75, 1, 1.25] as const;

async function load(file: string): Promise<BgraImage> {
  const decoded = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    const red = decoded.data[offset]; decoded.data[offset] = decoded.data[offset + 2]; decoded.data[offset + 2] = red;
  }
  return { pixels: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

async function resize(source: BgraImage, factor: number, kernel: keyof sharp.KernelEnum): Promise<BgraImage> {
  const width = Math.max(1, Math.round(source.width * factor));
  const height = Math.max(1, Math.round(source.height * factor));
  const output = await sharp(Buffer.from(source.pixels), {
    raw: { width: source.width, height: source.height, channels: 4 },
  }).resize(width, height, { kernel }).raw().toBuffer();
  return { pixels: output, width, height };
}

async function main() {
  const scenePath = path.join(corpus, sceneName);
  const templatePath = path.join(corpus, templateName);
  if (!fs.existsSync(scenePath) || !fs.existsSync(templatePath)) {
    throw new Error(`color scale corpus is incomplete: ${scenePath}, ${templatePath}`);
  }
  const source = await load(scenePath);
  const signature = extractColorPointSignature(await load(templatePath));
  const results = [];
  for (const kernel of ['nearest', 'lanczos3'] as const) {
    for (const factor of factors) {
      const scene = factor === 1 ? source : await resize(source, factor, kernel);
      const matches = matchColorPointSignature(scene, signature, {
        threshold: .2,
        tolerance,
        // The source screenshot establishes a 1.5x reference. Product code
        // obtains the equivalent scale from asset Surface metadata; this gate
        // varies a bounded neighborhood instead of mixing implausible tiny
        // scales into the same uniqueness decision.
        scales: [1.2 * factor, 1.5 * factor, 1.8 * factor],
        maxCandidates: 5,
      });
      const expected = { x: sourceExpected.x * factor, y: sourceExpected.y * factor };
      const best = matches[0];
      const error = best ? Math.hypot(best.x - expected.x, best.y - expected.y) : Number.POSITIVE_INFINITY;
      const calibrated = calibrateColorPointConfidence(matches);
      const accepted = calibrated.confidence >= .9 && calibrated.margin >= .08;
      results.push({ kernel, factor, expected, best, candidates: matches, error, ...calibrated, accepted });
    }
  }
  const nearest = results.filter((result) => result.kernel === 'nearest');
  const nearestScores = nearest.map((result) => result.confidence);
  const scoreSpread = Math.max(...nearestScores) - Math.min(...nearestScores);
  const nearestPassed = nearest.every((result) => result.accepted && result.error <= 35 * result.factor);
  const interpolatedPassed = results
    .filter((result) => result.kernel === 'lanczos3')
    .every((result) => result.accepted && result.error <= 35 * result.factor);
  const negativeScene = await load(path.join(corpus, negativeName));
  const negativeCases = [
    { template: templateName, signature, scales: [.75, 1, 1.25, 1.5] },
    { template: '鱼钩.png', signature: extractColorPointSignature(await load(path.join(corpus, '鱼钩.png'))), scales: [.5, .6, .67, .75, 1] },
  ];
  const negative = negativeCases.map((item) => {
    const candidates = matchColorPointSignature(negativeScene, item.signature, {
      threshold: .2, tolerance, scales: item.scales, maxCandidates: 5,
    });
    const confidence = calibrateColorPointConfidence(candidates);
    return {
      template: item.template,
      rejected: confidence.confidence < .9 || confidence.margin < .08,
      candidates,
      ...confidence,
    };
  });
  const negativeRejected = negative.every((item) => item.rejected);
  const passed = nearestPassed && interpolatedPassed && scoreSpread <= .15 && negativeRejected;
  const summary = {
    passed, tolerance, nearestPassed, interpolatedPassed, nearestScoreSpread: scoreSpread,
    negative: { name: negativeName, rejected: negativeRejected, cases: negative },
    results,
  };
  const output = path.join(root, '.cache', 'vision-benchmark', `color-scale-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, output }, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
