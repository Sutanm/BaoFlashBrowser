import { describe, expect, it } from 'vitest';
import { ObservationCache, observationKey } from '../src/main/modules/automation/observation-cache';

describe('observation cache key', () => {
  it('键顺序不影响结果', () => {
    expect(observationKey({ asset: 'a.png', threshold: 0.9 }))
      .toBe(observationKey({ threshold: 0.9, asset: 'a.png' }));
  });

  it('嵌套对象递归排序，数组保持顺序', () => {
    expect(observationKey({ a: { y: 2, x: 1 }, b: [3, 1] }))
      .toBe(observationKey({ b: [3, 1], a: { x: 1, y: 2 } }));
    expect(observationKey({ a: [1, 2] })).not.toBe(observationKey({ a: [2, 1] }));
  });

  it('different 值得到不同键；undefined 字段被跳过', () => {
    expect(observationKey({ a: 1 })).not.toBe(observationKey({ a: 2 }));
    expect(observationKey({ a: 1, b: undefined })).toBe(observationKey({ a: 1 }));
  });
});

describe('observation cache', () => {
  it('同指纹命中，不同指纹未命中', () => {
    const cache = new ObservationCache();
    cache.set('k', 10, { hit: true }, 0);
    expect(cache.get('k', 10, 0)).toEqual({ hit: true });
    expect(cache.get('k', 11, 0)).toBeUndefined();
  });

  it('指纹变化会作废旧值', () => {
    const cache = new ObservationCache();
    cache.set('k', 10, 'old', 0);
    expect(cache.get('k', 11, 0)).toBeUndefined();
    expect(cache.get('k', 10, 0)).toBeUndefined();
  });

  it('超过 maxAgeMs 过期', () => {
    const cache = new ObservationCache({ maxAgeMs: 500 });
    cache.set('k', 1, 'v', 0);
    expect(cache.get('k', 1, 499)).toBe('v');
    expect(cache.get('k', 1, 501)).toBeUndefined();
  });

  it('超过 maxEntries 时淘汰最久未写入的条目', () => {
    const cache = new ObservationCache({ maxEntries: 2 });
    cache.set('a', 1, 'A', 0);
    cache.set('b', 1, 'B', 10);
    cache.set('c', 1, 'C', 20);
    expect(cache.size).toBe(2);
    expect(cache.get('a', 1, 20)).toBeUndefined();
    expect(cache.get('b', 1, 20)).toBe('B');
    expect(cache.get('c', 1, 20)).toBe('C');
  });

  it('clear 清空全部条目', () => {
    const cache = new ObservationCache();
    cache.set('a', 1, 'A', 0);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a', 1, 0)).toBeUndefined();
  });

  it('false 和 0 这类假值也能正确命中', () => {
    const cache = new ObservationCache();
    cache.set('f', 1, false, 0);
    cache.set('z', 1, 0, 0);
    expect(cache.get('f', 1, 0)).toBe(false);
    expect(cache.get('z', 1, 0)).toBe(0);
  });
});
