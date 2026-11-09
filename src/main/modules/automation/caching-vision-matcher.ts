/**
 * 给任意视觉匹配器套一层"同一幅画面、同一个查询，只算一次"的缓存。
 *
 * 为什么放在装饰器里而不是改 vision-worker：
 * - 匹配器的对外接口只有几个方法，包一层就能生效，不用碰 41 KB 的 session、调度器和 worker 协议；
 * - 开关是环境变量，出问题一行回滚；
 * - 缓存的是**结果**，算法本身（含 pyramid、scale 搜索）以后怎么改都不用重新设计缓存。
 *
 * 判定"同一幅画面"用帧指纹：优先只对查询区域做（把背景动画排除在外），
 * 区域拿不到就退回整帧。
 *
 * 注意：
 * - 命中与否都缓存，包括 null / 空数组——"没找到"也是结论。
 * - 返回的是副本，调用方改结果不会污染缓存。
 * - 已中止的信号直接抛错，不读缓存（与内层 `findManyCandidates` 的语义一致）。
 */

import type {
  AutomationCapabilityRegion,
  AutomationCapturedFrame,
  AutomationImageMask,
  AutomationVisionMatcher,
  ImageMatch,
} from './capability-contracts';
import { adaptiveFingerprintStride, regionFingerprint, type FingerprintRegion } from './frame-fingerprint';
import { ObservationCache, observationKey } from './observation-cache';

export type CachingVisionMatcherOptions = {
  /** 观察的最长可信年龄（毫秒）。默认 500。 */
  readonly maxAgeMs?: number;
  /** 最多缓存多少条观察。默认 256（一次流程里查询种类多）。 */
  readonly maxEntries?: number;
  /** 计时源，便于测试注入。默认 `performance.now`。 */
  readonly now?: () => number;
};

type MatchOptions = {
  readonly threshold: number;
  readonly region?: AutomationCapabilityRegion;
  readonly scales?: number[];
  readonly mask?: AutomationImageMask;
  readonly maxCandidates?: number;
};

function copyMatch(value: ImageMatch): ImageMatch {
  return { ...value };
}

function copyList(value: readonly ImageMatch[]): ImageMatch[] {
  return value.map(copyMatch);
}

export class CachingVisionMatcher implements AutomationVisionMatcher {
  readonly find: AutomationVisionMatcher['find'];
  readonly findMany?: AutomationVisionMatcher['findMany'];
  readonly findCandidates?: AutomationVisionMatcher['findCandidates'];
  readonly findManyCandidates?: AutomationVisionMatcher['findManyCandidates'];
  readonly getStats?: AutomationVisionMatcher['getStats'];

  private readonly cache: ObservationCache;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly inner: AutomationVisionMatcher,
    options: CachingVisionMatcherOptions = {},
  ) {
    this.cache = new ObservationCache({
      maxAgeMs: options.maxAgeMs ?? 500,
      maxEntries: options.maxEntries ?? 256,
    });
    this.now = options.now ?? (() => performance.now());

    this.find = (asset, frame, request, signal) =>
      this.resolve<ImageMatch | null>(
        'find', [asset], frame, request, signal,
        () => this.inner.find(asset, frame, request, signal),
        (value) => (value ? copyMatch(value) : value),
      );

    if (inner.findMany) {
      const findMany = inner.findMany.bind(inner);
      this.findMany = (assets, frame, request, signal) =>
        this.resolve<ImageMatch | null>(
          'findMany', assets, frame, request, signal,
          () => findMany(assets, frame, request, signal),
          (value) => (value ? copyMatch(value) : value),
        );
    }
    if (inner.findCandidates) {
      const findCandidates = inner.findCandidates.bind(inner);
      this.findCandidates = (asset, frame, request, signal) =>
        this.resolve<readonly ImageMatch[]>(
          'findCandidates', [asset], frame, request, signal,
          () => findCandidates(asset, frame, request, signal),
          copyList,
        );
    }
    if (inner.findManyCandidates) {
      const findManyCandidates = inner.findManyCandidates.bind(inner);
      this.findManyCandidates = (assets, frame, request, signal) =>
        this.resolve<readonly ImageMatch[]>(
          'findManyCandidates', assets, frame, request, signal,
          () => findManyCandidates(assets, frame, request, signal),
          copyList,
        );
    }
    if (inner.getStats) {
      const getStats = inner.getStats.bind(inner);
      this.getStats = () => getStats();
    }
  }

  /** 命中 / 未命中计数，用来验证缓存命中率是否足够高。 */
  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  /**
   * 关闭内层匹配器（如果它有 close）。
   * 会话在 `ownsMatcher` 为真时会调用它，所以装饰器必须把这个能力保住。
   */
  async close(): Promise<void> {
    this.cache.clear();
    const closable = this.inner as AutomationVisionMatcher & { close?: () => Promise<void> };
    if (closable.close) await closable.close();
  }

  private async resolve<T>(
    kind: string,
    assets: readonly string[],
    frame: AutomationCapturedFrame,
    request: MatchOptions,
    signal: AbortSignal,
    compute: () => Promise<T>,
    copy: (value: T) => T,
  ): Promise<T> {
    if (signal.aborted) throw new Error('automation cancelled');
    const probe = this.probe(frame, request.region);
    if (!probe) {
      this.misses += 1;
      return compute();
    }
    const key = observationKey({
      kind,
      assets,
      threshold: request.threshold,
      scales: request.scales,
      mask: request.mask,
      maxCandidates: request.maxCandidates,
      region: request.region,
      width: probe.size.width,
      height: probe.size.height,
    });
    const cached = this.cache.get<T>(key, probe.fingerprint, this.now());
    if (cached !== undefined) {
      this.hits += 1;
      return copy(cached);
    }
    this.misses += 1;
    const value = await compute();
    this.cache.set(key, probe.fingerprint, copy(value), this.now());
    return copy(value);
  }

  private probe(
    frame: AutomationCapturedFrame,
    region?: AutomationCapabilityRegion,
  ): { size: { width: number; height: number }; fingerprint: number } | undefined {
    const size = frame.bitmapSize ?? frame.deviceSize;
    if (!size || size.width <= 0 || size.height <= 0) return undefined;
    let bitmap: Uint8Array;
    try {
      bitmap = frame.bitmap ?? frame.image.toBitmap();
    } catch {
      return undefined;
    }
    if (!bitmap || bitmap.byteLength < size.width * size.height * 4) return undefined;
    const stride = adaptiveFingerprintStride(size.width, size.height);
    const deviceRegion = region ? this.toDeviceRegion(frame, region) : undefined;
    return {
      size,
      fingerprint: regionFingerprint(
        bitmap,
        size.width,
        size.height,
        deviceRegion ?? { x: 0, y: 0, width: size.width, height: size.height },
        stride,
      ),
    };
  }

  /** CSS 区域 → 位图像素区域；换算不可靠时返回 undefined，由调用方退回整帧。 */
  private toDeviceRegion(
    frame: AutomationCapturedFrame,
    region: AutomationCapabilityRegion,
  ): FingerprintRegion | undefined {
    const css = frame.cssSize;
    const device = frame.deviceSize;
    if (!css || !device || css.width <= 0 || css.height <= 0) return undefined;
    const scaleX = device.width / css.width;
    const scaleY = device.height / css.height;
    const x = Math.max(0, Math.floor(region.x * scaleX));
    const y = Math.max(0, Math.floor(region.y * scaleY));
    const right = Math.min(device.width, Math.ceil((region.x + region.width) * scaleX));
    const bottom = Math.min(device.height, Math.ceil((region.y + region.height) * scaleY));
    if (right <= x || bottom <= y) return undefined;
    return { x, y, width: right - x, height: bottom - y };
  }
}
