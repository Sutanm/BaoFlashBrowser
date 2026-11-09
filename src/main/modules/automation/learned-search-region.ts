/**
 * 学习式搜索区域：把"上次在哪儿命中"变成下一次的搜索框。
 *
 * 为什么需要：模板匹配的成本与**搜索面积**成正比，而且是"每个请求一次、按面积计"的大块开销
 * （实测 1080p 整帧 ≈ 58 ms，整帧 7 档尺度 ≈ 58 ms —— 尺度数几乎不花钱，面积才花钱）。
 * 所以唯一有效的杠杆是**别每次都搜整屏**。
 *
 * 做法：
 * - 第一次命中后，把命中框扩张约 2 倍记下来；
 * - 下一次同一个查询直接用这个框当搜索区域，面积通常降到 1/4 以下；
 * - 框内搜不到就**作废并回退整屏**（调用方负责），所以位移/滚动不会变成假阴性；
 * - 视口尺寸变化超过 1 像素就整体作废——布局变了，旧位置不可信。
 *
 * 坐标一律是 **CSS/逻辑像素**（与 `AutomationVisionMatcher` 的 `region` 同空间）。
 */

export type SearchRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type ViewportSize = {
  readonly width: number;
  readonly height: number;
};

export type ExpandOptions = {
  /** 单边最小余量（CSS 像素）。默认 24。 */
  readonly minMargin?: number;
  /** 单边余量相对目标长边的比例。默认 0.5（即总尺寸约 2 倍）。 */
  readonly marginRatio?: number;
};

export type LearnedSearchRegionOptions = {
  /** 最多记住多少个查询。默认 64。 */
  readonly maxEntries?: number;
  /** 视口尺寸容差（像素）。默认 1。 */
  readonly viewportTolerance?: number;
};

type Entry = {
  readonly rect: SearchRect;
  readonly viewport: ViewportSize;
};

/**
 * 开关：`BAO_AUTOMATION_SEARCH_REGION=1` 时启用"上次命中位置"收窄搜索区域。
 * 默认关闭，便于 A/B；它只影响匹配区域，不改抓帧、不改坐标。
 */
export const SEARCH_REGION_ENV = 'BAO_AUTOMATION_SEARCH_REGION';

export function isLearnedSearchRegionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SEARCH_REGION_ENV] === '1';
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
}

/**
 * 把一次命中框扩成搜索框，并裁到视口内。目标完全在视口外时返回 undefined。
 */
export function expandSearchRegion(
  rect: SearchRect,
  viewport: ViewportSize,
  options: ExpandOptions = {},
): SearchRect | undefined {
  for (const [name, value] of [['width', rect.width], ['height', rect.height]] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`search rect ${name} must be positive`);
  }
  assertPositive(viewport.width, 'viewport width');
  assertPositive(viewport.height, 'viewport height');
  const minMargin = options.minMargin ?? 24;
  const marginRatio = options.marginRatio ?? 0.5;
  if (!Number.isFinite(minMargin) || minMargin < 0) throw new Error('minMargin must be non-negative');
  if (!Number.isFinite(marginRatio) || marginRatio < 0) throw new Error('marginRatio must be non-negative');

  const margin = Math.max(minMargin, Math.ceil(Math.max(rect.width, rect.height) * marginRatio));
  const left = Math.max(0, Math.floor(rect.x - margin));
  const top = Math.max(0, Math.floor(rect.y - margin));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width + margin));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height + margin));
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export class LearnedSearchRegions {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly viewportTolerance: number;

  constructor(options: LearnedSearchRegionOptions = {}) {
    const maxEntries = options.maxEntries ?? 64;
    const viewportTolerance = options.viewportTolerance ?? 1;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('learned search regions maxEntries must be a positive integer');
    }
    if (!Number.isFinite(viewportTolerance) || viewportTolerance < 0) {
      throw new Error('learned search regions viewportTolerance must be non-negative');
    }
    this.maxEntries = maxEntries;
    this.viewportTolerance = viewportTolerance;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 记下这次命中；后续查询会被收窄到这个框。 */
  remember(key: string, rect: SearchRect, viewport: ViewportSize): void {
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return;
    if (!Number.isFinite(rect.width) || rect.width <= 0 || !Number.isFinite(rect.height) || rect.height <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { rect: { ...rect }, viewport: { ...viewport } });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /**
   * 取这个查询的收窄搜索框。视口变了、位置跑出视口、或从没记过时返回 undefined（调用方退回全屏）。
   */
  regionFor(key: string, viewport: ViewportSize): SearchRect | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Math.abs(entry.viewport.width - viewport.width) > this.viewportTolerance
      || Math.abs(entry.viewport.height - viewport.height) > this.viewportTolerance) {
      return undefined;
    }
    return expandSearchRegion(entry.rect, viewport);
  }

  forget(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
