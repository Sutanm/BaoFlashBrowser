/**
 * 给任意 OCR 引擎套一层"同一幅画面只识别一次"的装饰器。
 *
 * 为什么是装饰器而不是改调用点：
 * - OCR 引擎的接口只有 `recognize / warmup / close`，包一层就能生效；
 *   不需要动 41 KB 的 `browserview-core-session.ts`，回归面最小。
 * - 等待文字出现时，画面绝大多数轮次是静止的，而一次 Paddle 识别是 100–400 ms。
 *   同一幅画面的重复识别是纯浪费。
 *
 * 判定"同一幅画面"用帧指纹（`frame-fingerprint`）：对整帧 BGRA 做稀疏采样，
 * 720p 约 0.18 ms，相对一次识别可以忽略。
 *
 * 注意：
 * - 只缓存**成功**结果；抛错不进缓存，避免把一次超时固化下来。
 * - 返回的是深拷贝，调用方修改结果不会污染缓存。
 * - 没有 bitmap 的帧（理论上不会出现）直接透传，不缓存。
 */

import type { AutomationCapturedFrame, AutomationOcrEngine, OcrTextItem } from './capability-contracts';
import { adaptiveFingerprintStride, frameFingerprint } from './frame-fingerprint';
import { ObservationCache, observationKey } from './observation-cache';

export type CachingOcrEngineOptions = {
  /** 观察的最长可信年龄（毫秒）。默认 500。 */
  readonly maxAgeMs?: number;
  /** 最多缓存多少条观察。默认 32。 */
  readonly maxEntries?: number;
  /** 计时源，便于测试注入。默认 `performance.now`。 */
  readonly now?: () => number;
};

function copyItems(items: readonly OcrTextItem[]): OcrTextItem[] {
  return items.map((item) => ({
    text: item.text,
    score: item.score,
    box: item.box.map((point) => [point[0], point[1]] as [number, number]),
  }));
}

export class CachingOcrEngine implements AutomationOcrEngine {
  readonly providerId?: string;
  private readonly cache: ObservationCache;
  private readonly now: () => number;

  constructor(
    private readonly inner: AutomationOcrEngine,
    options: CachingOcrEngineOptions = {},
  ) {
    this.providerId = inner.providerId;
    this.cache = new ObservationCache({
      maxAgeMs: options.maxAgeMs ?? 500,
      maxEntries: options.maxEntries ?? 32,
    });
    this.now = options.now ?? (() => performance.now());
  }

  async recognize(frame: AutomationCapturedFrame, signal: AbortSignal): Promise<OcrTextItem[]> {
    const bitmap = frame.bitmap;
    const size = frame.bitmapSize;
    if (!bitmap || !size) return copyItems(await this.inner.recognize(frame, signal));

    const stride = adaptiveFingerprintStride(size.width, size.height);
    const fingerprint = frameFingerprint(bitmap, size.width, size.height, stride);
    const key = observationKey({ kind: 'ocr', width: size.width, height: size.height });
    const cached = this.cache.get<OcrTextItem[]>(key, fingerprint, this.now());
    if (cached) return copyItems(cached);

    const items = await this.inner.recognize(frame, signal);
    const snapshot = copyItems(items);
    this.cache.set(key, fingerprint, snapshot, this.now());
    return copyItems(snapshot);
  }

  async warmup(): Promise<boolean> {
    if (!this.inner.warmup) return false;
    return this.inner.warmup();
  }

  async close(): Promise<void> {
    this.cache.clear();
    if (this.inner.close) await this.inner.close();
  }
}
