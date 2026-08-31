import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/modules/automation/paddle-ocr-sidecar-engine', () => ({
  bundledPaddleOcrSidecarAvailable: () => ['win32', 'linux'].includes(process.platform),
  PaddleOcrSidecarEngine: class { readonly providerId = 'paddle-inference-ppocrv3'; },
}));

import { createAutomationOcrEngine } from '../src/main/modules/automation/ocr-provider';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
});

describe('OCR provider platform policy', () => {
  it('selects Paddle Inference on Windows', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    expect(createAutomationOcrEngine().providerId).toBe('paddle-inference-ppocrv3');
  });

  it('selects Paddle Inference by default on Linux', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    expect(createAutomationOcrEngine().providerId).toBe('paddle-inference-ppocrv3');
  });

  it('reports OCR unavailable on unsupported platforms', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    expect(createAutomationOcrEngine().providerId).toBe('unavailable');
  });
});
