import crypto from 'crypto';
import { nativeImage } from 'electron';
import type { AutomationTemplatePixels, AutomationTemplateProvider } from './vision-worker-matcher';
import { CachingAutomationTemplateProvider, OpenCvWorkerMatcher } from './vision-worker-matcher';
import type { AutomationPackageV3 } from '../../../shared/automation/package-v3';
import { createAutomationAbortController } from '../../../shared/automation/abort-controller';
import { createAutomationOcrEngine } from './ocr-provider';
import type { AutomationOcrEngine } from './capability-contracts';
import { ColorPointWorkerMatcher } from './color-vision-worker-matcher';
import { AutomaticVisionMatcher } from './automatic-vision-matcher';

/**
 * 自动化常驻资源:OpenCV Worker 单例 + OCR Sidecar 预热。
 *
 * WASM 堆是 per-worker 的:为每个包各自 new 一个 Worker 意味着每开一个包就要
 * 重新解析 10MB 的 opencv.js,预热也就无从谈起。因此这里让整个应用共享一个
 * Worker,并通过素材源注册表动态解析模板——模板 cacheKey 是内容 SHA-256,
 * 天然跨包共享,不同包里内容相同的素材只会装载一次。
 */

type RegisteredSource = {
  readonly id: string;
  readonly source: AutomationPackageV3;
};

/** 最近使用的包排在前面;同名素材按此顺序解析,工作台一次只操作一个包。 */
const MAX_REGISTERED_SOURCES = 4;

function normalizeAsset(asset: string): { primary: string; fallback: string } {
  return asset.startsWith('assets/')
    ? { primary: asset, fallback: asset.slice('assets/'.length) }
    : { primary: `assets/${asset}`, fallback: asset };
}

function lookupAsset(source: AutomationPackageV3, asset: string): Uint8Array | undefined {
  const { primary, fallback } = normalizeAsset(asset);
  return source.assets.get(primary) ?? source.assets.get(fallback);
}

class RegistryTemplateProvider implements AutomationTemplateProvider {
  async load(asset: string, signal: AbortSignal): Promise<AutomationTemplatePixels> {
    if (signal.aborted) throw new Error('automation cancelled');
    const sources = registeredSources;
    let bytes: Uint8Array | undefined;
    for (const entry of sources) {
      const found = lookupAsset(entry.source, asset);
      if (found) { bytes = found; break; }
    }
    if (!bytes) throw new Error(`automation asset is missing: ${asset}`);
    if (signal.aborted) throw new Error('automation cancelled');
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) throw new Error(`unable to decode automation image asset: ${asset}`);
    const size = image.getSize();
    return {
      cacheKey: crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
      width: size.width,
      height: size.height,
      bgra: Uint8Array.from(image.toBitmap()),
    };
  }
}

let registeredSources: readonly RegisteredSource[] = [];
let templateProvider: CachingAutomationTemplateProvider | null = null;
let matcher: OpenCvWorkerMatcher | null = null;
let colorMatcher: ColorPointWorkerMatcher | null = null;
let automaticMatcher: AutomaticVisionMatcher | null = null;
let warmupPromise: Promise<void> | null = null;

function ensureTemplateProvider(): CachingAutomationTemplateProvider {
  if (!templateProvider) templateProvider = new CachingAutomationTemplateProvider(new RegistryTemplateProvider());
  return templateProvider;
}

function ensureMatcher(): OpenCvWorkerMatcher {
  if (matcher) return matcher;
  matcher = new OpenCvWorkerMatcher(ensureTemplateProvider());
  return matcher;
}

function ensureColorMatcher(): ColorPointWorkerMatcher {
  if (!colorMatcher) colorMatcher = new ColorPointWorkerMatcher(ensureTemplateProvider());
  return colorMatcher;
}

/** 注册一个包的素材源,最近注册的优先解析。 */
export function registerAutomationAssetSource(id: string, source: AutomationPackageV3): void {
  const retained = registeredSources.filter((entry) => entry.id !== id);
  registeredSources = [{ id, source }, ...retained].slice(0, MAX_REGISTERED_SOURCES);
  // Asset names are package-local, while the shared provider caches by the
  // locator's asset path. Re-registering/reordering sources can therefore make
  // the old bytes stale even when the visible name is unchanged.
  templateProvider?.invalidate();
}

/** 包被删除或重载后移除,避免陈旧素材被解析到。 */
export function unregisterAutomationAssetSource(id: string): void {
  registeredSources = registeredSources.filter((entry) => entry.id !== id);
  templateProvider?.invalidate();
}

export function sharedAutomationVisionMatcher(): OpenCvWorkerMatcher {
  return ensureMatcher();
}

export function sharedAutomationColorMatcher(): ColorPointWorkerMatcher {
  return ensureColorMatcher();
}

export function sharedAutomaticVisionMatcher(): AutomaticVisionMatcher {
  if (!automaticMatcher) automaticMatcher = new AutomaticVisionMatcher(ensureMatcher(), ensureColorMatcher());
  return automaticMatcher;
}

/**
 * 预热 Worker:完成 opencv.js 解析与 WASM 初始化,之后首次识别不再等待加载。
 * 幂等;失败不抛出,由调用方决定是否提示,避免拖慢启动或阻断启动流程。
 */
export async function warmStartAutomationVision(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const startedAt = Date.now();
  try {
    if (!warmupPromise) {
      const signal = createAutomationAbortController().signal;
      warmupPromise = Promise.all([
        ensureMatcher().warmup(signal),
        ensureColorMatcher().warmup(signal),
      ]).then(() => undefined);
    }
    await warmupPromise;
    return { ok: true, ms: Date.now() - startedAt };
  } catch (error) {
    warmupPromise = null;
    return { ok: false, ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 应用退出时释放常驻 Worker。 */
export async function shutdownAutomationVision(): Promise<void> {
  warmupPromise = null;
  registeredSources = [];
  const currentMatcher = matcher;
  const currentColorMatcher = colorMatcher;
  matcher = null;
  colorMatcher = null;
  automaticMatcher = null;
  templateProvider = null;
  await Promise.all([
    currentMatcher?.close(),
    currentColorMatcher?.close(),
  ]);
}

// ---- OCR Sidecar 常驻 ----

let ocrEngine: AutomationOcrEngine | null = null;
let ocrWarmupPromise: Promise<boolean> | null = null;

function ensureOcrEngine(): AutomationOcrEngine {
  if (!ocrEngine) ocrEngine = createAutomationOcrEngine();
  return ocrEngine;
}

export function sharedAutomationOcrEngine(): AutomationOcrEngine {
  return ensureOcrEngine();
}

/**
 * 预热 OCR Sidecar:提前 spawn 子进程并加载 PP-OCRv3 模型。
 * 安装包不含 OCR runtime 时返回 ok:false,这是正常情况而非失败。
 */
export async function warmStartAutomationOcr(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const startedAt = Date.now();
  try {
    if (!ocrWarmupPromise) {
      const engine = ensureOcrEngine();
      ocrWarmupPromise = typeof engine.warmup === 'function'
        ? engine.warmup()
        : Promise.resolve(false);
    }
    const ok = await ocrWarmupPromise;
    return { ok, ms: Date.now() - startedAt };
  } catch (error) {
    ocrWarmupPromise = null;
    return { ok: false, ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function shutdownAutomationOcr(): Promise<void> {
  ocrWarmupPromise = null;
  const current = ocrEngine;
  ocrEngine = null;
  if (current) await current.close?.();
}
