import { describe, expect, it } from 'vitest';
import { keyOutBgraBackground } from '../src/main/modules/automation/asset-keyout';

function bgraPixel(r: number, g: number, b: number, a: number): number[] {
  return [b, g, r, a];
}

/** 构造 BGRA 像素数组。 */
function makeBgra(width: number, height: number, fill: (x: number, y: number) => number[]): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = fill(x, y);
      const i = (y * width + x) * 4;
      out[i] = px[0]; out[i + 1] = px[1]; out[i + 2] = px[2]; out[i + 3] = px[3];
    }
  }
  return out;
}

/** 统计透明(alpha=0)像素占比。 */
function transparentShare(bgra: Uint8Array): number {
  let count = 0;
  for (let i = 3; i < bgra.length; i += 4) if (bgra[i] === 0) count += 1;
  return count / (bgra.length / 4);
}

/** 复刻 vision-worker 的 hasUsefulAlpha 判定。 */
function hasUsefulAlpha(bgra: Uint8Array): boolean {
  const pixelCount = bgra.length / 4;
  let transparent = 0;
  let alphaPixels = 0;
  for (let p = 0, i = 3; p < pixelCount; p += 1, i += 4) {
    if (bgra[i] < 250) transparent += 1;
    if (bgra[i] >= 224) alphaPixels += 1;
  }
  return transparent >= Math.max(1, Math.floor(pixelCount * 0.005))
    && alphaPixels > 0 && alphaPixels < pixelCount;
}

describe('keyOutBgraBackground', () => {
  it('strips a solid background and flips hasUsefulAlpha', () => {
    // 60x80: 天蓝色背景 + 中央深色"文字"块,模拟带背景截图的像素字素材。
    const width = 60, height = 80;
    const bgra = makeBgra(width, height, (x, y) => {
      const inCore = x >= 22 && x < 38 && y >= 30 && y < 50;
      return bgraPixel(inCore ? 20 : 31, inCore ? 20 : 170, inCore ? 20 : 229, 255);
    });
    expect(hasUsefulAlpha(bgra)).toBe(false);

    const { keyed, removedShare, output } = keyOutBgraBackground(bgra, width, height);
    expect(keyed).toBe(true);
    expect(removedShare).toBeGreaterThan(0.3);
    expect(hasUsefulAlpha(output)).toBe(true);
    // 中央前景仍保留
    const core = (30 * width + 22) * 4 + 3;
    expect(output[core]).toBe(255);
  });

  it('handles multi-color solid backgrounds', () => {
    // 模拟上钩:边框一半绿一半蓝,前景在中间。
    const width = 70, height = 90;
    const bgra = makeBgra(width, height, (x, y) => {
      if (x >= 25 && x < 45 && y >= 35 && y < 55) return bgraPixel(250, 250, 250, 255); // 前景白色块
      if (x < width / 2) return bgraPixel(0, 203, 134, 255); // 绿
      return bgraPixel(229, 170, 31, 255); // 蓝(注意 bgra 序)
    });
    const { keyed, output } = keyOutBgraBackground(bgra, width, height);
    expect(keyed).toBe(true);
    expect(transparentShare(output)).toBeGreaterThan(0.5);
  });

  it('leaves already-transparent sprites untouched', () => {
    const width = 30, height = 30;
    const bgra = makeBgra(width, height, (x, y) => {
      const inCore = x >= 10 && x < 20 && y >= 10 && y < 20;
      return bgraPixel(255, 0, 0, inCore ? 255 : 0);
    });
    const { keyed } = keyOutBgraBackground(bgra, width, height);
    expect(keyed).toBe(false);
  });

  it('leaves a gradient background untouched (untrusted border)', () => {
    const width = 50, height = 50;
    // 每列颜色不同,边框无主色
    const bgra = makeBgra(width, height, (x) => bgraPixel(0, Math.floor(x * 5), 200, 255));
    const { keyed } = keyOutBgraBackground(bgra, width, height);
    expect(keyed).toBe(false);
  });

  it('leaves a solid-color plain image untouched (foreground share too low)', () => {
    const width = 40, height = 40;
    const bgra = makeBgra(width, height, () => bgraPixel(80, 120, 200, 255));
    const { keyed } = keyOutBgraBackground(bgra, width, height);
    expect(keyed).toBe(false);
  });

  it('keeps foreground pixels colored after stripping', () => {
    const width = 40, height = 40;
    const bgra = makeBgra(width, height, (x, y) => {
      if (x >= 8 && x < 32 && y >= 8 && y < 32) return bgraPixel(200, 50, 100, 255);
      return bgraPixel(10, 200, 40, 255);
    });
    const { keyed, output } = keyOutBgraBackground(bgra, width, height);
    expect(keyed).toBe(true);
    // 前景中心像素保留原色(BGRA:[B=100,G=50,R=200])
    const center = (20 * width + 20) * 4;
    expect(output[center]).toBe(100);
    expect(output[center + 1]).toBe(50);
    expect(output[center + 2]).toBe(200);
    expect(output[center + 3]).toBe(255);
  });
});
