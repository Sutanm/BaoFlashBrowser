import type { AutomationOcrEngine } from './capability-contracts';
import { CachingOcrEngine } from './caching-ocr-engine';
import { OBSERVATION_CACHE_ENV, isObservationCacheEnabled } from './observation-cache';
import { bundledPaddleOcrSidecarAvailable, PaddleOcrSidecarEngine } from './paddle-ocr-sidecar-engine';
import { bundledTesseractOcrAvailable, TesseractOcrSidecarEngine } from './tesseract-ocr-sidecar-engine';

class UnavailableOcrEngine implements AutomationOcrEngine {
  readonly providerId = 'unavailable';
  // Runtime fallback only: every official 1.1.2 package bundles an OCR engine.
  // This fires for custom builds, unsupported architectures, or a stripped runtime.
  async recognize(): Promise<never> { throw new Error('当前安装包未包含 OCR 运行时；请安装带 OCR 的完整安装包'); }
  async close(): Promise<void> { /* no process */ }
}

export type AutomationOcrProviderPreference = 'auto' | 'paddle' | 'tesseract';

/** 兼容旧引用：开关常量已统一到 observation-cache。 */
export { OBSERVATION_CACHE_ENV };

export function createAutomationOcrEngine(preference: AutomationOcrProviderPreference = 'auto'): AutomationOcrEngine {
  let engine: AutomationOcrEngine;
  if ((preference === 'auto' || preference === 'tesseract') && bundledTesseractOcrAvailable()) engine = new TesseractOcrSidecarEngine();
  else if ((preference === 'auto' || preference === 'paddle') && bundledPaddleOcrSidecarAvailable()) engine = new PaddleOcrSidecarEngine();
  else return new UnavailableOcrEngine();
  return isObservationCacheEnabled() ? new CachingOcrEngine(engine) : engine;
}
