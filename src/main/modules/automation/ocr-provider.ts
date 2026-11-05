import type { AutomationOcrEngine } from './capability-contracts';
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

export function createAutomationOcrEngine(preference: AutomationOcrProviderPreference = 'auto'): AutomationOcrEngine {
  if ((preference === 'auto' || preference === 'tesseract') && bundledTesseractOcrAvailable()) return new TesseractOcrSidecarEngine();
  if ((preference === 'auto' || preference === 'paddle') && bundledPaddleOcrSidecarAvailable()) return new PaddleOcrSidecarEngine();
  return new UnavailableOcrEngine();
}
