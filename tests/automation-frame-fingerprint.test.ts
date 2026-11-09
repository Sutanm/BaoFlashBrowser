import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FINGERPRINT_STRIDE,
  adaptiveFingerprintStride,
  frameFingerprint,
  regionFingerprint,
} from '../src/main/modules/automation/frame-fingerprint';

type Rgba = readonly [number, number, number, number];

/** 造一张 w×h 的 BGRA 位图；pixel(x, y) 返回 BGRA 四通道。 */
function bitmapOf(w: number, h: number, pixel: (x: number, y: number) => Rgba): Uint8Array {
  const bytes = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const offset = (y * w + x) * 4;
      const [b, g, r, a] = pixel(x, y);
      bytes[offset] = b;
      bytes[offset + 1] = g;
      bytes[offset + 2] = r;
      bytes[offset + 3] = a;
    }
  }
  return bytes;
}

const solid = (b: number, g: number, r: number): ((x: number, y: number) => Rgba) => () => [b, g, r, 255];

describe('frame fingerprint', () => {
  it('同一区域的相同像素得到相同指纹', () => {
    const bitmap = bitmapOf(16, 16, solid(10, 20, 30));
    const region = { x: 2, y: 3, width: 8, height: 6 };
    expect(regionFingerprint(bitmap, 16, 16, region)).toBe(regionFingerprint(bitmap, 16, 16, region));
  });

  it('区域内任意采样点变化都会改变指纹', () => {
    const base = bitmapOf(16, 16, solid(10, 20, 30));
    const region = { x: 0, y: 0, width: 16, height: 16 };
    const changed = base.slice();
    // stride 4 意味着 (0,0)、(4,0)、(0,4)… 都会被采样，(0,0) 必然在内
    changed[0] = 11;
    expect(regionFingerprint(changed, 16, 16, region)).not.toBe(regionFingerprint(base, 16, 16, region));
  });

  it('区域之外的变化不影响指纹', () => {
    const region = { x: 4, y: 4, width: 8, height: 8 };
    const base = bitmapOf(32, 32, solid(10, 20, 30));
    const changed = base.slice();
    // (0,0) 在区域外
    changed[0] = 200;
    changed[1] = 200;
    changed[2] = 200;
    expect(regionFingerprint(changed, 32, 32, region)).toBe(regionFingerprint(base, 32, 32, region));
  });

  it('alpha 通道不参与指纹（避免半透明抖动打穿缓存）', () => {
    const region = { x: 0, y: 0, width: 8, height: 8 };
    const base = bitmapOf(8, 8, solid(10, 20, 30));
    const changedAlpha = base.slice();
    for (let offset = 3; offset < changedAlpha.length; offset += 4) changedAlpha[offset] = 128;
    expect(regionFingerprint(changedAlpha, 8, 8, region)).toBe(regionFingerprint(base, 8, 8, region));
  });

  it('默认 stride 是 4，且显式 stride=1 更敏感', () => {
    expect(DEFAULT_FINGERPRINT_STRIDE).toBe(4);
    const region = { x: 0, y: 0, width: 8, height: 8 };
    const base = bitmapOf(8, 8, solid(0, 0, 0));
    const changed = base.slice();
    // (1,0) 在 stride=4 下不被采样，在 stride=1 下会
    changed[4] = 9;
    expect(regionFingerprint(changed, 8, 8, region)).toBe(regionFingerprint(base, 8, 8, region));
    expect(regionFingerprint(changed, 8, 8, region, 1)).not.toBe(regionFingerprint(base, 8, 8, region, 1));
  });

  it('整帧指纹覆盖全部像素', () => {
    const base = bitmapOf(8, 8, solid(0, 0, 0));
    const changed = base.slice();
    changed[((7 * 8) + 7) * 4] = 5; // 右下角
    expect(frameFingerprint(changed, 8, 8, 1)).not.toBe(frameFingerprint(base, 8, 8, 1));
  });

  it('越界或非法区域直接抛错，不静默截断', () => {
    const bitmap = bitmapOf(8, 8, solid(1, 2, 3));
    expect(() => regionFingerprint(bitmap, 8, 8, { x: 4, y: 0, width: 8, height: 8 })).toThrow();
    expect(() => regionFingerprint(bitmap, 8, 8, { x: 0, y: 0, width: 0, height: 4 })).toThrow();
    expect(() => regionFingerprint(bitmap, 8, 8, { x: 0, y: 0, width: 4, height: 4 }, 0)).toThrow();
    expect(() => regionFingerprint(new Uint8Array(3), 8, 8, { x: 0, y: 0, width: 1, height: 1 })).toThrow();
  });

  it('结果始终是 32 位无符号数', () => {
    const value = frameFingerprint(bitmapOf(4, 4, solid(255, 255, 255)), 4, 4);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffffffff);
  });

  describe('自适应采样步长', () => {
    it('大画面退到最大步长，小区域退到 1', () => {
      expect(adaptiveFingerprintStride(1280, 720)).toBe(4);
      expect(adaptiveFingerprintStride(1920, 1080)).toBe(4);
      expect(adaptiveFingerprintStride(4, 1)).toBe(1);
      expect(adaptiveFingerprintStride(64, 20)).toBe(1);
    });

    it('小区域用自适应步长后仍然能分辨逐像素差异', () => {
      const region = { x: 0, y: 0, width: 4, height: 1 };
      const base = bitmapOf(4, 1, solid(1, 2, 3));
      const changed = base.slice();
      changed[3 * 4] = 99; // 最后一个像素
      const stride = adaptiveFingerprintStride(4, 1);
      expect(regionFingerprint(changed, 4, 1, region, stride))
        .not.toBe(regionFingerprint(base, 4, 1, region, stride));
    });

    it('非法尺寸抛错', () => {
      expect(() => adaptiveFingerprintStride(0, 10)).toThrow();
    });
  });
});
