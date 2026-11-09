import { describe, expect, it } from 'vitest';
import { LearnedSearchRegions, expandSearchRegion } from '../src/main/modules/automation/learned-search-region';

describe('expandSearchRegion', () => {
  it('四周各留 "最大边长的一半" 的余量，且不少于 24 像素', () => {
    // max(60,40)/2 = 30
    expect(expandSearchRegion({ x: 100, y: 100, width: 60, height: 40 }, { width: 800, height: 600 }))
      .toEqual({ x: 70, y: 70, width: 120, height: 100 });
  });

  it('小目标的余量取下限 24 像素', () => {
    expect(expandSearchRegion({ x: 100, y: 100, width: 8, height: 8 }, { width: 800, height: 600 }))
      .toEqual({ x: 76, y: 76, width: 56, height: 56 });
  });

  it('贴边时被裁到视口内，不会越界', () => {
    expect(expandSearchRegion({ x: 2, y: 2, width: 20, height: 20 }, { width: 60, height: 60 }))
      .toEqual({ x: 0, y: 0, width: 46, height: 46 });
    expect(expandSearchRegion({ x: 40, y: 40, width: 20, height: 20 }, { width: 60, height: 60 }))
      .toEqual({ x: 16, y: 16, width: 44, height: 44 });
  });

  it('目标完全在视口外时返回 undefined', () => {
    expect(expandSearchRegion({ x: 900, y: 10, width: 20, height: 20 }, { width: 800, height: 600 }))
      .toBeUndefined();
  });

  it('非法输入抛错', () => {
    expect(() => expandSearchRegion({ x: 0, y: 0, width: 0, height: 10 }, { width: 80, height: 60 })).toThrow();
    expect(() => expandSearchRegion({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 60 })).toThrow();
  });
});

describe('LearnedSearchRegions', () => {
  const viewport = { width: 1280, height: 720 };

  it('没记过就没有区域', () => {
    const regions = new LearnedSearchRegions();
    expect(regions.regionFor('a', viewport)).toBeUndefined();
  });

  it('记住一次之后，下次给出扩张后的区域', () => {
    const regions = new LearnedSearchRegions();
    regions.remember('a', { x: 200, y: 160, width: 40, height: 30 }, viewport);
    expect(regions.regionFor('a', viewport)).toEqual({ x: 176, y: 136, width: 88, height: 78 });
  });

  it('再记一次会覆盖旧位置', () => {
    const regions = new LearnedSearchRegions();
    regions.remember('a', { x: 200, y: 160, width: 40, height: 30 }, viewport);
    regions.remember('a', { x: 600, y: 400, width: 40, height: 30 }, viewport);
    expect(regions.regionFor('a', viewport)).toEqual({ x: 576, y: 376, width: 88, height: 78 });
  });

  it('视口尺寸变了就作废（布局可能整体重排）', () => {
    const regions = new LearnedSearchRegions();
    regions.remember('a', { x: 200, y: 160, width: 40, height: 30 }, viewport);
    expect(regions.regionFor('a', { width: 1024, height: 576 })).toBeUndefined();
    expect(regions.regionFor('a', viewport)).toEqual({ x: 176, y: 136, width: 88, height: 78 });
  });

  it('视口有 1 像素级抖动仍然沿用', () => {
    const regions = new LearnedSearchRegions();
    regions.remember('a', { x: 200, y: 160, width: 40, height: 30 }, viewport);
    expect(regions.regionFor('a', { width: 1281, height: 720 })).toBeDefined();
  });

  it('forget 之后回到全画面搜索', () => {
    const regions = new LearnedSearchRegions();
    regions.remember('a', { x: 200, y: 160, width: 40, height: 30 }, viewport);
    regions.forget('a');
    expect(regions.regionFor('a', viewport)).toBeUndefined();
  });

  it('记录的位置在视口外时不给区域', () => {
    const regions = new LearnedSearchRegions();
    regions.remember('a', { x: 5000, y: 160, width: 40, height: 30 }, viewport);
    expect(regions.regionFor('a', viewport)).toBeUndefined();
  });

  it('条目数有上限，避免长跑脚本无限增长', () => {
    const regions = new LearnedSearchRegions({ maxEntries: 2 });
    regions.remember('a', { x: 10, y: 10, width: 10, height: 10 }, viewport);
    regions.remember('b', { x: 10, y: 10, width: 10, height: 10 }, viewport);
    regions.remember('c', { x: 10, y: 10, width: 10, height: 10 }, viewport);
    expect(regions.size).toBe(2);
  });
});
