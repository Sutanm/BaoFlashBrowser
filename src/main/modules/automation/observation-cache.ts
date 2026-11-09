/**
 * 观察缓存：同一幅画面上的同一个查询，只算一次。
 *
 * 自动化的等待循环里，"抓帧 → 匹配 → 没命中 → 等一会儿 → 再抓帧 → 再匹配" 是常态。
 * 画面没变时第二次匹配的结果必然和第一次相同，但现在的实现会从头再算一遍。
 *
 * 这个缓存把 (帧指纹, 查询签名) 映射到结果：
 *   key   = observationKey({ 算法, 素材, 阈值, 尺度, 区域 … })   ← 必须是"结果的完整输入"
 *   value = 上一次在**同一幅画面**上算出来的结果
 *
 * 命中条件：指纹相同（同一幅画面）且未超过 maxAgeMs。
 * 任何一项输入变化都必须换 key，否则会静默给出错误答案。
 */

export type ObservationCacheOptions = {
  /** 超过这个年龄的观察不再可信（毫秒）。默认 500：容忍极短的动画空档。 */
  readonly maxAgeMs?: number;
  /** 最多保留多少条。默认 128：一个步骤通常只有几条不同查询。 */
  readonly maxEntries?: number;
};

/**
 * 统一开关：`BAO_AUTOMATION_OBSERVATION_CACHE=1` 时启用所有"同一幅画面只算一次"的缓存。
 * 默认关闭，便于新旧路径 A/B；验证一周后把默认翻成开启。
 */
export const OBSERVATION_CACHE_ENV = 'BAO_AUTOMATION_OBSERVATION_CACHE';

export function isObservationCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OBSERVATION_CACHE_ENV] === '1';
}

type Entry = {
  readonly fingerprint: number;
  readonly at: number;
  readonly value: unknown;
};

/** 递归排序对象键，用于生成稳定、可比较的查询签名。 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    result[key] = canonicalize(entry);
  }
  return result;
}

/**
 * 由查询参数生成缓存键。
 * 键顺序无关、嵌套对象递归排序、undefined 字段被忽略；数组顺序有意义。
 */
export function observationKey(parts: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(canonicalize(parts));
}

export class ObservationCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;

  constructor(options: ObservationCacheOptions = {}) {
    const maxAgeMs = options.maxAgeMs ?? 500;
    const maxEntries = options.maxEntries ?? 128;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new Error('observation cache maxAgeMs must be a non-negative number');
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('observation cache maxEntries must be a positive integer');
    }
    this.maxAgeMs = maxAgeMs;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  get<T>(key: string, fingerprint: number, now: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.fingerprint !== fingerprint) {
      this.entries.delete(key);
      return undefined;
    }
    if (now - entry.at > this.maxAgeMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set(key: string, fingerprint: number, value: unknown, now: number): void {
    this.entries.set(key, { fingerprint, at: now, value });
    while (this.entries.size > this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [candidate, entry] of this.entries) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = candidate;
        }
      }
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
