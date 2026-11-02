import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/modules/automation/paddle-ocr-sidecar-engine', () => ({
  bundledPaddleOcrSidecarAvailable: () => ['win32', 'linux'].includes(process.platform) && process.arch === 'x64',
  PaddleOcrSidecarEngine: class { readonly providerId = 'paddle-inference-ppocrv3'; },
}));

vi.mock('../src/main/modules/automation/tesseract-ocr-sidecar-engine', () => ({
  bundledTesseractOcrAvailable: () => process.platform === 'win32' && process.arch === 'ia32',
  TesseractOcrSidecarEngine: class { readonly providerId = 'tesseract-5.3.0-x86'; },
}));

import { createAutomationOcrEngine } from '../src/main/modules/automation/ocr-provider';

const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

afterEach(() => {
  if (originalArch) Object.defineProperty(process, 'arch', originalArch);
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
});

describe('OCR provider platform policy', () => {
  it('selects Tesseract only on Windows ia32, respecting an explicit Paddle preference', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    Object.defineProperty(process, 'arch', { configurable: true, value: 'ia32' });
    expect(createAutomationOcrEngine().providerId).toBe('tesseract-5.3.0-x86');
    expect(createAutomationOcrEngine('paddle').providerId).toBe('unavailable');
  });

  it('does not select Tesseract on Linux ia32', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    Object.defineProperty(process, 'arch', { configurable: true, value: 'ia32' });
    expect(createAutomationOcrEngine().providerId).toBe('unavailable');
  });
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
