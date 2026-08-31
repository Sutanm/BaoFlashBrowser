import type { AutomationOcrEngine } from './capability-contracts';
import { bundledPaddleOcrSidecarAvailable, PaddleOcrSidecarEngine } from './paddle-ocr-sidecar-engine';

class UnavailableOcrEngine implements AutomationOcrEngine {
  readonly providerId = 'unavailable';
  async recognize(): Promise<never> { throw new Error('当前安装的是标准版，不包含 OCR；请安装 BaoFlashBrowser OCR 版'); }
  async close(): Promise<void> { /* no process */ }
}

export type AutomationOcrProviderPreference = 'auto' | 'paddle';

export function createAutomationOcrEngine(preference: AutomationOcrProviderPreference = 'auto'): AutomationOcrEngine {
  if ((preference === 'auto' || preference === 'paddle') && bundledPaddleOcrSidecarAvailable()) return new PaddleOcrSidecarEngine();
  return new UnavailableOcrEngine();
}
