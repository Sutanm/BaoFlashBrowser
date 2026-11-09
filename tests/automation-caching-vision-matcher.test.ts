import { describe, expect, it } from 'vitest';
import type {
  AutomationCapturedFrame,
  AutomationVisionMatcher,
  ImageMatch,
} from '../src/main/modules/automation/capability-contracts';
import { CachingVisionMatcher } from '../src/main/modules/automation/caching-vision-matcher';

function frameOf(values: readonly number[], width = values.length): AutomationCapturedFrame {
  const bitmap = Buffer.alloc(width * 4);
  values.forEach((value, index) => {
    bitmap[index * 4] = value;
    bitmap[index * 4 + 1] = value;
    bitmap[index * 4 + 2] = value;
    bitmap[index * 4 + 3] = 255;
  });
  return {
    image: {
      isEmpty: () => false,
      getSize: () => ({ width, height: 1 }),
      toPNG: () => Buffer.alloc(0),
      toBitmap: () => bitmap,
    },
    bitmap,
    bitmapSize: { width, height: 1 },
    deviceSize: { width, height: 1 },
    cssSize: { width, height: 1 },
  };
}

const match = (x: number): ImageMatch => ({ x, y: 0, width: 4, height: 4, score: 0.95 });

class CountingMatcher implements AutomationVisionMatcher {
  calls: string[] = [];
  constructor(private readonly result: ImageMatch | null = match(1)) {}
  async find(asset: string): Promise<ImageMatch | null> {
    this.calls.push(asset);
    return this.result ? { ...this.result } : null;
  }
  async findMany(assets: string[]): Promise<ImageMatch | null> {
    this.calls.push(`many:${assets.join(',')}`);
    return this.result ? { ...this.result } : null;
  }
  async findCandidates(asset: string): Promise<readonly ImageMatch[]> {
    this.calls.push(`cand:${asset}`);
    return this.result ? [{ ...this.result }] : [];
  }
  async findManyCandidates(assets: string[]): Promise<readonly ImageMatch[]> {
    this.calls.push(`manycand:${assets.join(',')}`);
    return this.result ? [{ ...this.result }] : [];
  }
  getStats(): Partial<ImageMatch> {
    return { matchMs: 42 };
  }
}

const options = { threshold: 0.9, scales: [1], mask: 'auto' as const, region: undefined };
const signal = new AbortController().signal;

describe('caching vision matcher', () => {
  it('同一幅画面的同一查询只真正匹配一次', async () => {
    const inner = new CountingMatcher();
    const matcher = new CachingVisionMatcher(inner);
    const frame = frameOf([1, 2, 3, 4, 5]);
    const first = await matcher.find('a.png', frame, options, signal);
    const second = await matcher.find('a.png', frameOf([1, 2, 3, 4, 5]), options, signal);
    expect(inner.calls).toEqual(['a.png']);
    expect(second).toEqual(first);
    expect(matcher.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('画面一变就重新匹配', async () => {
    const inner = new CountingMatcher();
    const matcher = new CachingVisionMatcher(inner);
    await matcher.find('a.png', frameOf([1, 2, 3, 4]), options, signal);
    await matcher.find('a.png', frameOf([1, 2, 3, 9]), options, signal);
    expect(inner.calls).toHaveLength(2);
  });

  it('素材名、阈值、尺度、遮罩、区域任一不同都不复用', async () => {
    const inner = new CountingMatcher();
    const matcher = new CachingVisionMatcher(inner);
    const frame = frameOf([7, 7, 7, 7]);
    await matcher.find('a.png', frame, options, signal);
    await matcher.find('b.png', frame, options, signal);
    await matcher.find('a.png', frame, { ...options, threshold: 0.8 }, signal);
    await matcher.find('a.png', frame, { ...options, scales: [0.75, 1] }, signal);
    await matcher.find('a.png', frame, { ...options, mask: 'none' }, signal);
    await matcher.find('a.png', frame, { ...options, region: { x: 0, y: 0, width: 2, height: 1 } }, signal);
    expect(inner.calls).toHaveLength(6);
  });

  it('不同查询方法各自独立缓存', async () => {
    const inner = new CountingMatcher();
    const matcher = new CachingVisionMatcher(inner);
    const frame = frameOf([3, 3, 3, 3]);
    await matcher.find('a.png', frame, options, signal);
    await matcher.findCandidates?.('a.png', frame, options, signal);
    await matcher.findMany?.(['a.png'], frame, options, signal);
    await matcher.findManyCandidates?.(['a.png'], frame, options, signal);
    await matcher.find('a.png', frame, options, signal);
    expect(inner.calls).toEqual(['a.png', 'cand:a.png', 'many:a.png', 'manycand:a.png']);
  });

  it('返回的数组是副本，改它不会污染缓存', async () => {
    const inner = new CountingMatcher();
    const matcher = new CachingVisionMatcher(inner);
    const frame = frameOf([5, 5, 5]);
    const first = await matcher.findCandidates!('a.png', frame, options, signal);
    (first as ImageMatch[])[0].x = 999;
    const second = await matcher.findCandidates!('a.png', frame, options, signal);
    expect(second[0].x).toBe(1);
  });

  it('已中止的信号直接抛错，且不读缓存', async () => {
    const inner = new CountingMatcher();
    const matcher = new CachingVisionMatcher(inner);
    const frame = frameOf([2, 2, 2]);
    await matcher.find('a.png', frame, options, signal);
    const aborted = AbortSignal.abort();
    await expect(matcher.find('a.png', frame, options, aborted)).rejects.toThrow();
    expect(inner.calls).toHaveLength(1);
  });

  it('内层没有的可选方法不会凭空出现', () => {
    const minimal: AutomationVisionMatcher = {
      async find(): Promise<ImageMatch | null> { return null; },
    };
    const matcher = new CachingVisionMatcher(minimal);
    expect(matcher.findCandidates).toBeUndefined();
    expect(matcher.findManyCandidates).toBeUndefined();
    expect(matcher.findMany).toBeUndefined();
    expect(matcher.getStats).toBeUndefined();
  });

  it('getStats 原样透传内层的统计', () => {
    const matcher = new CachingVisionMatcher(new CountingMatcher());
    expect(matcher.getStats?.()).toEqual({ matchMs: 42 });
  });

  it('没有 bitmap 时退回 image.toBitmap 计算指纹', async () => {
    const inner = new CountingMatcher();
    const matcher = new CachingVisionMatcher(inner);
    const frame = { ...frameOf([1, 1, 1]), bitmap: undefined };
    await matcher.find('a.png', frame, options, signal);
    await matcher.find('a.png', frame, options, signal);
    expect(inner.calls).toHaveLength(1);
  });

  it('未命中与空结果同样缓存（负结果也是结论）', async () => {
    const inner = new CountingMatcher(null);
    const matcher = new CachingVisionMatcher(inner);
    const frame = frameOf([4, 4, 4]);
    expect(await matcher.find('a.png', frame, options, signal)).toBeNull();
    expect(await matcher.find('a.png', frame, options, signal)).toBeNull();
    expect(inner.calls).toHaveLength(1);
  });
});
