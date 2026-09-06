import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  extractColorPointSignature,
  matchColorPointSignature,
  type BgraImage,
} from '../../src/main/modules/automation/color-point-matcher';
import { calibrateColorPointConfidence } from '../../src/main/modules/automation/color-point-tracker';
import { ColorPointWorkerMatcher } from '../../src/main/modules/automation/color-vision-worker-matcher';
import { AutomaticVisionMatcher } from '../../src/main/modules/automation/automatic-vision-matcher';
import {
  CachingAutomationTemplateProvider,
  OpenCvWorkerMatcher,
  type AutomationTemplatePixels,
} from '../../src/main/modules/automation/vision-worker-matcher';

const root = path.resolve(__dirname, '..', '..');
const corpus = process.env.BAO_VISION_REAL_CORPUS_DIR
  || path.join(process.env.USERPROFILE || '', 'Desktop', '钓鱼素材包');
const generatedCorpus = path.join(root, '.cache', 'vision-benchmark', 'corpus');

type RoutingCase = {
  readonly id: string;
  readonly scene: string;
  readonly template: string;
  readonly present: boolean;
  readonly expected?: { readonly x: number; readonly y: number; readonly radius: number };
  readonly scales: readonly number[];
  readonly source?: 'real' | 'generated';
  readonly threshold?: number;
  readonly mask?: 'none' | 'auto';
};

const defaultCases: readonly RoutingCase[] = [
  // --- Fish / hook (real game, day scenes are web screenshots; night scenes are raw game frames) ---
  { id: 'hook-day-positive', scene: '钓鱼场景-日.png', template: '鱼钩.png', present: true, expected: { x: 1410, y: 365, radius: 45 }, scales: [.5, .6, .67, .75, 1, 1.25, 1.5, 2] },
  { id: 'hook-night-positive', scene: '钓鱼场景-夜.png', template: '鱼钩.png', present: true, expected: { x: 1119, y: 527, radius: 55 }, scales: [.5, .6, .67, .75, 1, 1.25, 1.5, 2, 2.5, 3] },
  { id: 'hook-negative', scene: '钓鱼场景-夜2.png', template: '鱼钩.png', present: false, scales: [.5, .6, .67, .75, 1, 1.25, 1.5, 2] },
  // --- Fish (day web screenshot + night game frame) ---
  { id: 'fish-day-positive', scene: '钓鱼场景-日.png', template: '鱼.png', present: true, expected: { x: 1319, y: 445, radius: 45 }, scales: [.5, .6, .67, .75, 1, 1.25, 1.5] },
  { id: 'fish-negative', scene: '钓鱼场景-夜2.png', template: '鱼.png', present: false, scales: [.5, .75, 1, 1.25, 1.5] },
  // --- Pull lever (day) ---
  { id: 'pull-day-positive', scene: '钓鱼场景-日.png', template: '拉杆.png', present: true, expected: { x: 1481, y: 409, radius: 60 }, scales: [.75, 1, 1.25, 1.5] },
  { id: 'pull-negative', scene: '钓鱼场景-夜2.png', template: '拉杆.png', present: false, scales: [.75, 1, 1.25, 1.5] },
  // --- Drive away / reel (negative in these fishing scenes) ---
  { id: 'reel-negative', scene: '钓鱼场景-夜.png', template: '收线-完整-日.png', present: false, scales: [.75, 1, 1.25, 1.5] },
  { id: 'bite-negative', scene: '钓鱼场景-夜.png', template: '上钩-“赶走”出现.png', present: false, scales: [.75, 1, 1.25, 1.5] },
  { id: 'drive-away-negative', scene: '钓鱼场景-日.png', template: '赶走.png', present: false, scales: [.75, 1, 1.25, 1.5] },
  // --- Character direction: same-source in-game template vs day scene ---
  { id: 'person-night-positive', scene: '场景-夜晚-测试.png', template: '角色-夜晚-测试.png', present: true, expected: { x: 674, y: 502, radius: 55 }, scales: [.75, 1, 1.25, 1.5, 1.75, 2] },
  { id: 'person-day-positive', scene: '钓鱼场景-日.png', template: path.join('人物四方向图', '1.png'), present: true, expected: { x: 1381, y: 515, radius: 60 }, scales: [.75, 1, 1.25, 1.5] },
  { id: 'person-day-negative', scene: '钓鱼场景-夜2.png', template: path.join('人物四方向图', '1.png'), present: false, scales: [.75, 1, 1.25, 1.5] },
  // --- Dino: clean background, shape-unique ---
  { id: 'dino-positive', scene: '谷歌小恐龙游戏场景.png', template: '谷歌小恐龙.png', present: true, expected: { x: 123, y: 129, radius: 6 }, scales: [.75, 1, 1.25, 1.5] },
  { id: 'dino-negative', scene: '钓鱼场景-夜2.png', template: '谷歌小恐龙.png', present: false, scales: [.75, 1, 1.25, 1.5] },
  // --- Generated cases (transparent alpha / low variance / multi-instance / scale / web UI) ---
  { id: 'web-ui-exact', source: 'generated', scene: 'web-ui-scene.png', template: 'web-ui-template.png', present: true, expected: { x: 250, y: 115, radius: 3 }, scales: [1], threshold: .99, mask: 'none' },
  { id: 'transparent-sprite', source: 'generated', scene: 'transparent-scene.png', template: 'transparent-sprite.png', present: true, expected: { x: 213, y: 97, radius: 3 }, scales: [1], threshold: .98 },
  { id: 'low-variance-fallback', source: 'generated', scene: 'low-variance-scene.png', template: 'low-variance.png', present: true, expected: { x: 141, y: 62, radius: 3 }, scales: [1], threshold: .99, mask: 'none' },
  { id: 'scale-nearest-125', source: 'generated', scene: 'scale-scene.png', template: 'scale-template.png', present: true, expected: { x: 174, y: 103, radius: 3 }, scales: [.75, 1, 1.25], threshold: .75, mask: 'none' },
  { id: 'web-ui-linear-125', source: 'generated', scene: 'web-ui-scale-linear-scene.png', template: 'web-ui-template.png', present: true, expected: { x: 117, y: 84, radius: 3 }, scales: [.75, 1, 1.25], threshold: .75, mask: 'none' },
];
const cases: readonly RoutingCase[] = process.env.BAO_ROUTING_SCENE && process.env.BAO_ROUTING_TEMPLATE
  ? [{
    id: 'external-case',
    scene: process.env.BAO_ROUTING_SCENE,
    template: process.env.BAO_ROUTING_TEMPLATE,
    present: process.env.BAO_ROUTING_PRESENT !== '0',
    scales: process.env.BAO_ROUTING_SCALES
      ? process.env.BAO_ROUTING_SCALES.split(',').map(Number).filter((value) => Number.isFinite(value) && value > 0)
      : [.5, .6, .67, .75, .8, 1, 1.25, 1.5, 1.75, 2],
  }]
  : defaultCases;

async function load(file: string): Promise<BgraImage> {
  const decoded = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    const red = decoded.data[offset]; decoded.data[offset] = decoded.data[offset + 2]; decoded.data[offset + 2] = red;
  }
  return { pixels: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

function correct(candidate: { x: number; y: number } | undefined, item: RoutingCase): boolean {
  if (!item.present) return candidate === undefined;
  if (!candidate) return false;
  if (!item.expected) return true;
  return Math.hypot(candidate.x - item.expected.x, candidate.y - item.expected.y) <= item.expected.radius;
}

async function main() {
  if (!fs.existsSync(corpus)) throw new Error(`routing corpus not found: ${corpus}`);
  const images = new Map<string, BgraImage>();
  const get = async (file: string) => {
    let value = images.get(file);
    if (!value) { value = await load(file); images.set(file, value); }
    return value;
  };
  const provider = new CachingAutomationTemplateProvider({
    async load(asset: string): Promise<AutomationTemplatePixels> {
      const value = await get(asset);
      return { cacheKey: asset, width: value.width, height: value.height, bgra: value.pixels };
    },
  });
  const openCv = new OpenCvWorkerMatcher(provider, {
    workerPath: path.join(root, 'src', 'main', 'modules', 'automation', 'vision-worker.cjs'),
    requestTimeoutMs: 60_000,
  });
  const colorWorker = new ColorPointWorkerMatcher(provider, {
    workerPath: path.join(root, '.cache', 'vision-benchmark', 'color-vision-worker.cjs'),
    requestTimeoutMs: 60_000,
  });
  const router = new AutomaticVisionMatcher(openCv, colorWorker);
  await openCv.warmup(new AbortController().signal);
  const results = [];
  try {
    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index];
      const sourceRoot = item.source === 'generated' ? generatedCorpus : corpus;
      const scenePath = path.isAbsolute(item.scene) ? item.scene : path.join(sourceRoot, item.scene);
      const templatePath = path.isAbsolute(item.template) ? item.template : path.join(sourceRoot, item.template);
      const scene = await get(scenePath); const template = await get(templatePath);
      const frame = {
        frameId: index + 1,
        image: { isEmpty: () => false, getSize: () => ({ width: scene.width, height: scene.height }), toBitmap: () => Buffer.from(scene.pixels), toPNG: () => Buffer.alloc(0) },
        bitmap: Buffer.from(scene.pixels), bitmapSize: { width: scene.width, height: scene.height },
        deviceSize: { width: scene.width, height: scene.height }, cssSize: { width: scene.width, height: scene.height },
      };
      const openCandidates = await openCv.findCandidates(templatePath, frame, {
        threshold: -1, scales: [...item.scales], mask: item.mask ?? 'auto', maxCandidates: 5,
      }, new AbortController().signal);
      // Worker candidates are intentionally returned in visual order for
      // overlays. Routing decisions must independently select by confidence.
      const openStrongest = [...openCandidates].sort((left, right) => right.score - left.score)[0];
      const acceptanceThreshold = item.threshold ?? .9;
      const openAccepted = openStrongest?.score !== undefined && openStrongest.score >= acceptanceThreshold
        ? openStrongest : undefined;
      let colorCandidates: ReturnType<typeof matchColorPointSignature> = [];
      let colorError: string | undefined;
      try {
        colorCandidates = matchColorPointSignature(scene, extractColorPointSignature(template), {
          threshold: .2, tolerance: 70, scales: item.scales, maxCandidates: 5,
        });
      } catch (error) { colorError = error instanceof Error ? error.message : String(error); }
      const calibrated = calibrateColorPointConfidence(colorCandidates);
      const colorAccepted = calibrated.confidence >= acceptanceThreshold && calibrated.margin >= .08
        ? { ...colorCandidates[0], score: calibrated.confidence } : undefined;
      const routedCandidates = await router.findCandidates(templatePath, frame, {
        threshold: acceptanceThreshold,
        scales: [...item.scales],
        mask: item.mask ?? 'auto',
        maxCandidates: 1,
      }, new AbortController().signal);
      const route = routedCandidates[0];
      const result = {
        ...item,
        openCv: { accepted: openAccepted, strongest: openStrongest, correct: correct(openAccepted, item) },
        color: { accepted: colorAccepted, strongest: colorCandidates[0], ...calibrated, error: colorError, correct: correct(colorAccepted, item) },
        route: {
          backend: route?.algorithm === 'color-points' ? 'color' : route ? 'template' : 'reject',
          accepted: route,
          correct: correct(route, item),
        },
      };
      results.push(result);
      console.log(`${item.id}: expected=${item.present ? 'present' : 'absent'} open=${openAccepted?.score.toFixed(3) ?? 'reject'}/${result.openCv.correct ? 'OK' : 'BAD'} color=${colorAccepted?.score.toFixed(3) ?? 'reject'}/${result.color.correct ? 'OK' : 'BAD'} route=${result.route.backend}/${result.route.correct ? 'OK' : 'BAD'}`);
    }
  } finally { await Promise.all([openCv.close(), colorWorker.close()]); }
  const summary = {
    cases: results.length,
    openCvCorrect: results.filter((item) => item.openCv.correct).length,
    colorCorrect: results.filter((item) => item.color.correct).length,
    routedCorrect: results.filter((item) => item.route.correct).length,
  };
  const output = path.join(root, '.cache', 'vision-benchmark', `routing-poc-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  fs.writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, corpus, summary, results }, null, 2)}\n`);
  console.log(`Summary: ${JSON.stringify(summary)}`);
  console.log(`Detailed result: ${output}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
