import { describe, expect, it } from 'vitest';
import type { AutomationCapturedFrame, AutomationOcrEngine, OcrTextItem } from '../src/main/modules/automation/capability-contracts';
import { CachingOcrEngine } from '../src/main/modules/automation/caching-ocr-engine';

function frameOf(values: readonly number[], width = values.length): AutomationCapturedFrame {
  const bitmap = Buffer.alloc(width * 4);
  values.forEach((value, index) => {
    bitmap[index * 4] = value;
    bitmap[index * 4 + 1] = value;
    bitmap[index * 4 + 2] = value;
    bitmap[index * 4 + 3] = 255;
  });
  return {
    image: { isEmpty: () => false, getSize: () => ({ width, height: 1 }), toPNG: () => Buffer.alloc(0), toBitmap: () => bitmap },
    bitmap,
    bitmapSize: { width, height: 1 },
    deviceSize: { width, height: 1 },
    cssSize: { width, height: 1 },
  };
}

class CountingEngine implements AutomationOcrEngine {
  readonly providerId = 'counting';
  calls = 0;
  warmups = 0;
  closes = 0;
  constructor(private readonly items: OcrTextItem[] = [{ text: 'hello', score: 0.9, box: [[0, 0], [1, 0], [1, 1], [0, 1]] }]) {}
  async recognize(): Promise<OcrTextItem[]> {
    this.calls += 1;
    return this.items.map((item) => ({ ...item }));
  }
  async warmup(): Promise<boolean> { this.warmups += 1; return true; }
  async close(): Promise<void> { this.closes += 1; }
}

const signal = new AbortController().signal;

describe('caching OCR engine', () => {
  it('同一幅画面只真正识别一次', async () => {
    const inner = new CountingEngine();
    const engine = new CachingOcrEngine(inner);
    const frame = frameOf([1, 2, 3, 4]);
    const first = await engine.recognize(frame, signal);
    const second = await engine.recognize(frameOf([1, 2, 3, 4]), signal);
    expect(inner.calls).toBe(1);
    expect(second).toEqual(first);
  });

  it('画面一变就重新识别', async () => {
    const inner = new CountingEngine();
    const engine = new CachingOcrEngine(inner);
    await engine.recognize(frameOf([1, 2, 3, 4]), signal);
    await engine.recognize(frameOf([1, 2, 3, 9]), signal);
    expect(inner.calls).toBe(2);
  });

  it('过期的缓存不再复用', async () => {
    const inner = new CountingEngine();
    let clock = 0;
    const engine = new CachingOcrEngine(inner, { maxAgeMs: 100, now: () => clock });
    const frame = frameOf([5, 5, 5]);
    await engine.recognize(frame, signal);
    clock = 50;
    await engine.recognize(frame, signal);
    expect(inner.calls).toBe(1);
    clock = 101;
    await engine.recognize(frame, signal);
    expect(inner.calls).toBe(2);
  });

  it('返回的是副本，调用方改结果不会污染缓存', async () => {
    const inner = new CountingEngine();
    const engine = new CachingOcrEngine(inner);
    const frame = frameOf([7, 7]);
    const first = await engine.recognize(frame, signal);
    first[0].text = 'mutated';
    const second = await engine.recognize(frame, signal);
    expect(second[0].text).toBe('hello');
  });

  it('warmup / close / providerId 原样透传', async () => {
    const inner = new CountingEngine();
    const engine = new CachingOcrEngine(inner);
    expect(engine.providerId).toBe('counting');
    expect(await engine.warmup?.()).toBe(true);
    await engine.close?.();
    expect(inner.warmups).toBe(1);
    expect(inner.closes).toBe(1);
  });

  it('没有 bitmap 的帧不进缓存，直接透传', async () => {
    const inner = new CountingEngine();
    const engine = new CachingOcrEngine(inner);
    const frame = { ...frameOf([1]), bitmap: undefined } as unknown as AutomationCapturedFrame;
    await engine.recognize(frame, signal);
    await engine.recognize(frame, signal);
    expect(inner.calls).toBe(2);
  });

  it('识别失败不写缓存', async () => {
    let attempts = 0;
    const inner: AutomationOcrEngine = {
      providerId: 'flaky',
      async recognize() {
        attempts += 1;
        if (attempts === 1) throw new Error('ocr exploded');
        return [];
      },
    };
    const engine = new CachingOcrEngine(inner);
    const frame = frameOf([3, 3]);
    await expect(engine.recognize(frame, signal)).rejects.toThrow('ocr exploded');
    await expect(engine.recognize(frame, signal)).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });
});
