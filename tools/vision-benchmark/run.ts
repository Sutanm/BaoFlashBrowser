import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import type { AutomationCapturedFrame, ImageMatch } from '../../src/main/modules/automation/capability-contracts';
import { AutomationVisionService } from '../../src/main/modules/automation/vision-service';
import {
  CachingAutomationTemplateProvider,
  OpenCvWorkerMatcher,
  type AutomationTemplatePixels,
  type AutomationTemplateProvider,
} from '../../src/main/modules/automation/vision-worker-matcher';

type Box = { asset: string; x: number; y: number; width: number; height: number };
type Sample = {
  id: string;
  suite: string;
  scene: string;
  templates: string[];
  threshold: number;
  scales: number[];
  mask: 'auto' | 'none' | 'alpha';
  maxCandidates?: number;
  region?: { x: number; y: number; width: number; height: number };
  expected: Box[];
  tolerance: number;
  source?: string;
};

type RawFrameDescriptor = { file: string; width: number; height: number };
type CorpusManifest = { schemaVersion: number; generatedAt: string; rawFrames: Record<string, RawFrameDescriptor>; samples: Sample[] };
type LoadedImage = { pixels: Buffer; width: number; height: number };

const root = path.resolve(__dirname, '..', '..');
const corpusRoot = path.resolve(process.argv[2] || path.join(root, '.cache', 'vision-benchmark', 'corpus'));
const rounds = Math.max(1, Number(process.env.BAO_VISION_BENCHMARK_ROUNDS || 10));
const warmups = Math.max(0, Number(process.env.BAO_VISION_BENCHMARK_WARMUPS || 2));
const templateUpscaleInterpolation = process.env.BAO_VISION_BENCHMARK_UPSCALE === 'linear' ? 'linear' : 'nearest';

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

let rawFrames: Record<string, RawFrameDescriptor> = {};

async function loadBgra(file: string): Promise<LoadedImage> {
  const key = path.relative(corpusRoot, file).replace(/\\/g, '/');
  const descriptor = rawFrames[key];
  if (!descriptor) throw new Error(`raw frame is missing from manifest: ${key}`);
  const pixels = fs.readFileSync(path.join(corpusRoot, descriptor.file));
  if (pixels.byteLength !== descriptor.width * descriptor.height * 4) throw new Error(`invalid BGRA byte length: ${key}`);
  return { pixels, width: descriptor.width, height: descriptor.height };
}

class CorpusTemplateProvider implements AutomationTemplateProvider {
  private readonly cache = new Map<string, AutomationTemplatePixels>();

  async load(asset: string): Promise<AutomationTemplatePixels> {
    const existing = this.cache.get(asset);
    if (existing) return existing;
    const file = path.join(corpusRoot, asset);
    const image = await loadBgra(file);
    const stat = fs.statSync(file);
    const loaded = { cacheKey: `${asset}:${stat.size}:${stat.mtimeMs}`, width: image.width, height: image.height, bgra: image.pixels };
    this.cache.set(asset, loaded);
    return loaded;
  }
}

function capturedFrame(image: LoadedImage, frameId: number): AutomationCapturedFrame {
  return {
    frameId,
    image: {
      isEmpty: () => false,
      getSize: () => ({ width: image.width, height: image.height }),
      toBitmap: () => image.pixels,
      toPNG: () => Buffer.alloc(0),
    },
    bitmap: image.pixels,
    bitmapSize: { width: image.width, height: image.height },
    deviceSize: { width: image.width, height: image.height },
    cssSize: { width: image.width, height: image.height },
  };
}

function boxError(actual: ImageMatch, expected: Box): number {
  return Math.max(
    Math.abs(actual.x - expected.x),
    Math.abs(actual.y - expected.y),
    Math.abs(actual.width - expected.width),
    Math.abs(actual.height - expected.height),
  );
}

function evaluate(sample: Sample, matches: readonly ImageMatch[]) {
  const remaining = [...matches];
  const errors: number[] = [];
  let matchedExpected = 0;
  for (const expected of sample.expected) {
    let bestIndex = -1; let bestError = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      if ((remaining[index].asset ?? sample.templates[0]) !== expected.asset) continue;
      const error = boxError(remaining[index], expected);
      if (error < bestError) { bestError = error; bestIndex = index; }
    }
    if (bestIndex >= 0 && bestError <= sample.tolerance) {
      matchedExpected += 1;
      errors.push(bestError);
      remaining.splice(bestIndex, 1);
    }
  }
  return {
    passed: matchedExpected === sample.expected.length && remaining.length === 0,
    matchedExpected,
    expectedCount: sample.expected.length,
    unexpectedCount: remaining.length,
    maximumPositionError: errors.length ? Math.max(...errors) : 0,
  };
}

async function runSample(
  service: AutomationVisionService,
  sample: Sample,
  frame: AutomationCapturedFrame,
) {
  const request = { assets: sample.templates, threshold: sample.threshold, scales: sample.scales, mask: sample.mask, region: sample.region };
  const candidateBudget = sample.maxCandidates ?? Math.max(1, sample.expected.length);
  const invoke = async () => {
    const startedAt = performance.now();
    const matches = await service.locateCandidates(frame, request, new AbortController().signal, candidateBudget);
    return { latencyMs: performance.now() - startedAt, matches };
  };
  const cold = await invoke();
  for (let index = 0; index < warmups; index += 1) await invoke();
  const warm = [];
  for (let index = 0; index < rounds; index += 1) warm.push(await invoke());
  const evaluation = evaluate(sample, warm[warm.length - 1].matches);
  const diagnostic = warm[warm.length - 1].matches.length === 0 || sample.expected.length === 0
    ? await service.locate(frame, { ...request, threshold: -1 }, new AbortController().signal)
    : warm[warm.length - 1].matches[0] ?? null;
  const latencies = warm.map((item) => item.latencyMs);
  const scores = warm.flatMap((item) => item.matches.map((match) => match.score));
  const representative = warm[warm.length - 1].matches[0];
  const statsSource = representative ?? diagnostic;
  return {
    id: sample.id,
    suite: sample.suite,
    source: sample.source ?? 'repository-generated',
    sceneSize: frame.bitmapSize,
    templates: sample.templates,
    threshold: sample.threshold,
    scales: sample.scales,
    region: sample.region,
    ...evaluation,
    coldRequestMs: cold.latencyMs,
    warmLatencyMs: { mean: mean(latencies), p50: percentile(latencies, .5), p95: percentile(latencies, .95) },
    score: scores.length ? { minimum: Math.min(...scores), maximum: Math.max(...scores), drift: Math.max(...scores) - Math.min(...scores) } : null,
    algorithm: statsSource?.algorithm ?? null,
    upscaleInterpolation: statsSource?.upscaleInterpolation ?? null,
    strongestCandidate: diagnostic ? {
      asset: diagnostic.asset,
      x: diagnostic.x,
      y: diagnostic.y,
      width: diagnostic.width,
      height: diagnostic.height,
      score: diagnostic.score,
      scale: diagnostic.scale,
      algorithm: diagnostic.algorithm,
      upscaleInterpolation: diagnostic.upscaleInterpolation,
      thresholdMargin: diagnostic.score - sample.threshold,
    } : null,
    matchTemplateMs: statsSource?.matchTemplateMs ?? null,
    scaleMatchTimings: statsSource?.scaleMatchTimings ?? null,
    assetMatchTimings: statsSource?.assetMatchTimings ?? null,
    sceneTransferBytes: statsSource?.sceneTransferBytes ?? null,
    wasmHeapBytes: statsSource?.wasmHeapBytes ?? null,
    matches: warm[warm.length - 1].matches.map((match) => ({ asset: match.asset, x: match.x, y: match.y, width: match.width, height: match.height, score: match.score, scale: match.scale, algorithm: match.algorithm })),
  };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(corpusRoot, 'manifest.json'), 'utf8')) as CorpusManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.samples) || manifest.samples.length === 0) throw new Error('invalid or empty vision benchmark manifest');
  rawFrames = manifest.rawFrames;
  const provider = new CachingAutomationTemplateProvider(new CorpusTemplateProvider(), 128);
  const matcher = new OpenCvWorkerMatcher(provider, {
    workerPath: path.join(root, 'src', 'main', 'modules', 'automation', 'vision-worker.cjs'),
    requestTimeoutMs: 60_000,
    maxCacheEntries: 128,
    maxCacheBytes: 256 * 1024 * 1024,
    templateUpscaleInterpolation,
  });
  const service = new AutomationVisionService(matcher);
  const startupStartedAt = performance.now();
  await matcher.warmup(new AbortController().signal);
  const workerStartupMs = performance.now() - startupStartedAt;
  const results = [];
  let frameId = 10_000;
  try {
    for (const sample of manifest.samples) {
      const image = await loadBgra(path.join(corpusRoot, sample.scene));
      const result = await runSample(service, sample, capturedFrame(image, frameId++));
      results.push(result);
      console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.id.padEnd(24)} cold=${result.coldRequestMs.toFixed(1)}ms warm-p95=${result.warmLatencyMs.p95.toFixed(1)}ms error=${result.maximumPositionError}px`);
    }
  } finally {
    await matcher.close();
  }
  const suites = Object.fromEntries([...new Set(results.map((item) => item.suite))].map((suite) => {
    const subset = results.filter((item) => item.suite === suite);
    return [suite, { samples: subset.length, passed: subset.filter((item) => item.passed).length, warmP95Ms: percentile(subset.map((item) => item.warmLatencyMs.p95), .95) }];
  }));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    opencv: require('@techstark/opencv-js/package.json').version,
    templateUpscaleInterpolation,
    corpus: corpusRoot,
    rounds,
    warmups,
    workerStartupMs,
    processRssBytes: process.memoryUsage().rss,
    samples: results.length,
    passed: results.filter((item) => item.passed).length,
    suites,
    results,
  };
  const outputFile = path.join(root, '.cache', 'vision-benchmark', `result-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Summary: ${report.passed}/${report.samples} passed · worker startup ${workerStartupMs.toFixed(1)}ms · RSS ${(report.processRssBytes / 1048576).toFixed(1)}MiB`);
  console.log(`Detailed result: ${outputFile}`);
  if (report.passed !== report.samples && process.env.BAO_VISION_BENCHMARK_GATE === '1') process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
